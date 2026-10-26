import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeTenantAdmin, API, bearer, bootApp, closeApp, createPlan, createPlatformUser, createTenant, Ctx, NEW_ADMIN_PASSWORD, platformLogin,
  refreshCookie, superAdmin, tenantLogin, uid,
} from './helpers';

describe('auth', () => {
  let c: Ctx;
  let owner: string;
  let planId: string;

  beforeAll(async () => {
    c = await bootApp();
    owner = (await superAdmin(c)).token;
    planId = (await createPlan(c, owner, { limits: { max_users: 10 } })).id;
  });
  afterAll(async () => closeApp(c));

  describe('tenant login', () => {
    it('succeeds with right credentials and sets the refresh cookie as the contract says', async () => {
      const t = await createTenant(c, owner, planId);
      const res = await c.http.post(`${API}/auth/login`).send({ tenantCode: t.code.toUpperCase(), email: t.adminEmail.toUpperCase(), password: t.temporaryPassword });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTypeOf('string');
      expect(res.body.expiresIn).toBe(900);
      expect(res.body.principal).toMatchObject({ kind: 'tenant', tenantId: t.tenantId, tenantCode: t.code, isTenantAdmin: true });
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find(x => x.startsWith('rt='))!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      const expires = Date.parse(/Expires=([^;]+)/.exec(cookie)![1]!);
      expect(Math.round((expires - Date.now()) / 86_400_000)).toBe(30);
      const logs = await c.db.selectFrom('app.audit_log').select('action').where('tenant_id', '=', t.tenantId).where('action', '=', 'login').execute();
      expect(logs.length).toBe(1);
    });

    it('gives the same error for wrong password, unknown email and unknown tenant', async () => {
      const t = await createTenant(c, owner, planId);
      const bad = [
        { tenantCode: t.code, email: t.adminEmail, password: 'wrong-Password1' },
        { tenantCode: t.code, email: 'nobody@example.test', password: t.temporaryPassword },
        { tenantCode: `zz-${uid()}`, email: t.adminEmail, password: t.temporaryPassword },
      ];
      for (const body of bad) {
        const res = await c.http.post(`${API}/auth/login`).send(body);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('AUTH.INVALID_CREDENTIALS');
        expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      }
      const failed = await c.db.selectFrom('app.audit_log').select('action').where('tenant_id', '=', t.tenantId).where('action', '=', 'login_failed').execute();
      expect(failed.length).toBe(1);
    });

    it('locks after max_failed_logins (tenant setting), reports lockedUntil, and unlocks via admin', async () => {
      const t = await createTenant(c, owner, planId);
      await c.db.insertInto('app.tenant_setting').values({ tenant_id: t.tenantId, key: 'security.max_failed_logins', value: JSON.stringify(3) }).execute();
      for (let i = 0; i < 2; i++) {
        const r = await c.http.post(`${API}/auth/login`).send({ tenantCode: t.code, email: t.adminEmail, password: 'Wrong-pass-1' });
        expect(r.body.code).toBe('AUTH.INVALID_CREDENTIALS');
      }
      const third = await c.http.post(`${API}/auth/login`).send({ tenantCode: t.code, email: t.adminEmail, password: 'Wrong-pass-1' });
      expect(third.status).toBe(423);
      expect(third.body.code).toBe('AUTH.ACCOUNT_LOCKED');
      expect(Date.parse(third.body.meta.lockedUntil)).toBeGreaterThan(Date.now() + 14 * 60_000);
      // Right password while locked is still refused.
      const locked = await c.http.post(`${API}/auth/login`).send({ tenantCode: t.code, email: t.adminEmail, password: t.temporaryPassword });
      expect(locked.body.code).toBe('AUTH.ACCOUNT_LOCKED');
      const actions = (await c.db.selectFrom('app.audit_log').select('action').where('tenant_id', '=', t.tenantId).execute()).map(r => r.action);
      expect(actions).toContain('locked');

      // Second admin unlocks the first one.
      const admin2Email = `second@${t.code}.test`;
      const { hashPassword } = await import('../src/modules/identity/passwords');
      await c.db.insertInto('app.tenant_user').values({
        tenant_id: t.tenantId, email: admin2Email, name: 'Second Admin', password_hash: await hashPassword('Second@12345'),
        is_tenant_admin: true, must_change_password: false,
      }).execute();
      const a2 = await tenantLogin(c, t.code, admin2Email, 'Second@12345');
      const lockedUser = await c.db.selectFrom('app.tenant_user').select('id').where('email', '=', t.adminEmail).where('tenant_id', '=', t.tenantId).executeTakeFirstOrThrow();
      const got = await c.http.get(`${API}/users/${lockedUser.id}`).set(bearer(a2.token));
      expect(got.body.lockedUntil).not.toBeNull();
      const un = await c.http.post(`${API}/users/${lockedUser.id}/unlock`).set(bearer(a2.token));
      expect(un.status).toBe(200);
      expect(un.body.lockedUntil).toBeNull();
      const ok = await c.http.post(`${API}/auth/login`).send({ tenantCode: t.code, email: t.adminEmail, password: t.temporaryPassword });
      expect(ok.status).toBe(200);
    });

    it('starts a fresh count once a lock has expired', async () => {
      const t = await createTenant(c, owner, planId);
      await c.db.updateTable('app.tenant_user').set({ locked_until: new Date(Date.now() - 1000), failed_logins: 0 })
        .where('tenant_id', '=', t.tenantId).execute();
      const r = await c.http.post(`${API}/auth/login`).send({ tenantCode: t.code, email: t.adminEmail, password: 'Wrong-pass-1' });
      expect(r.body.code).toBe('AUTH.INVALID_CREDENTIALS');
      const u = await c.db.selectFrom('app.tenant_user').select(['failed_logins', 'locked_until']).where('tenant_id', '=', t.tenantId).executeTakeFirstOrThrow();
      expect(u.failed_logins).toBe(1);
      expect(u.locked_until).toBeNull();
    });
  });

  describe('platform login', () => {
    it('succeeds, and locks after 5 failures', async () => {
      const u = await createPlatformUser(c, 'support', 'Support@12345');
      const ok = await platformLogin(c, u.email, u.password);
      expect(ok.result.principal).toMatchObject({ kind: 'platform', role: 'support' });
      for (let i = 0; i < 4; i++) {
        const r = await c.http.post(`${API}/auth/platform/login`).send({ email: u.email, password: 'nope' });
        expect(r.body.code).toBe('AUTH.INVALID_CREDENTIALS');
      }
      const fifth = await c.http.post(`${API}/auth/platform/login`).send({ email: u.email, password: 'nope' });
      expect(fifth.body.code).toBe('AUTH.ACCOUNT_LOCKED');
      const unknown = await c.http.post(`${API}/auth/platform/login`).send({ email: `x-${uid()}@procure.test`, password: 'nope' });
      expect(unknown.body.code).toBe('AUTH.INVALID_CREDENTIALS');
    });
  });

  describe('forced password change', () => {
    it('blocks other routes until the password is changed, then clears and revokes other sessions', async () => {
      const t = await createTenant(c, owner, planId);
      const first = await tenantLogin(c, t.code, t.adminEmail, t.temporaryPassword);
      const other = await tenantLogin(c, t.code, t.adminEmail, t.temporaryPassword);
      expect(first.result.mustChangePassword).toBe(true);

      const blocked = await c.http.get(`${API}/users`).set(bearer(first.token));
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('AUTH.PASSWORD_CHANGE_REQUIRED');
      const me = await c.http.get(`${API}/auth/me`).set(bearer(first.token));
      expect(me.status).toBe(200);
      expect(me.body.mustChangePassword).toBe(true);

      const weak = await c.http.post(`${API}/auth/password/change`).set(bearer(first.token)).send({ currentPassword: t.temporaryPassword, newPassword: 'short' });
      expect(weak.status).toBe(400);
      expect(weak.body.code).toBe('VALIDATION_FAILED');
      const wrongCurrent = await c.http.post(`${API}/auth/password/change`).set(bearer(first.token)).send({ currentPassword: 'Wrong-pass-1', newPassword: NEW_ADMIN_PASSWORD });
      expect(wrongCurrent.status).toBe(400);

      const changed = await c.http.post(`${API}/auth/password/change`).set(bearer(first.token)).send({ currentPassword: t.temporaryPassword, newPassword: NEW_ADMIN_PASSWORD });
      expect(changed.status).toBe(200);
      expect(changed.body.mustChangePassword).toBe(false);
      const users = await c.http.get(`${API}/users`).set(bearer(changed.body.accessToken));
      expect(users.status).toBe(200);
      const me2 = await c.http.get(`${API}/auth/me`).set(bearer(changed.body.accessToken));
      expect(me2.body.mustChangePassword).toBe(false);

      // The other session is gone (access + refresh); the current one keeps working via refresh.
      expect((await c.http.get(`${API}/auth/me`).set(bearer(other.token))).status).toBe(401);
      expect((await c.http.post(`${API}/auth/refresh`).set('Cookie', other.cookie)).status).toBe(401);
      expect((await c.http.post(`${API}/auth/refresh`).set('Cookie', first.cookie)).status).toBe(200);

      const audit = await c.db.selectFrom('app.audit_log').select('action').where('tenant_id', '=', t.tenantId).where('action', '=', 'password_changed').execute();
      expect(audit.length).toBe(1);
    });
  });

  describe('refresh', () => {
    it('rotates the refresh token; reusing an old one revokes the whole family', async () => {
      const t = await createTenant(c, owner, planId);
      await activeTenantAdmin(c, t);
      const login = await tenantLogin(c, t.code, t.adminEmail, NEW_ADMIN_PASSWORD);

      const r1 = await c.http.post(`${API}/auth/refresh`).set('Cookie', login.cookie);
      expect(r1.status).toBe(200);
      expect(r1.body.principal.userId).toBe(login.userId);
      const cookie2 = refreshCookie(r1);
      expect(cookie2).not.toBe(login.cookie);

      const r2 = await c.http.post(`${API}/auth/refresh`).set('Cookie', cookie2);
      expect(r2.status).toBe(200);
      const cookie3 = refreshCookie(r2);

      // Reuse of the first (already rotated) token.
      const reuse = await c.http.post(`${API}/auth/refresh`).set('Cookie', login.cookie);
      expect(reuse.status).toBe(401);
      expect(reuse.body.code).toBe('AUTH.REFRESH_REUSED');

      // The latest token of the family no longer works, nor does its access token.
      expect((await c.http.post(`${API}/auth/refresh`).set('Cookie', cookie3)).status).toBe(401);
      expect((await c.http.get(`${API}/auth/me`).set(bearer(r2.body.accessToken))).status).toBe(401);
      expect((await c.http.get(`${API}/auth/me`).set(bearer(login.token))).status).toBe(401);
    });

    it('rejects a missing or unknown refresh cookie', async () => {
      expect((await c.http.post(`${API}/auth/refresh`)).status).toBe(401);
      expect((await c.http.post(`${API}/auth/refresh`).set('Cookie', 'rt=bogus')).body.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('logout and sessions', () => {
    it('logout revokes the access token immediately and the refresh token', async () => {
      const t = await createTenant(c, owner, planId);
      const a = await activeTenantAdmin(c, t);
      expect((await c.http.get(`${API}/auth/me`).set(bearer(a.token))).status).toBe(200);
      const out = await c.http.post(`${API}/auth/logout`).set(bearer(a.token));
      expect(out.status).toBe(204);
      expect((await c.http.get(`${API}/auth/me`).set(bearer(a.token))).status).toBe(401);
      expect((await c.http.post(`${API}/auth/refresh`).set('Cookie', a.cookie)).status).toBe(401);
      const audit = await c.db.selectFrom('app.audit_log').select('action').where('tenant_id', '=', t.tenantId).where('action', '=', 'logout').execute();
      expect(audit.length).toBe(1);
    });

    it('lists own sessions and revokes one of them', async () => {
      const t = await createTenant(c, owner, planId);
      await activeTenantAdmin(c, t);
      const s1 = await tenantLogin(c, t.code, t.adminEmail, NEW_ADMIN_PASSWORD);
      await tenantLogin(c, t.code, t.adminEmail, NEW_ADMIN_PASSWORD);
      const list = await c.http.get(`${API}/auth/sessions`).set(bearer(s1.token));
      expect(list.status).toBe(200);
      expect(list.body.length).toBeGreaterThanOrEqual(2);
      expect(list.body.filter((s: { current: boolean }) => s.current).length).toBe(1);
      const target = list.body.find((s: { current: boolean }) => !s.current);
      const del = await c.http.delete(`${API}/auth/sessions/${target.id}`).set(bearer(s1.token));
      expect(del.status).toBe(204);
      expect((await c.http.get(`${API}/auth/sessions`).set(bearer(s1.token))).body.find((s: { id: string }) => s.id === target.id)).toBeUndefined();
      expect((await c.http.get(`${API}/auth/me`).set(bearer(s1.token))).status).toBe(200);
      // Someone else's session id → 404.
      const other = await superAdmin(c);
      const otherSessions = await c.http.get(`${API}/auth/sessions`).set(bearer(other.token));
      const nf = await c.http.delete(`${API}/auth/sessions/${otherSessions.body[0].id}`).set(bearer(s1.token));
      expect(nf.status).toBe(404);
    });
  });
});

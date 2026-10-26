import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API, bearer, bootApp, closeApp, createUser, Ctx, superAdmin, tenantLogin, tenantWithAdmin,
} from './helpers';

describe('tenant identity: users, roles, notifications, limits', () => {
  let c: Ctx;
  let owner: string;

  beforeAll(async () => {
    c = await bootApp();
    owner = (await superAdmin(c)).token;
  });
  afterAll(async () => closeApp(c));

  it('rejects the 11th active user on a 10-user plan with LIMIT_EXCEEDED.max_users and notifies admins at 80% and 100% once', async () => {
    const { admin } = await tenantWithAdmin(c, owner, { limits: { max_users: 10 } });
    // Admin is user #1. Create 9 more → 10/10.
    for (let i = 0; i < 9; i++) {
      const r = await createUser(c, admin.token);
      expect(r.status).toBe(201);
      expect(r.body.temporaryPassword).toHaveLength(16);
    }
    const eleventh = await createUser(c, admin.token);
    expect(eleventh.status).toBe(403);
    expect(eleventh.body.code).toBe('LIMIT_EXCEEDED.max_users');
    expect(eleventh.body.meta).toEqual({ limitKey: 'max_users', limit: 10, used: 10 });
    expect(eleventh.body.title).toContain('10 active users');

    const notes = await c.http.get(`${API}/notifications`).set(bearer(admin.token));
    const warnings = notes.body.data.filter((n: { kind: string }) => n.kind === 'limit_warning');
    expect(warnings.map((n: { data: { threshold: number } }) => n.data.threshold).sort()).toEqual([100, 80]);

    // Deactivate one and add one again: 9 → 10 crosses 100% again only after dropping below; 80% not re-crossed.
    const list = await c.http.get(`${API}/users`).query({ active: 'true', limit: 200 }).set(bearer(admin.token));
    const victim = list.body.data.find((u: { id: string }) => u.id !== admin.userId);
    expect((await c.http.post(`${API}/users/${victim.id}/deactivate`).set(bearer(admin.token))).body.isActive).toBe(false);
    expect((await createUser(c, admin.token)).status).toBe(201);
    const notes2 = await c.http.get(`${API}/notifications`).query({ unread: 'true' }).set(bearer(admin.token));
    const w2 = notes2.body.data.filter((n: { kind: string }) => n.kind === 'limit_warning');
    expect(w2.filter((n: { data: { threshold: number } }) => n.data.threshold === 80)).toHaveLength(1);
    // Activating the deactivated user is also counted.
    const act = await c.http.post(`${API}/users/${victim.id}/activate`).set(bearer(admin.token));
    expect(act.status).toBe(403);
    expect(act.body.code).toBe('LIMIT_EXCEEDED.max_users');

    // Mark read.
    const first = w2[0];
    expect((await c.http.post(`${API}/notifications/${first.id}/read`).set(bearer(admin.token))).status).toBe(204);
    const unread = await c.http.get(`${API}/notifications`).query({ unread: 'true' }).set(bearer(admin.token));
    expect(unread.body.data.find((n: { id: string }) => n.id === first.id)).toBeUndefined();
  });

  it('20 parallel creations with 3 slots left → exactly 3 succeed', async () => {
    const { tenant, admin } = await tenantWithAdmin(c, owner, { limits: { max_users: 5 } });
    expect((await createUser(c, admin.token)).status).toBe(201); // 2/5 → 3 slots left
    const results = await Promise.all(Array.from({ length: 20 }, () => createUser(c, admin.token)));
    const codes = results.map(r => r.status);
    expect(codes.filter(s => s === 201)).toHaveLength(3);
    expect(codes.filter(s => s === 403)).toHaveLength(17);
    expect(results.filter(r => r.status === 403).every(r => r.body.code === 'LIMIT_EXCEEDED.max_users')).toBe(true);
    const n = await c.db.selectFrom('app.tenant_user').select(eb => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenant.tenantId).where('is_active', '=', true).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(5);
  });

  it('unlimited (null) max_users never blocks', async () => {
    const { admin } = await tenantWithAdmin(c, owner, { limits: { max_users: null } });
    for (let i = 0; i < 3; i++) expect((await createUser(c, admin.token)).status).toBe(201);
  });

  it('new user signs in with temp password, must change it; non-admin cannot reach admin routes', async () => {
    const { tenant, admin } = await tenantWithAdmin(c, owner);
    const created = await createUser(c, admin.token, { name: 'Plain User' });
    const u = await tenantLogin(c, tenant.code, created.body.user.email, created.body.temporaryPassword);
    expect(u.result.mustChangePassword).toBe(true);
    const changed = await c.http.post(`${API}/auth/password/change`).set(bearer(u.token))
      .send({ currentPassword: created.body.temporaryPassword, newPassword: 'Plain@123456' });
    expect(changed.status).toBe(200);
    const res = await c.http.get(`${API}/users`).set(bearer(changed.body.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    // Non-admin can still read own notifications.
    expect((await c.http.get(`${API}/notifications`).set(bearer(changed.body.accessToken))).status).toBe(200);
  });

  it('tenant user cannot call /platform/* and platform user cannot call /users', async () => {
    const { admin } = await tenantWithAdmin(c, owner);
    const r1 = await c.http.get(`${API}/platform/tenants`).set(bearer(admin.token));
    expect(r1.status).toBe(403);
    const r2 = await c.http.get(`${API}/users`).set(bearer(owner));
    expect(r2.status).toBe(403);
    const r3 = await c.http.get(`${API}/tenant/usage`).set(bearer(owner));
    expect(r3.status).toBe(403);
  });

  it('tenant A admin cannot read or update tenant B user by id (404)', async () => {
    const a = await tenantWithAdmin(c, owner);
    const b = await tenantWithAdmin(c, owner);
    const bUser = (await createUser(c, b.admin.token)).body.user;
    const get = await c.http.get(`${API}/users/${bUser.id}`).set(bearer(a.admin.token));
    expect(get.status).toBe(404);
    const put = await c.http.put(`${API}/users/${bUser.id}`).set(bearer(a.admin.token)).send({ name: 'Hijacked', version: bUser.version });
    expect(put.status).toBe(404);
    for (const action of ['deactivate', 'activate', 'reset-password', 'unlock', 'force-logout']) {
      expect((await c.http.post(`${API}/users/${bUser.id}/${action}`).set(bearer(a.admin.token))).status).toBe(404);
    }
    expect((await c.http.get(`${API}/users/${bUser.id}/sessions`).set(bearer(a.admin.token))).status).toBe(404);
    const still = await c.http.get(`${API}/users/${bUser.id}`).set(bearer(b.admin.token));
    expect(still.body.name).toBe(bUser.name);
    // A's list never contains B's users.
    const list = await c.http.get(`${API}/users`).query({ limit: 200 }).set(bearer(a.admin.token));
    expect(list.body.data.find((x: { id: string }) => x.id === bUser.id)).toBeUndefined();
    // Non-uuid ids are a 404 too.
    expect((await c.http.get(`${API}/users/not-a-uuid`).set(bearer(a.admin.token))).status).toBe(404);
  });

  it('updates a user with version, assigns roles, and lists with pagination + search', async () => {
    const { admin } = await tenantWithAdmin(c, owner, { limits: { max_users: 50 } });
    const role = await c.http.post(`${API}/roles`).set(bearer(admin.token)).send({ key: 'buyer', name: 'Buyer' });
    expect(role.status).toBe(201);
    expect((await c.http.post(`${API}/roles`).set(bearer(admin.token)).send({ key: 'buyer', name: 'Buyer' })).status).toBe(409);
    const roles = await c.http.get(`${API}/roles`).set(bearer(admin.token));
    expect(roles.body.map((r: { key: string }) => r.key)).toEqual(['tenant_admin', 'buyer']);

    const created = await createUser(c, admin.token, { name: 'Zed Buyer', roleIds: [role.body.id] });
    expect(created.body.user.roles).toEqual([{ id: role.body.id, key: 'buyer', name: 'Buyer' }]);
    const dupEmail = await createUser(c, admin.token, { email: created.body.user.email });
    expect(dupEmail.status).toBe(409);
    const badRole = await createUser(c, admin.token, { roleIds: [crypto.randomUUID()] });
    expect(badRole.status).toBe(400);

    const upd = await c.http.put(`${API}/users/${created.body.user.id}`).set(bearer(admin.token))
      .send({ name: 'Zed Senior Buyer', roleIds: [], reportingManagerId: admin.userId, version: created.body.user.version });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: 'Zed Senior Buyer', roles: [], version: created.body.user.version + 1 });
    const stale = await c.http.put(`${API}/users/${created.body.user.id}`).set(bearer(admin.token)).send({ name: 'Xavier', version: created.body.user.version });
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    for (let i = 0; i < 4; i++) await createUser(c, admin.token);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: import('supertest').Response = await c.http.get(`${API}/users`).query({ limit: 2, ...(cursor ? { cursor } : {}) }).set(bearer(admin.token));
      seen.push(...res.body.data.map((u: { id: string }) => u.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(6); // admin + Zed + 4
    expect(new Set(seen).size).toBe(6);
    const search = await c.http.get(`${API}/users`).query({ q: 'senior' }).set(bearer(admin.token));
    expect(search.body.data.map((u: { name: string }) => u.name)).toEqual(['Zed Senior Buyer']);
    const wildcard = await c.http.get(`${API}/users`).query({ q: '%' }).set(bearer(admin.token));
    expect(wildcard.body.data).toHaveLength(0);

    const audit = await c.db.selectFrom('app.audit_log').select(['action']).where('entity_id', '=', created.body.user.id).execute();
    expect(audit.map(a => a.action).sort()).toEqual(['create', 'update']);
  });

  it('deactivate and force-logout revoke sessions immediately; reset-password forces a change', async () => {
    const { tenant, admin } = await tenantWithAdmin(c, owner);
    const created = await createUser(c, admin.token);
    const email = created.body.user.email;
    const id = created.body.user.id;
    const s = await tenantLogin(c, tenant.code, email, created.body.temporaryPassword);
    expect((await c.http.get(`${API}/auth/me`).set(bearer(s.token))).status).toBe(200);
    const sessions = await c.http.get(`${API}/users/${id}/sessions`).set(bearer(admin.token));
    expect(sessions.body).toHaveLength(1);

    expect((await c.http.post(`${API}/users/${id}/force-logout`).set(bearer(admin.token))).status).toBe(204);
    expect((await c.http.get(`${API}/auth/me`).set(bearer(s.token))).status).toBe(401);
    expect((await c.http.post(`${API}/auth/refresh`).set('Cookie', s.cookie)).status).toBe(401);

    const s2 = await tenantLogin(c, tenant.code, email, created.body.temporaryPassword);
    const de = await c.http.post(`${API}/users/${id}/deactivate`).set(bearer(admin.token));
    expect(de.body.isActive).toBe(false);
    expect((await c.http.get(`${API}/auth/me`).set(bearer(s2.token))).status).toBe(401);
    const login = await c.http.post(`${API}/auth/login`).send({ tenantCode: tenant.code, email, password: created.body.temporaryPassword });
    expect(login.body.code).toBe('AUTH.INVALID_CREDENTIALS');
    expect((await c.http.post(`${API}/users/${admin.userId}/deactivate`).set(bearer(admin.token))).status).toBe(403);

    expect((await c.http.post(`${API}/users/${id}/activate`).set(bearer(admin.token))).body.isActive).toBe(true);
    const reset = await c.http.post(`${API}/users/${id}/reset-password`).set(bearer(admin.token));
    expect(reset.body.temporaryPassword).toHaveLength(16);
    const s3 = await tenantLogin(c, tenant.code, email, reset.body.temporaryPassword);
    expect(s3.result.mustChangePassword).toBe(true);
  });

  it('tenant usage endpoint returns the Super Admin entitlements shape', async () => {
    const { tenant, admin } = await tenantWithAdmin(c, owner, { limits: { max_users: 10 }, features: ['indent'] });
    const mine = await c.http.get(`${API}/tenant/usage`).set(bearer(admin.token));
    const theirs = await c.http.get(`${API}/platform/tenants/${tenant.tenantId}`).set(bearer(owner));
    expect(mine.body).toEqual(theirs.body.entitlements);
    expect(mine.body.features.find((f: { key: string }) => f.key === 'indent')).toMatchObject({ enabled: true, source: 'plan' });
    expect(mine.body.features.find((f: { key: string }) => f.key === 'whatsapp')).toMatchObject({ enabled: false, source: 'none' });
    const me = await c.http.get(`${API}/auth/me`).set(bearer(admin.token));
    expect(me.body.limits.find((l: { key: string }) => l.key === 'max_users')).toMatchObject({ effective: 10, used: 1 });
  });
});

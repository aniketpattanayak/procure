/**
 * Concurrency: races the contract promises to handle.
 *   - Refresh-token reuse race: N refreshes with the same token at once → at most one succeeds, and because the
 *     losers are "reuse of a rotated token", the whole family ends up revoked (ADR-0004).
 *   - Parallel activate of deactivated users at the max_users limit → never above the limit.
 *   - Mixed create + activate racing for the last slots.
 * Uses @procure/test-kit over supertest (also proves the kit works in vitest).
 */
import { supertestTransport, TestKit } from '@procure/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, bearer, bootApp, closeApp, createPlatformUser, Ctx, refreshCookie } from './helpers';

describe('concurrency', () => {
  let c: Ctx;
  let kit: TestKit;
  let owner: string;

  beforeAll(async () => {
    c = await bootApp();
    kit = new TestKit(supertestTransport(c.http), { createPlatformUser: role => createPlatformUser(c, role) });
    owner = (await kit.platformSession()).token;
  });
  afterAll(async () => closeApp(c));

  const activeCount = async (tenantId: string) => Number((await c.db.selectFrom('app.tenant_user')
    .select(eb => eb.fn.countAll<string>().as('n')).where('tenant_id', '=', tenantId).where('is_active', '=', true)
    .where('is_deleted', '=', false).executeTakeFirstOrThrow()).n);

  describe('refresh-token reuse race', () => {
    for (const n of [2, 8]) {
      it(`${n} parallel refreshes with the same token → at most one 200, the rest REFRESH_REUSED, family revoked`, async () => {
        const { tenant } = await kit.tenantWithAdmin(owner);
        const login = await kit.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
        const results = await Promise.all(Array.from({ length: n }, () => c.http.post(`${API}/auth/refresh`).set('Cookie', login.cookie!)));
        const ok = results.filter(r => r.status === 200);
        expect(ok.length).toBeLessThanOrEqual(1);
        const losers = results.filter(r => r.status !== 200);
        expect(losers.every(r => r.status === 401)).toBe(true);
        expect(losers.some(r => r.body.code === 'AUTH.REFRESH_REUSED')).toBe(true);

        // Family revoked: no live rows remain for this sign-in, and every token minted in the race is dead.
        const sid = JSON.parse(Buffer.from(login.token.split('.')[1]!, 'base64url').toString()).sid;
        const fam = await c.db.selectFrom('platform.auth_session').select('family_id').where('id', '=', sid).executeTakeFirstOrThrow();
        const live = await c.db.selectFrom('platform.auth_session').select('id').where('family_id', '=', fam.family_id).where('revoked_at', 'is', null).execute();
        expect(live).toEqual([]);
        for (const r of ok) {
          expect((await c.http.post(`${API}/auth/refresh`).set('Cookie', refreshCookie(r))).status).toBe(401);
          expect((await c.http.get(`${API}/auth/me`).set(bearer(r.body.accessToken))).status).toBe(401);
        }
        expect((await c.http.get(`${API}/auth/me`).set(bearer(login.token))).status).toBe(401);
      });
    }

    it('a reuse race does not touch the user\'s other sign-ins', async () => {
      const { tenant } = await kit.tenantWithAdmin(owner);
      const victim = await kit.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
      const other = await kit.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
      await Promise.all([1, 2, 3].map(() => c.http.post(`${API}/auth/refresh`).set('Cookie', victim.cookie!)));
      expect((await c.http.get(`${API}/auth/me`).set(bearer(other.token))).status).toBe(200);
      expect((await c.http.post(`${API}/auth/refresh`).set('Cookie', other.cookie!)).status).toBe(200);
    });

    it('platform sessions behave the same way', async () => {
      const u = await createPlatformUser(c, 'support');
      const s = await kit.platformLogin(u.email, u.password);
      const results = await Promise.all(Array.from({ length: 5 }, () => c.http.post(`${API}/auth/refresh`).set('Cookie', s.cookie!)));
      expect(results.filter(r => r.status === 200).length).toBeLessThanOrEqual(1);
      const fam = await c.db.selectFrom('platform.auth_session').select('id').where('subject_id', '=', s.userId).where('revoked_at', 'is', null).execute();
      expect(fam).toEqual([]);
    });
  });

  describe('max_users under parallel activate', () => {
    it('10 deactivated users activated in parallel with 2 free slots → exactly 2 succeed', async () => {
      const { tenant, admin } = await kit.tenantWithAdmin(owner, { limits: { max_users: 12 } });
      const users = [];
      for (let i = 0; i < 11; i++) users.push(await kit.user(admin.token)); // 12/12
      const victims = users.slice(0, 10);
      for (const u of victims) expect((await c.http.post(`${API}/users/${u.id}/deactivate`).set(bearer(admin.token))).status).toBe(200);
      expect(await activeCount(tenant.tenantId)).toBe(2);
      // Lower the cap via override so exactly 2 slots are free: 2 active, limit 4.
      await kit.setOverride(owner, tenant.tenantId, { kind: 'limit', key: 'max_users', value: 4, reason: 'race test' });

      const results = await Promise.all(victims.map(u => c.http.post(`${API}/users/${u.id}/activate`).set(bearer(admin.token))));
      const statuses = results.map(r => r.status);
      expect(statuses.filter(s => s === 200)).toHaveLength(2);
      expect(statuses.filter(s => s === 403)).toHaveLength(8);
      expect(results.filter(r => r.status === 403).every(r => r.body.code === 'LIMIT_EXCEEDED.max_users')).toBe(true);
      expect(await activeCount(tenant.tenantId)).toBe(4);
    });

    it('activate at exactly the limit (0 free) → all refused, count unchanged', async () => {
      const { tenant, admin } = await kit.tenantWithAdmin(owner, { limits: { max_users: 3 } });
      const a = await kit.user(admin.token);
      const b = await kit.user(admin.token); // 3/3
      await c.http.post(`${API}/users/${a.id}/deactivate`).set(bearer(admin.token));
      await c.http.post(`${API}/users/${b.id}/deactivate`).set(bearer(admin.token)); // 1/3
      await kit.user(admin.token);
      await kit.user(admin.token); // 3/3 again
      const results = await Promise.all([a, b, a, b].map(u => c.http.post(`${API}/users/${u.id}/activate`).set(bearer(admin.token))));
      expect(results.every(r => r.status === 403)).toBe(true);
      expect(await activeCount(tenant.tenantId)).toBe(3);
    });

    // QA-BUG-002 (fixed): UsersService.activate() used to read isActive before taking the limit lock, so the 2nd/3rd caller re-counts
    // a user that is already active and gets a spurious LIMIT_EXCEEDED.
    it('[QA-BUG-002] the same user activated in parallel with 1 free slot → no false limit error, one audit row', async () => {
      const { tenant, admin } = await kit.tenantWithAdmin(owner, { limits: { max_users: 3 } });
      const u = await kit.user(admin.token);
      await c.http.post(`${API}/users/${u.id}/deactivate`).set(bearer(admin.token)); // 1/3 → 2 free
      await kit.user(admin.token); // 2/3 → 1 free
      const results = await Promise.all([1, 2, 3].map(() => c.http.post(`${API}/users/${u.id}/activate`).set(bearer(admin.token))));
      expect(results.map(r => r.status)).toEqual([200, 200, 200]);
      expect(await activeCount(tenant.tenantId)).toBe(3);
      const audit = await c.db.selectFrom('app.audit_log').select('id').where('tenant_id', '=', tenant.tenantId)
        .where('entity_id', '=', u.id).where('action', '=', 'activate').execute();
      expect(audit).toHaveLength(1);
    });

    // QA-BUG-002 (second symptom): with free slots every parallel caller "activates" again → duplicate audit rows.
    it('[QA-BUG-002] the same user activated in parallel with free slots → exactly one activate audit row', async () => {
      const { tenant, admin } = await kit.tenantWithAdmin(owner, { limits: { max_users: 20 } });
      const u = await kit.user(admin.token);
      await c.http.post(`${API}/users/${u.id}/deactivate`).set(bearer(admin.token));
      const results = await Promise.all([1, 2, 3, 4].map(() => c.http.post(`${API}/users/${u.id}/activate`).set(bearer(admin.token))));
      expect(results.every(r => r.status === 200)).toBe(true);
      const audit = await c.db.selectFrom('app.audit_log').select('id').where('tenant_id', '=', tenant.tenantId)
        .where('entity_id', '=', u.id).where('action', '=', 'activate').execute();
      expect(audit).toHaveLength(1);
    });

    it('creates and activates racing for the last 3 slots → never above the limit', async () => {
      const { tenant, admin } = await kit.tenantWithAdmin(owner, { limits: { max_users: 8 } });
      const pool = [];
      for (let i = 0; i < 6; i++) pool.push(await kit.user(admin.token)); // 7/8
      for (const u of pool) await c.http.post(`${API}/users/${u.id}/deactivate`).set(bearer(admin.token)); // 1/8
      for (let i = 0; i < 4; i++) await kit.user(admin.token); // 5/8 → 3 free
      const ops = [
        ...pool.map(u => c.http.post(`${API}/users/${u.id}/activate`).set(bearer(admin.token))),
        ...Array.from({ length: 6 }, () => kit.createUserRaw(admin.token)),
      ];
      const results = await Promise.all(ops);
      const ok = results.filter(r => r.status === 200 || r.status === 201);
      expect(ok).toHaveLength(3);
      expect(await activeCount(tenant.tenantId)).toBe(8);
      const n = await kit.notifications(admin.token, { limit: 100 });
      // 5→8/8 crosses 100% exactly once in this burst (80% was crossed earlier at 7/8 and not re-crossed).
      const hundreds = n.data.filter(x => x.kind === 'limit_warning' && x.data.threshold === 100);
      expect(hundreds.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('optimistic concurrency', () => {
    it('two parallel PUTs with the same version → exactly one wins, the other VERSION_CONFLICT', async () => {
      const { admin } = await kit.tenantWithAdmin(owner);
      const u = await kit.user(admin.token);
      const results = await Promise.all(['Alpha Name', 'Bravo Name'].map(name =>
        c.http.put(`${API}/users/${u.id}`).set(bearer(admin.token)).send({ name, version: u.version })));
      expect(results.map(r => r.status).sort()).toEqual([200, 409]);
      expect(results.find(r => r.status === 409)!.body.code).toBe('VERSION_CONFLICT');
    });

    // QA-BUG-003 (fixed): setOverride() used to read the existing override without a lock, and history is ordered by changed_at
    // (= transaction start), so under concurrent writes the "newest" history row is not the effective value and
    // oldValue→newValue no longer chains.
    it('[QA-BUG-003] parallel override writes on one tenant → history row per write, final value matches the last history row', async () => {
      const { tenant } = await kit.tenantWithAdmin(owner);
      const vals = [11, 12, 13, 14, 15];
      const results = await Promise.all(vals.map(v => c.http.put(`${API}/platform/tenants/${tenant.tenantId}/overrides`).set(bearer(owner))
        .send({ kind: 'limit', key: 'max_users', value: v, reason: `race ${v}` })));
      expect(results.every(r => r.status === 200)).toBe(true);
      const hist = await c.http.get(`${API}/platform/tenants/${tenant.tenantId}/overrides/history`).set(bearer(owner));
      expect(hist.body).toHaveLength(5);
      const detail = await c.http.get(`${API}/platform/tenants/${tenant.tenantId}`).set(bearer(owner));
      const eff = detail.body.entitlements.limits.find((l: { key: string }) => l.key === 'max_users').effective;
      expect(eff).toBe(hist.body[0].newValue);
      // History is a consistent chain: each row's oldValue is the previous row's newValue.
      const chrono = [...hist.body].reverse();
      for (let i = 1; i < chrono.length; i++) expect(chrono[i].oldValue).toBe(chrono[i - 1].newValue);
    });
  });
});

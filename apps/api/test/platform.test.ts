import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeTenantAdmin, API, bearer, bootApp, closeApp, createPlan, createTenant, Ctx, superAdmin, tenantLogin, tenantWithAdmin, uid,
} from './helpers';

describe('platform (Super Admin)', () => {
  let c: Ctx;
  let owner: string;

  beforeAll(async () => {
    c = await bootApp();
    owner = (await superAdmin(c)).token;
  });
  afterAll(async () => closeApp(c));

  it('serves the catalog', async () => {
    const res = await c.http.get(`${API}/platform/catalog`).set(bearer(owner));
    expect(res.status).toBe(200);
    expect(res.body.features.map((f: { key: string }) => f.key)).toContain('whatsapp');
    expect(res.body.limits.map((l: { key: string }) => l.key)).toContain('max_users');
  });

  it('creates and updates plans, validating catalog keys and version', async () => {
    const bad = await c.http.post(`${API}/platform/plans`).set(bearer(owner))
      .send({ code: `p-${uid()}`, name: 'Bad', price: 1, features: ['nope'], limits: { not_a_limit: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(['features.0', 'limits.not_a_limit']);

    const plan = await createPlan(c, owner, { features: ['indent'], limits: { max_users: 5, storage_gb: null } });
    expect(plan.limits).toEqual({ max_users: 5, storage_gb: null });
    const upd = await c.http.put(`${API}/platform/plans/${plan.id}`).set(bearer(owner))
      .send({ code: plan.code, name: 'Renamed', price: 2, features: ['indent', 'grn'], limits: { max_users: 7 }, version: plan.version });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: 'Renamed', features: ['grn', 'indent'], limits: { max_users: 7 }, version: plan.version + 1 });
    const stale = await c.http.put(`${API}/platform/plans/${plan.id}`).set(bearer(owner))
      .send({ code: plan.code, name: 'Again', price: 2, version: plan.version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const list = await c.http.get(`${API}/platform/plans`).set(bearer(owner));
    expect(list.body.find((p: { id: string }) => p.id === plan.id)).toBeTruthy();
  });

  it('enforces platform roles: support cannot write plans; billing cannot create tenants', async () => {
    const support = await superAdmin(c, 'support');
    const billing = await superAdmin(c, 'billing');
    const r1 = await c.http.post(`${API}/platform/plans`).set(bearer(support.token)).send({ code: `p-${uid()}`, name: 'X plan', price: 1 });
    expect(r1.status).toBe(403);
    const plan = await createPlan(c, billing.token);
    const r2 = await c.http.post(`${API}/platform/tenants`).set(bearer(billing.token)).send({
      code: `t-${uid()}`, name: 'Nope Co', planId: plan.id, subscription: { startDate: '2026-01-01' }, admin: { name: 'Ad Min', email: 'a@b.test' },
    });
    expect(r2.status).toBe(403);
    const r3 = await c.http.put(`${API}/platform/tenants/${plan.id}/overrides`).set(bearer(support.token)).send({ kind: 'limit', key: 'max_users', value: 1, reason: 'test' });
    expect(r3.status).toBe(403);
  });

  it('creates a plan + tenant with an override; admin signs in with the temp password and must change it', async () => {
    const plan = await createPlan(c, owner, { features: ['indent', 'purchase'], limits: { max_users: 10 } });
    const t = await createTenant(c, owner, plan.id);
    expect(t.temporaryPassword).toHaveLength(16);

    // One transaction created all of this.
    const role = await c.db.selectFrom('app.role').selectAll().where('tenant_id', '=', t.tenantId).execute();
    expect(role).toMatchObject([{ key: 'tenant_admin', is_system: true }]);
    const users = await c.db.selectFrom('app.tenant_user').selectAll().where('tenant_id', '=', t.tenantId).execute();
    expect(users).toMatchObject([{ email: t.adminEmail, is_tenant_admin: true, must_change_password: true }]);
    const ur = await c.db.selectFrom('app.user_role').selectAll().where('tenant_id', '=', t.tenantId).execute();
    expect(ur).toHaveLength(1);
    const pAudit = await c.db.selectFrom('platform.audit_log').selectAll().where('tenant_id', '=', t.tenantId).where('action', '=', 'create').execute();
    expect(pAudit).toHaveLength(1);
    const tAudit = await c.db.selectFrom('app.audit_log').selectAll().where('tenant_id', '=', t.tenantId).where('entity', '=', 'tenant').execute();
    expect(tAudit).toHaveLength(1);

    const ov = await c.http.put(`${API}/platform/tenants/${t.tenantId}/overrides`).set(bearer(owner))
      .send({ kind: 'limit', key: 'max_users', value: 25, reason: 'Pilot customer' });
    expect(ov.status).toBe(200);
    expect(ov.body.limits.find((l: { key: string }) => l.key === 'max_users')).toMatchObject({ planValue: 10, override: 25, effective: 25, used: 1 });

    const login = await tenantLogin(c, t.code, t.adminEmail, t.temporaryPassword);
    expect(login.result.mustChangePassword).toBe(true);
    const admin = await activeTenantAdmin(c, t);
    expect(admin.result.mustChangePassword).toBe(false);
    const usage = await c.http.get(`${API}/tenant/usage`).set(bearer(admin.token));
    expect(usage.body.limits.find((l: { key: string }) => l.key === 'max_users').effective).toBe(25);
  });

  it('effective limit = override ?? plan, and every override change writes history', async () => {
    const plan = await createPlan(c, owner, { limits: { max_users: 10 } });
    const t = await createTenant(c, owner, plan.id);
    const eff = async () => (await c.http.get(`${API}/platform/tenants/${t.tenantId}`).set(bearer(owner))).body.entitlements.limits
      .find((l: { key: string }) => l.key === 'max_users').effective;
    expect(await eff()).toBe(10);
    await c.http.put(`${API}/platform/tenants/${t.tenantId}/overrides`).set(bearer(owner)).send({ kind: 'limit', key: 'max_users', value: 3, reason: 'Trial cap' });
    expect(await eff()).toBe(3);
    await c.http.put(`${API}/platform/tenants/${t.tenantId}/overrides`).set(bearer(owner)).send({ kind: 'limit', key: 'max_users', value: null, reason: 'Unlimited deal' });
    expect(await eff()).toBeNull();
    const rm = await c.http.put(`${API}/platform/tenants/${t.tenantId}/overrides`).set(bearer(owner)).send({ kind: 'limit', key: 'max_users', remove: true, reason: 'Back to plan' });
    expect(rm.status).toBe(200);
    expect(await eff()).toBe(10);

    const hist = await c.http.get(`${API}/platform/tenants/${t.tenantId}/overrides/history`).set(bearer(owner));
    // Newest first. JSON null in jsonb reads back as null, same as "no value", so the reason disambiguates.
    expect(hist.body.map((h: { oldValue: unknown; newValue: unknown; reason: string }) => [h.oldValue, h.newValue, h.reason])).toEqual([
      [null, null, 'Back to plan'],
      [3, null, 'Unlimited deal'],
      [null, 3, 'Trial cap'],
    ]);

    const badKey = await c.http.put(`${API}/platform/tenants/${t.tenantId}/overrides`).set(bearer(owner)).send({ kind: 'limit', key: 'nope', value: 1, reason: 'x x x' });
    expect(badKey.status).toBe(400);
    const badVal = await c.http.put(`${API}/platform/tenants/${t.tenantId}/overrides`).set(bearer(owner)).send({ kind: 'feature', key: 'whatsapp', value: 5, reason: 'x x x' });
    expect(badVal.status).toBe(400);
  });

  it('feature not in plan is missing from /auth/me.features; a feature override adds it', async () => {
    const { tenant, admin } = await tenantWithAdmin(c, owner, { features: ['indent', 'purchase'] });
    const me = await c.http.get(`${API}/auth/me`).set(bearer(admin.token));
    expect(me.body.features).toEqual(['indent', 'purchase']);
    expect(me.body.features).not.toContain('whatsapp');
    await c.http.put(`${API}/platform/tenants/${tenant.tenantId}/overrides`).set(bearer(owner)).send({ kind: 'feature', key: 'whatsapp', value: true, reason: 'Pilot' });
    await c.http.put(`${API}/platform/tenants/${tenant.tenantId}/overrides`).set(bearer(owner)).send({ kind: 'feature', key: 'purchase', value: false, reason: 'Not paid' });
    const me2 = await c.http.get(`${API}/auth/me`).set(bearer(admin.token));
    expect(me2.body.features).toEqual(['indent', 'whatsapp']);
  });

  it('plan edits invalidate cached entitlements for tenants on the plan', async () => {
    const { plan, admin } = await tenantWithAdmin(c, owner, { features: ['indent'] });
    expect((await c.http.get(`${API}/auth/me`).set(bearer(admin.token))).body.features).toEqual(['indent']);
    await c.http.put(`${API}/platform/plans/${plan.id}`).set(bearer(owner))
      .send({ code: plan.code, name: 'Bigger', price: 1, features: ['indent', 'grn'], limits: { max_users: 10 }, version: plan.version });
    expect((await c.http.get(`${API}/auth/me`).set(bearer(admin.token))).body.features).toEqual(['grn', 'indent']);
  });

  it('suspend blocks the tenant with TENANT.SUSPENDED and revokes sessions; reactivate restores', async () => {
    const { tenant, admin } = await tenantWithAdmin(c, owner);
    const sus = await c.http.post(`${API}/platform/tenants/${tenant.tenantId}/suspend`).set(bearer(owner)).send({ reason: 'Unpaid invoices' });
    expect(sus.status).toBe(200);
    expect(sus.body.status).toBe('suspended');
    // Existing session revoked.
    expect((await c.http.get(`${API}/auth/me`).set(bearer(admin.token))).status).toBe(401);
    expect((await c.http.post(`${API}/auth/refresh`).set('Cookie', admin.cookie)).status).toBe(401);
    // New login with the right password says suspended.
    const login = await c.http.post(`${API}/auth/login`).send({ tenantCode: tenant.code, email: tenant.adminEmail, password: 'NewAdmin@12345' });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('TENANT.SUSPENDED');
    // Wrong password still says invalid credentials (no tenant-state oracle).
    const wrong = await c.http.post(`${API}/auth/login`).send({ tenantCode: tenant.code, email: tenant.adminEmail, password: 'Wrong-pass-1' });
    expect(wrong.body.code).toBe('AUTH.INVALID_CREDENTIALS');

    const re = await c.http.post(`${API}/platform/tenants/${tenant.tenantId}/reactivate`).set(bearer(owner)).send({ reason: 'Paid up' });
    expect(re.body.status).toBe('active');
    expect((await c.http.post(`${API}/auth/login`).send({ tenantCode: tenant.code, email: tenant.adminEmail, password: 'NewAdmin@12345' })).status).toBe(200);
  });

  it('a tenant suspended while a token is live gets TENANT.SUSPENDED on the next request', async () => {
    const { tenant, admin } = await tenantWithAdmin(c, owner);
    // Bypass the API (which would also revoke sessions) to prove the guard checks tenant state on every request.
    await c.db.updateTable('platform.tenant').set({ status: 'suspended' }).where('id', '=', tenant.tenantId).execute();
    const { RedisService } = await import('../src/core/redis.service');
    await c.app.get(RedisService).del(`tenant-state:${tenant.tenantId}`);
    const res = await c.http.get(`${API}/users`).set(bearer(admin.token));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT.SUSPENDED');
  });

  it('updates tenant profile with optimistic version', async () => {
    const plan = await createPlan(c, owner);
    const t = await createTenant(c, owner, plan.id);
    const got = await c.http.get(`${API}/platform/tenants/${t.tenantId}`).set(bearer(owner));
    expect(got.body.subscription).toMatchObject({ planId: plan.id, status: 'active' });
    const v = got.body.tenant.version;
    const upd = await c.http.put(`${API}/platform/tenants/${t.tenantId}`).set(bearer(owner)).send({ name: 'Renamed Co', taxIds: { gstin: '27AAPFU0939F1ZV' }, version: v });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: 'Renamed Co', version: v + 1, taxIds: { gstin: '27AAPFU0939F1ZV' } });
    const stale = await c.http.put(`${API}/platform/tenants/${t.tenantId}`).set(bearer(owner)).send({ name: 'Again Co', version: v });
    expect(stale.body.code).toBe('VERSION_CONFLICT');
  });

  it('changes subscription: closes the open row and opens a new one', async () => {
    const p1 = await createPlan(c, owner, { features: ['indent'] });
    const p2 = await createPlan(c, owner, { features: ['indent', 'whatsapp'] });
    const { tenant, admin } = await (async () => {
      const t = await createTenant(c, owner, p1.id);
      return { tenant: t, admin: await activeTenantAdmin(c, t) };
    })();
    const ch = await c.http.post(`${API}/platform/tenants/${tenant.tenantId}/subscription`).set(bearer(owner))
      .send({ planId: p2.id, status: 'active', renewalDate: '2027-01-01', reason: 'Upgrade to growth' });
    expect(ch.status).toBe(200);
    expect(ch.body).toMatchObject({ planId: p2.id, status: 'active', renewalDate: '2027-01-01', effectiveTo: null });
    const hist = await c.http.get(`${API}/platform/tenants/${tenant.tenantId}/subscriptions`).set(bearer(owner));
    expect(hist.body).toHaveLength(2);
    expect(hist.body[0].planId).toBe(p2.id);
    expect(hist.body[1].effectiveTo).not.toBeNull();
    expect((await c.http.get(`${API}/auth/me`).set(bearer(admin.token))).body.features).toContain('whatsapp');

    const expire = await c.http.post(`${API}/platform/tenants/${tenant.tenantId}/subscription`).set(bearer(owner))
      .send({ planId: p2.id, status: 'expired', reason: 'Did not renew' });
    expect(expire.status).toBe(200);
    const blocked = await c.http.get(`${API}/auth/me`).set(bearer(admin.token));
    expect(blocked.body.code).toBe('TENANT.SUBSCRIPTION_INACTIVE');
  });

  it('lists tenants with cursor pagination, activeUsers and effective maxUsers', async () => {
    const plan = await createPlan(c, owner, { limits: { max_users: 4 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await createTenant(c, owner, plan.id)).tenantId);
    await c.http.put(`${API}/platform/tenants/${ids[0]}/overrides`).set(bearer(owner)).send({ kind: 'limit', key: 'max_users', value: 9, reason: 'Bigger' });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: import('supertest').Response = await c.http.get(`${API}/platform/tenants`).query({ limit: 2, ...(cursor ? { cursor } : {}) }).set(bearer(owner));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.data.map((r: { id: string }) => r.id));
      for (const r of res.body.data) {
        if (r.id === ids[0]) expect(r).toMatchObject({ activeUsers: 1, maxUsers: 9, planName: expect.any(String) });
        if (r.id === ids[1]) expect(r).toMatchObject({ activeUsers: 1, maxUsers: 4, subscriptionStatus: 'active' });
      }
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) expect(seen).toContain(id);
    // Newest first.
    expect(seen.indexOf(ids[2]!)).toBeLessThan(seen.indexOf(ids[0]!));

    const filtered = await c.http.get(`${API}/platform/tenants`).query({ status: 'archived' }).set(bearer(owner));
    expect(filtered.body.data.every((r: { status: string }) => r.status === 'archived')).toBe(true);
    const bad = await c.http.get(`${API}/platform/tenants`).query({ cursor: 'garbage' }).set(bearer(owner));
    expect(bad.status).toBe(400);
  });

  it('impersonation: token carries impersonatedBy, session row has impersonated_by, audited on both logs', async () => {
    const sa = await superAdmin(c, 'support');
    const plan = await createPlan(c, owner);
    const t = await createTenant(c, owner, plan.id);
    const res = await c.http.post(`${API}/platform/tenants/${t.tenantId}/impersonate`).set(bearer(sa.token)).send({ reason: 'Ticket #42' });
    expect(res.status).toBe(200);
    expect(res.body.principal).toMatchObject({ kind: 'tenant', tenantId: t.tenantId, isTenantAdmin: true, impersonatedBy: { userId: sa.userId } });
    // Impersonation does not get stuck behind the admin's pending password change.
    expect(res.body.mustChangePassword).toBe(false);
    const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.imp).toBe(sa.userId);
    expect(payload.tid).toBe(t.tenantId);

    const me = await c.http.get(`${API}/auth/me`).set(bearer(res.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.principal.impersonatedBy.userId).toBe(sa.userId);
    const users = await c.http.get(`${API}/users`).set(bearer(res.body.accessToken));
    expect(users.status).toBe(200);

    const session = await c.db.selectFrom('platform.auth_session').selectAll().where('id', '=', payload.sid).executeTakeFirstOrThrow();
    expect(session.impersonated_by).toBe(sa.userId);
    const pLog = await c.db.selectFrom('platform.audit_log').selectAll().where('tenant_id', '=', t.tenantId).where('action', '=', 'impersonate_start').execute();
    expect(pLog).toHaveLength(1);
    expect(pLog[0]!.actor_id).toBe(sa.userId);
    const tLog = await c.db.selectFrom('app.audit_log').selectAll().where('tenant_id', '=', t.tenantId).where('action', '=', 'impersonate_start').execute();
    expect(tLog).toHaveLength(1);
    expect(tLog[0]!.impersonated_by).toBe(sa.userId);

    // Actions taken while impersonating record the impersonator in the tenant log.
    const created = await c.http.post(`${API}/users`).set(bearer(res.body.accessToken)).send({ name: 'Via Support', email: `via-${uid()}@x.test` });
    expect(created.status).toBe(201);
    const createLog = await c.db.selectFrom('app.audit_log').selectAll().where('tenant_id', '=', t.tenantId).where('entity_id', '=', created.body.user.id).executeTakeFirstOrThrow();
    expect(createLog.impersonated_by).toBe(sa.userId);

    const billing = await superAdmin(c, 'billing');
    expect((await c.http.post(`${API}/platform/tenants/${t.tenantId}/impersonate`).set(bearer(billing.token)).send({ reason: 'nope' })).status).toBe(403);
  });

  it('resets the tenant admin password', async () => {
    const { tenant, admin } = await tenantWithAdmin(c, owner);
    const res = await c.http.post(`${API}/platform/tenants/${tenant.tenantId}/admin/reset-password`).set(bearer(owner));
    expect(res.status).toBe(200);
    expect(res.body.temporaryPassword).toHaveLength(16);
    expect((await c.http.get(`${API}/auth/me`).set(bearer(admin.token))).status).toBe(401);
    const login = await tenantLogin(c, tenant.code, tenant.adminEmail, res.body.temporaryPassword);
    expect(login.result.mustChangePassword).toBe(true);
  });

  it('reports usage across tenants and lists the platform audit', async () => {
    const plan = await createPlan(c, owner, { limits: { max_users: 10 } });
    const t = await createTenant(c, owner, plan.id);
    const usage = await c.http.get(`${API}/platform/usage`).set(bearer(owner));
    expect(usage.status).toBe(200);
    const row = usage.body.find((u: { tenantId: string }) => u.tenantId === t.tenantId);
    expect(row.limits.find((l: { key: string }) => l.key === 'max_users')).toEqual({ key: 'max_users', used: 1, effective: 10 });

    const audit = await c.http.get(`${API}/platform/audit`).query({ tenantId: t.tenantId, limit: 1 }).set(bearer(owner));
    expect(audit.status).toBe(200);
    expect(audit.body.data).toHaveLength(1);
    expect(audit.body.data[0]).toMatchObject({ action: 'create', entity: 'tenant', tenantId: t.tenantId });
  });

  it('archive revokes sessions and creating a tenant with an unknown bundle still succeeds', async () => {
    const plan = await createPlan(c, owner);
    const t = await createTenant(c, owner, plan.id, { templateBundle: 'does-not-exist' });
    const a = await activeTenantAdmin(c, t);
    const arch = await c.http.post(`${API}/platform/tenants/${t.tenantId}/archive`).set(bearer(owner)).send({ reason: 'Closed account' });
    expect(arch.body.status).toBe('archived');
    expect((await c.http.get(`${API}/auth/me`).set(bearer(a.token))).status).toBe(401);
    const dup = await c.http.post(`${API}/platform/tenants`).set(bearer(owner)).send({
      code: t.code, name: 'Dup Co', planId: plan.id, subscription: { startDate: '2026-01-01' }, admin: { name: 'Ad Min', email: 'a@b.test' },
    });
    expect(dup.status).toBe(409);
  });
});

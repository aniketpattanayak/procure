/** Integration: tenant settings (validated against SettingsRegistry), labels, flow settings → permver. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, bearer, bootApp, closeApp, Ctx, superAdmin, tenantWithAdmin } from './helpers';
import { restrictedUser, userWithKeys } from './permissions-helpers';

type Row = { key: string; value: unknown; default: unknown; isDefault: boolean; label: string };

describe('settings & labels', () => {
  let c: Ctx;
  let tenantId: string;
  let code: string;
  let admin: string;

  beforeAll(async () => {
    c = await bootApp();
    const owner = (await superAdmin(c)).token;
    const t = await tenantWithAdmin(c, owner, { limits: { max_users: 20, max_locations: 5 } });
    tenantId = t.tenant.tenantId;
    code = t.tenant.code;
    admin = t.admin.token;
  });
  afterAll(async () => closeApp(c));

  it('lists every registry setting with defaults', async () => {
    const r = await c.http.get(`${API}/config/settings`).set(bearer(admin));
    expect(r.status).toBe(200);
    const row = (r.body as Row[]).find(x => x.key === 'security.password_min_length')!;
    expect(row).toEqual({ key: 'security.password_min_length', label: 'Minimum password length', value: 10, default: 10, isDefault: true });
    expect((r.body as Row[]).map(x => x.key)).toContain('flow.indent.enabled');
  });

  it('validates each key: unknown → 400, bad value → 400 (nothing written)', async () => {
    const unknown = await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'security.password_min_length': 12, 'no.such': 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors).toEqual([{ path: 'no.such', message: 'Unknown setting' }]);
    const bad = await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'security.password_min_length': 5 });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].path).toBe('security.password_min_length');
    expect((await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'stock.valuation': 'lifo' })).status).toBe(400);
    expect((await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'labels.location_levels': [''] })).status).toBe(400);
    expect((await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'labels.en': {} })).status).toBe(400);
    expect((await c.http.put(`${API}/config/settings`).set(bearer(admin)).send([1, 2])).status).toBe(400);
    const r = await c.http.get(`${API}/config/settings`).set(bearer(admin));
    expect((r.body as Row[]).every(x => x.isDefault)).toBe(true);
  });

  it('saves, audits and resets to default with null', async () => {
    const put = await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'security.password_min_length': 12, 'labels.location_levels': ['Plant', 'Store', 'Bin'] });
    expect(put.status).toBe(200);
    const row = (put.body as Row[]).find(x => x.key === 'security.password_min_length')!;
    expect(row).toMatchObject({ value: 12, isDefault: false });
    const me = await c.http.get(`${API}/auth/me`).set(bearer(admin));
    expect(me.body.settings['labels.location_levels']).toEqual(['Plant', 'Store', 'Bin']);
    const audit = await c.db.selectFrom('app.audit_log').select(['before', 'after']).where('tenant_id', '=', tenantId).where('entity', '=', 'settings').execute();
    expect(audit).toHaveLength(1);
    // (audit redacts keys that look like secrets, e.g. *password*)
    expect(audit[0]!.after).toEqual({ 'security.password_min_length': '[redacted]', 'labels.location_levels': ['Plant', 'Store', 'Bin'] });
    const reset = await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'security.password_min_length': null });
    expect((reset.body as Row[]).find(x => x.key === 'security.password_min_length')).toMatchObject({ value: 10, isDefault: true });
    // Unchanged values are not audited again.
    await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'labels.location_levels': ['Plant', 'Store', 'Bin'] });
    expect(await c.db.selectFrom('app.audit_log').select('id').where('tenant_id', '=', tenantId).where('entity', '=', 'settings').execute()).toHaveLength(2);
  });

  it('a flow setting change bumps permver and hides/shows gated tabs at once', async () => {
    await c.db.insertInto('app.permission_def').values([
      { tenant_id: tenantId, key: 'qa.flowtab', kind: 'tab', tab_key: 'qa.flowtab', label: 'Flow tab', requires_setting: 'flow.vendor_selection.enabled', source: 'workflow', sort_order: 0 },
      { tenant_id: tenantId, key: 'qa.flowtab:action.view', kind: 'action', tab_key: 'qa.flowtab', label: 'View', source: 'workflow', sort_order: 0 },
    ]).execute();
    // Registry rows written behind the API's back: whoever does that must bump; the settings change below does it here.
    const u = await userWithKeys(c, code, admin, ['admin.users:action.view']);
    const v0 = (await c.http.get(`${API}/auth/me`).set(bearer(admin))).body.permissions;
    expect(v0.keys).toContain('qa.flowtab:action.view');
    const off = await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'flow.vendor_selection.enabled': false });
    expect(off.status).toBe(200);
    const v1 = (await c.http.get(`${API}/auth/me`).set(bearer(admin))).body;
    expect(v1.permissions.version).toBeGreaterThan(v0.version);
    expect(v1.permissions.keys).not.toContain('qa.flowtab:action.view');
    expect(v1.settings['flow.vendor_selection.enabled']).toBe(false);
    const reg = await c.http.get(`${API}/permissions/registry`).set(bearer(admin));
    expect(reg.body.some((t: { key: string }) => t.key === 'qa.flowtab')).toBe(false);
    const role = await c.http.post(`${API}/roles`).set(bearer(admin)).send({ key: 'flow_role', name: 'Flow' });
    const hidden = await c.http.put(`${API}/roles/${role.body.id}/permissions/tabs/qa.flowtab`).set(bearer(admin)).send({ actions: ['qa.flowtab:action.view'] });
    expect(hidden.status).toBe(400);
    // Non-flow change: no bump.
    const before = (await c.http.get(`${API}/auth/me`).set(bearer(u.token))).body.permissions.version;
    await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'grn.over_receipt_pct': 10 });
    expect((await c.http.get(`${API}/auth/me`).set(bearer(u.token))).body.permissions.version).toBe(before);
    await c.http.put(`${API}/config/settings`).set(bearer(admin)).send({ 'flow.vendor_selection.enabled': true });
    expect((await c.http.get(`${API}/auth/me`).set(bearer(admin))).body.permissions.keys).toContain('qa.flowtab:action.view');
  });

  it('labels round-trip; null removes; any user may read; edit needs the key', async () => {
    const put = await c.http.put(`${API}/config/labels`).set(bearer(admin)).send({ lang: 'en', labels: { 'nav.indents': 'Requisitions', 'nav.po': 'Orders' } });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ 'nav.indents': 'Requisitions', 'nav.po': 'Orders' });
    const rm = await c.http.put(`${API}/config/labels`).set(bearer(admin)).send({ labels: { 'nav.po': null } });
    expect(rm.body).toEqual({ 'nav.indents': 'Requisitions' });
    const hi = await c.http.put(`${API}/config/labels`).set(bearer(admin)).send({ lang: 'hi', labels: { 'nav.indents': 'मांग पत्र' } });
    expect(hi.body).toEqual({ 'nav.indents': 'मांग पत्र' });

    const u = await restrictedUser(c, code, admin);
    expect((await c.http.get(`${API}/config/labels`).set(bearer(u.token))).body).toEqual({ 'nav.indents': 'Requisitions' });
    expect((await c.http.get(`${API}/config/labels`).query({ lang: 'hi' }).set(bearer(u.token))).body).toEqual({ 'nav.indents': 'मांग पत्र' });
    expect((await c.http.get(`${API}/auth/me`).set(bearer(u.token))).body.labels).toEqual({ 'nav.indents': 'Requisitions' });
    expect((await c.http.put(`${API}/config/labels`).set(bearer(u.token)).send({ labels: { a: 'b' } })).status).toBe(403);
    expect((await c.http.get(`${API}/config/settings`).set(bearer(u.token))).status).toBe(403);
    expect((await c.http.put(`${API}/config/settings`).set(bearer(u.token)).send({})).status).toBe(403);

    // A language code can never address another setting key.
    expect((await c.http.put(`${API}/config/labels`).set(bearer(admin)).send({ lang: 'location_levels', labels: { a: 'b' } })).status).toBe(400);
    expect((await c.http.get(`${API}/config/labels`).query({ lang: 'x.y' }).set(bearer(admin))).status).toBe(400);
    // Clearing every label removes the row.
    await c.http.put(`${API}/config/labels`).set(bearer(admin)).send({ lang: 'hi', labels: { 'nav.indents': null } });
    const row = await c.db.selectFrom('app.tenant_setting').select('key').where('tenant_id', '=', tenantId).where('key', '=', 'labels.hi').executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('a settings viewer can read but not change', async () => {
    const v = await userWithKeys(c, code, admin, ['admin.settings:action.view']);
    expect((await c.http.get(`${API}/config/settings`).set(bearer(v.token))).status).toBe(200);
    expect((await c.http.put(`${API}/config/settings`).set(bearer(v.token)).send({ 'grn.over_receipt_pct': 1 })).status).toBe(403);
  });
});

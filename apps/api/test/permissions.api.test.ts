/** Integration: registry, role/user permission editing, enforcement, views, escalation, field access, /auth/me. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, bearer, bootApp, closeApp, Ctx, superAdmin, tenantWithAdmin } from './helpers';
import { createRole, grantTab, restrictedUser, userWithKeys } from './permissions-helpers';

describe('permissions', () => {
  let c: Ctx;
  let owner: string;
  let tenantId: string;
  let code: string;
  let admin: string;
  let adminId: string;

  beforeAll(async () => {
    c = await bootApp();
    owner = (await superAdmin(c)).token;
    const t = await tenantWithAdmin(c, owner, { features: ['indent', 'purchase'], limits: { max_users: 50, max_locations: 20 } });
    tenantId = t.tenant.tenantId;
    code = t.tenant.code;
    admin = t.admin.token;
    adminId = t.admin.userId;
  });
  afterAll(async () => closeApp(c));

  const get = (token: string, path: string) => c.http.get(`${API}${path}`).set(bearer(token));

  it('registry is plan-filtered and lists actions, views, scoped flag', async () => {
    const r = await get(admin, '/permissions/registry');
    expect(r.status).toBe(200);
    const tabs = r.body as { key: string; group: string; actions: { key: string }[]; views: { key: string }[]; scoped: boolean; forms: unknown[] }[];
    const users = tabs.find(t => t.key === 'admin.users')!;
    expect(users.group).toBe('Administration');
    expect(users.actions.map(a => a.key)).toContain('admin.users:action.manage_permissions');
    expect(users.views.map(v => v.key)).toEqual(['admin.users:view.active', 'admin.users:view.inactive']);
    expect(tabs.find(t => t.key === 'admin.locations')!.scoped).toBe(true);
    expect(users.scoped).toBe(false);
    // form_builder is not in this plan
    expect(tabs.some(t => t.key === 'config.forms' || t.key === 'config.masters')).toBe(false);
  });

  it('a user without manage_permissions cannot read the registry', async () => {
    const u = await userWithKeys(c, code, admin, ['admin.users:action.view']);
    expect((await get(u.token, '/permissions/registry')).status).toBe(403);
  });

  it('grant / revoke per tab round-trips, audited', async () => {
    const role = await createRole(c, admin);
    const put = await grantTab(c, admin, role.id, 'admin.users', ['admin.users:action.view', 'admin.users:action.add'], ['admin.users:view.active']);
    expect(put.status).toBe(200);
    expect(put.body.grants).toEqual([
      { key: 'admin.users:action.add', effect: 'allow' },
      { key: 'admin.users:action.view', effect: 'allow' },
      { key: 'admin.users:view.active', effect: 'allow' },
    ]);
    const other = await grantTab(c, admin, role.id, 'admin.roles', ['admin.roles:action.view']);
    expect(other.body.grants).toHaveLength(4);
    const view = await get(admin, `/roles/${role.id}/permissions`);
    expect(view.body.grants).toHaveLength(4);
    // Replacing one tab leaves the other alone.
    const revoke = await grantTab(c, admin, role.id, 'admin.users', []);
    expect(revoke.body.grants).toEqual([{ key: 'admin.roles:action.view', effect: 'allow' }]);
    const audits = await c.db.selectFrom('app.audit_log').select(['action', 'entity']).where('tenant_id', '=', tenantId)
      .where('entity', '=', 'role_permissions').where('entity_id', '=', role.id).execute();
    expect(audits).toHaveLength(3);
  });

  it('validates keys against the tab and the registry; plan-hidden keys → FEATURE_NOT_IN_PLAN', async () => {
    const role = await createRole(c, admin);
    const wrongTab = await grantTab(c, admin, role.id, 'admin.users', ['admin.roles:action.view']);
    expect(wrongTab.status).toBe(400);
    expect(wrongTab.body.code).toBe('VALIDATION_FAILED');
    expect(wrongTab.body.errors[0].path).toBe('actions.0');
    expect((await grantTab(c, admin, role.id, 'admin.users', ['admin.users:action.fly'])).status).toBe(400);
    expect((await grantTab(c, admin, role.id, 'admin.users', ['admin.users:view.active'])).status).toBe(400); // a view in actions
    expect((await grantTab(c, admin, role.id, 'nope.tab', [])).status).toBe(404);
    // Whole tab outside the plan.
    const forms = await grantTab(c, admin, role.id, 'config.forms', ['config.forms:action.view']);
    expect(forms.status).toBe(403);
    expect(forms.body.code).toBe('FEATURE_NOT_IN_PLAN');
    // A plan-gated key on a visible tab.
    await c.db.insertInto('app.permission_def').values({
      tenant_id: tenantId, key: 'admin.users:action.design', kind: 'action', tab_key: 'admin.users', label: 'Design', requires_feature: 'form_builder', source: 'form', sort_order: 0,
    }).execute();
    const gated = await grantTab(c, admin, role.id, 'admin.users', ['admin.users:action.view', 'admin.users:action.design']);
    expect(gated.status).toBe(403);
    expect(gated.body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(gated.body.meta.keys).toEqual(['admin.users:action.design']);
  });

  it('restricted user: 403 on routes they lack, 200 on granted ones; changes apply on the very next request', async () => {
    const role = await createRole(c, admin);
    const u = await restrictedUser(c, code, admin, [role.id]);
    expect((await get(u.token, '/users')).status).toBe(403);
    expect((await get(u.token, '/roles')).status).toBe(403);
    expect((await get(u.token, '/tenant/usage')).status).toBe(403);
    expect((await get(u.token, `/users/${adminId}`)).status).toBe(403);
    expect((await c.http.post(`${API}/roles`).set(bearer(u.token)).send({ key: 'zz_x', name: 'X' })).status).toBe(403);

    // Warm the cache, then grant: the next request sees it (permver bump).
    expect((await get(u.token, '/auth/me')).body.permissions.keys).toEqual([]);
    expect((await grantTab(c, admin, role.id, 'admin.users', ['admin.users:action.view'], ['admin.users:view.active'])).status).toBe(200);
    const me = await get(u.token, '/auth/me');
    expect(me.body.permissions.keys).toEqual(['admin.users', 'admin.users:action.view', 'admin.users:view.active']);
    expect((await get(u.token, '/users')).status).toBe(200);
    expect((await get(u.token, `/users/${adminId}`)).status).toBe(200);
    expect((await c.http.post(`${API}/users`).set(bearer(u.token)).send({ name: 'Nope', email: 'nope@example.test' })).status).toBe(403);
    expect((await grantTab(c, admin, role.id, 'admin.usage', ['admin.usage:action.view'])).status).toBe(200);
    expect((await get(u.token, '/tenant/usage')).status).toBe(200);

    // User-level deny wins over the role, immediately.
    const deny = await c.http.put(`${API}/users/${u.id}/permissions/tabs/admin.users`).set(bearer(admin)).send({ deny: ['admin.users:action.view'] });
    expect(deny.status).toBe(200);
    expect(deny.body.grants).toEqual([{ key: 'admin.users:action.view', effect: 'deny' }]);
    expect((await get(u.token, '/users')).status).toBe(403);
    // Revoke the deny; allow add directly on the user.
    await c.http.put(`${API}/users/${u.id}/permissions/tabs/admin.users`).set(bearer(admin)).send({ allow: ['admin.users:action.add'] });
    expect((await get(u.token, '/users')).status).toBe(200);
    expect((await c.http.post(`${API}/users`).set(bearer(u.token)).send({ name: 'Made by clerk', email: `clerk-${Date.now()}@example.test` })).status).toBe(201);
    const both = await c.http.put(`${API}/users/${u.id}/permissions/tabs/admin.users`).set(bearer(admin)).send({ allow: ['admin.users:action.add'], deny: ['admin.users:action.add'] });
    expect(both.status).toBe(400);
  });

  it('removing a role from a user or deactivating the role assignment takes effect at once', async () => {
    const u = await userWithKeys(c, code, admin, ['admin.roles:action.view']);
    expect((await get(u.token, '/roles')).status).toBe(200);
    const r = await c.http.put(`${API}/users/${u.id}/roles`).set(bearer(admin)).send({ roleIds: [] });
    expect(r.status).toBe(200);
    expect(r.body.roles).toEqual([]);
    expect((await get(u.token, '/roles')).status).toBe(403);
    const back = await c.http.put(`${API}/users/${u.id}/roles`).set(bearer(admin)).send({ roleIds: [u.roleId] });
    expect(back.body.roles.map((x: { id: string }) => x.id)).toEqual([u.roleId]);
    expect((await get(u.token, '/roles')).status).toBe(200);
    expect((await c.http.put(`${API}/users/${u.id}/roles`).set(bearer(admin)).send({ roleIds: ['00000000-0000-7000-8000-000000000000'] })).status).toBe(400);
  });

  it('making a user tenant admin grants every visible key on the next request', async () => {
    const u = await restrictedUser(c, code, admin);
    expect((await get(u.token, '/roles')).status).toBe(403);
    const cur = await get(admin, `/users/${u.id}`);
    expect((await c.http.put(`${API}/users/${u.id}`).set(bearer(admin)).send({ isTenantAdmin: true, version: cur.body.version })).status).toBe(200);
    expect((await get(u.token, '/roles')).status).toBe(200);
  });

  it('views: users list honours view keys (403 for a view the user lacks; default = first permitted)', async () => {
    const u = await userWithKeys(c, code, admin, ['admin.users:action.view', 'admin.users:view.active']);
    expect((await get(u.token, '/users?view=inactive')).status).toBe(403);
    expect((await get(u.token, '/users?active=false')).status).toBe(403);
    const list = await get(u.token, '/users?limit=200');
    expect(list.status).toBe(200);
    expect(list.body.data.every((x: { isActive: boolean }) => x.isActive)).toBe(true);

    const inactiveOnly = await userWithKeys(c, code, admin, ['admin.users:action.view', 'admin.users:view.inactive']);
    const victim = await restrictedUser(c, code, admin);
    await c.http.post(`${API}/users/${victim.id}/deactivate`).set(bearer(admin));
    const l2 = await get(inactiveOnly.token, '/users?limit=200');
    expect(l2.status).toBe(200);
    expect(l2.body.data.map((x: { id: string }) => x.id)).toContain(victim.id);
    expect(l2.body.data.every((x: { isActive: boolean }) => !x.isActive)).toBe(true);
    expect((await get(inactiveOnly.token, '/users?view=active')).status).toBe(403);

    const noViews = await userWithKeys(c, code, admin, ['admin.users:action.view']);
    expect((await get(noViews.token, '/users')).status).toBe(403);
    expect((await get(admin, '/users?view=inactive')).status).toBe(200);
  });

  it('no privilege escalation: a non-admin can only grant keys they hold', async () => {
    const mgr = await userWithKeys(c, code, admin, [
      'admin.roles:action.view', 'admin.roles:action.manage_permissions', 'admin.users:action.view',
      'admin.users:action.manage_permissions', 'admin.users:view.active',
    ]);
    const target = await createRole(c, admin, 'Target');
    const esc = await grantTab(c, mgr.token, target.id, 'admin.users', ['admin.users:action.view', 'admin.users:action.add']);
    expect(esc.status).toBe(403);
    expect(esc.body.meta.keys).toEqual(['admin.users:action.add']);
    expect((await grantTab(c, mgr.token, target.id, 'admin.users', ['admin.users:action.view'], ['admin.users:view.active'])).status).toBe(200);
    // Keys the role already had (granted by an admin) may stay even though mgr lacks them.
    await grantTab(c, admin, target.id, 'admin.roles', ['admin.roles:action.view', 'admin.roles:action.delete']);
    expect((await grantTab(c, mgr.token, target.id, 'admin.roles', ['admin.roles:action.view', 'admin.roles:action.delete'])).status).toBe(200);
    // ...and can be removed.
    expect((await grantTab(c, mgr.token, target.id, 'admin.roles', ['admin.roles:action.view'])).status).toBe(200);

    // User overrides: allow needs the key; deny is always fine.
    const victim = await restrictedUser(c, code, admin);
    expect((await c.http.put(`${API}/users/${victim.id}/permissions/tabs/admin.users`).set(bearer(mgr.token)).send({ allow: ['admin.users:action.add'] })).status).toBe(403);
    expect((await c.http.put(`${API}/users/${victim.id}/permissions/tabs/admin.users`).set(bearer(mgr.token)).send({ deny: ['admin.users:action.add'] })).status).toBe(200);

    // Assigning a role with keys mgr lacks.
    const strong = await createRole(c, admin, 'Strong');
    await grantTab(c, admin, strong.id, 'admin.users', ['admin.users:action.add']);
    const assign = await c.http.put(`${API}/users/${victim.id}/roles`).set(bearer(mgr.token)).send({ roleIds: [strong.id] });
    expect(assign.status).toBe(403);
    expect(assign.body.meta.keys).toEqual(['admin.users:action.add']);
    expect((await c.http.put(`${API}/users/${victim.id}/roles`).set(bearer(mgr.token)).send({ roleIds: [target.id] })).status).toBe(200);
    const sys = (await get(admin, '/roles')).body.find((r: { isSystem: boolean }) => r.isSystem);
    if (sys) expect((await c.http.put(`${API}/users/${victim.id}/roles`).set(bearer(mgr.token)).send({ roleIds: [sys.id] })).status).toBe(403);

    // Scope: mgr has no scope at all → cannot grant any location.
    const loc = await c.http.post(`${API}/locations`).set(bearer(admin)).send({ code: `ESC-${Date.now()}`, name: 'Esc plant' });
    expect((await c.http.put(`${API}/roles/${target.id}/scope`).set(bearer(mgr.token)).send({ entries: [{ nodeId: loc.body.id }] })).status).toBe(403);
    expect((await c.http.put(`${API}/roles/${target.id}/scope`).set(bearer(mgr.token)).send({ entries: [{ allNodes: true }] })).status).toBe(403);
  });

  it('scope: validates node ids and tab keys, returns names', async () => {
    const role = await createRole(c, admin);
    const plant = await c.http.post(`${API}/locations`).set(bearer(admin)).send({ code: `SC-${Date.now()}`, name: 'Scope plant' });
    const bad = await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(admin)).send({ entries: [{ nodeId: '00000000-0000-7000-8000-000000000000' }] });
    expect(bad.status).toBe(400);
    expect((await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(admin)).send({ entries: [{ nodeId: plant.body.id, tabKey: 'admin.users' }] })).status).toBe(400);
    expect((await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(admin)).send({ entries: [{ allNodes: true, nodeId: plant.body.id }] })).status).toBe(400);
    const ok = await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(admin)).send({ entries: [{ nodeId: plant.body.id }, { nodeId: plant.body.id }] });
    expect(ok.status).toBe(200);
    expect(ok.body.scope).toHaveLength(1);
    expect(ok.body.scope[0]).toMatchObject({ nodeId: plant.body.id, nodeName: 'Scope plant', nodePath: 'Scope plant', includeDescendants: true, tabKey: null, allNodes: false });
    const u = await restrictedUser(c, code, admin, [role.id]);
    const us = await c.http.put(`${API}/users/${u.id}/scope`).set(bearer(admin)).send({ entries: [{ allNodes: true }] });
    expect(us.status).toBe(200);
    expect((await get(admin, `/users/${u.id}/permissions`)).body.scope[0]).toMatchObject({ allNodes: true });
    const eff = await get(admin, `/users/${u.id}/effective-permissions`);
    expect(eff.body.scope.allNodes).toBe(true);
    expect(eff.body.scope.nodes).toEqual([{ id: plant.body.id, name: 'Scope plant', includeDescendants: true, tabKey: null }]);
  });

  it('effective-permissions explains sources and plan-hidden tabs', async () => {
    const u = await userWithKeys(c, code, admin, ['admin.roles:action.view']);
    await c.http.put(`${API}/users/${u.id}/permissions/tabs/admin.roles`).set(bearer(admin)).send({ allow: ['admin.roles:action.add'] });
    const r = await get(admin, `/users/${u.id}/effective-permissions`);
    expect(r.status).toBe(200);
    expect(r.body.isTenantAdmin).toBe(false);
    const k = (key: string) => r.body.keys.find((x: { key: string }) => x.key === key);
    expect(k('admin.roles:action.view')).toEqual({ key: 'admin.roles:action.view', granted: true, sources: ['role:Keys role'] });
    expect(k('admin.roles:action.add')).toEqual({ key: 'admin.roles:action.add', granted: true, sources: ['user:allow'] });
    expect(k('admin.roles:action.delete').granted).toBe(false);
    expect(r.body.hiddenByPlan).toEqual(expect.arrayContaining([{ key: 'config.forms', label: 'Forms' }, { key: 'config.masters', label: 'Master designer' }]));
    const a = await get(admin, `/users/${adminId}/effective-permissions`);
    expect(a.body.isTenantAdmin).toBe(true);
    expect(a.body.keys.every((x: { granted: boolean }) => x.granted)).toBe(true);
    expect((await get(admin, '/users/00000000-0000-7000-8000-000000000000/effective-permissions')).status).toBe(404);
  });

  it('field access: role restrictions merge, user override lifts them; invalid fields rejected', async () => {
    // The user form is installed by the forms module; create a minimal one if it is not there yet.
    let form = await c.db.selectFrom('app.form_def').select(['id', 'current_version_id']).where('tenant_id', '=', tenantId).where('key', '=', 'user').executeTakeFirst();
    if (!form?.current_version_id) {
      const def = { version: 1, fields: [{ key: 'name', type: 'text', label: 'Name', system: true }, { key: 'phone', type: 'phone', label: 'Phone', system: true }, { key: 'emp_code', type: 'text', label: 'Employee code' }] };
      const f = form ?? await c.db.insertInto('app.form_def').values({ tenant_id: tenantId, key: 'user', name: 'User', kind: 'system', is_system: true }).returning(['id', 'current_version_id']).executeTakeFirstOrThrow();
      const v = await c.db.insertInto('app.form_version').values({ tenant_id: tenantId, form_id: f.id, version: 1, definition: JSON.stringify(def) }).returning('id').executeTakeFirstOrThrow();
      await c.db.updateTable('app.form_def').set({ current_version_id: v.id }).where('id', '=', f.id).execute();
      form = { id: f.id, current_version_id: v.id };
    }
    const reg = await get(admin, '/permissions/registry');
    const usersTab = reg.body.find((t: { key: string }) => t.key === 'admin.users');
    expect(usersTab.forms[0].formKey).toBe('user');
    const fieldKeys = usersTab.forms[0].fields.map((f: { key: string }) => f.key);
    expect(fieldKeys).toEqual(expect.arrayContaining(['name', 'phone']));

    const r1 = await createRole(c, admin);
    const r2 = await createRole(c, admin);
    expect((await grantTab(c, admin, r1.id, 'admin.users', ['admin.users:action.view'], [], [{ formKey: 'user', fieldKey: 'phone', mode: 'readonly' }])).status).toBe(200);
    expect((await grantTab(c, admin, r2.id, 'admin.users', [], [], [{ formKey: 'user', fieldKey: 'phone', mode: 'hidden' }, { formKey: 'user', fieldKey: 'name', mode: 'readonly' }])).status).toBe(200);
    const u = await restrictedUser(c, code, admin, [r1.id, r2.id]);
    expect((await get(u.token, '/auth/me')).body.permissions.fieldAccess).toEqual({ user: { phone: 'hidden', name: 'readonly' } });
    const ov = await c.http.put(`${API}/users/${u.id}/permissions/tabs/admin.users`).set(bearer(admin)).send({ fieldAccess: [{ formKey: 'user', fieldKey: 'phone', mode: 'editable' }] });
    expect(ov.status).toBe(200);
    expect(ov.body.fieldAccess).toMatchObject([{ formKey: 'user', fieldKey: 'phone', mode: 'editable' }]);
    expect((await get(u.token, '/auth/me')).body.permissions.fieldAccess).toEqual({ user: { name: 'readonly' } });

    expect((await grantTab(c, admin, r1.id, 'admin.users', [], [], [{ formKey: 'user', fieldKey: 'nope', mode: 'hidden' }])).status).toBe(400);
    expect((await grantTab(c, admin, r1.id, 'admin.users', [], [], [{ formKey: 'item', fieldKey: 'name', mode: 'hidden' }])).status).toBe(400);
    expect((await grantTab(c, admin, r1.id, 'admin.users', [], [], [{ formKey: 'user', fieldKey: 'name', mode: 'editable' }])).status).toBe(400);
    // Field-access rows of another tab's form are untouched by a tab replace.
    expect((await grantTab(c, admin, r1.id, 'admin.roles', ['admin.roles:action.view'])).body.fieldAccess).toHaveLength(1);
  });

  it('roles: edit with version, delete blocked while assigned, system role protected', async () => {
    const role = await createRole(c, admin, 'Editable');
    const ed = await c.http.put(`${API}/roles/${role.id}`).set(bearer(admin)).send({ key: role.key, name: 'Edited name', version: role.version });
    expect(ed.status).toBe(200);
    expect(ed.body).toMatchObject({ name: 'Edited name', version: role.version + 1 });
    expect((await c.http.put(`${API}/roles/${role.id}`).set(bearer(admin)).send({ key: role.key, name: 'Stale', version: role.version })).status).toBe(409);
    const u = await restrictedUser(c, code, admin, [role.id]);
    const blocked = await c.http.delete(`${API}/roles/${role.id}`).set(bearer(admin));
    expect(blocked.status).toBe(409);
    expect(blocked.body.meta.usedBy[0].count).toBe(1);
    await c.http.put(`${API}/users/${u.id}/roles`).set(bearer(admin)).send({ roleIds: [] });
    expect((await c.http.delete(`${API}/roles/${role.id}`).set(bearer(admin))).status).toBe(204);
    expect((await get(admin, `/roles/${role.id}/permissions`)).status).toBe(404);
    // The key can be reused.
    expect((await c.http.post(`${API}/roles`).set(bearer(admin)).send({ key: role.key, name: 'Reborn' })).status).toBe(201);

    const sys = (await get(admin, '/roles')).body.find((r: { isSystem: boolean }) => r.isSystem);
    if (sys) {
      expect((await c.http.delete(`${API}/roles/${sys.id}`).set(bearer(admin))).status).toBe(409);
      expect((await grantTab(c, admin, sys.id, 'admin.users', [])).status).toBe(409);
    }
    // Key-based: a user with roles view only can't edit/delete.
    const viewer = await userWithKeys(c, code, admin, ['admin.roles:action.view']);
    expect((await c.http.delete(`${API}/roles/${viewer.roleId}`).set(bearer(viewer.token))).status).toBe(403);
    expect((await get(viewer.token, `/roles/${viewer.roleId}/permissions`)).status).toBe(403);
  });

  it('/auth/me carries permissions, labels and non-sensitive settings', async () => {
    const me = await get(admin, '/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.permissions.keys).toContain('admin.users:action.manage_permissions');
    expect(me.body.permissions.keys).not.toContain('config.forms:action.view');
    expect(me.body.permissions.scope).toEqual({ allNodes: true, nodeIds: [] });
    expect(typeof me.body.permissions.version).toBe('number');
    expect(me.body.permissions.scopes).toBeUndefined();
    expect(me.body.labels).toEqual({});
    expect(me.body.settings['labels.location_levels']).toEqual(['Location', 'Sub-location', 'Division']);
    expect(me.body.settings['flow.indent.enabled']).toBe(true);
    expect(Object.keys(me.body.settings).some(k => k.startsWith('security.'))).toBe(false);
    expect(me.body.features).toEqual(['indent', 'purchase']);
  });

  it('plan changes (EntitlementsService.invalidate) bump permver: feature override shows the tab at once', async () => {
    const before = (await get(admin, '/auth/me')).body.permissions;
    const ov = await c.http.put(`${API}/platform/tenants/${tenantId}/overrides`).set(bearer(owner)).send({ kind: 'feature', key: 'form_builder', value: true, reason: 'perm test' });
    expect(ov.status).toBeLessThan(300);
    const after = (await get(admin, '/auth/me')).body.permissions;
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.keys).toContain('config.forms:action.view');
    await c.http.put(`${API}/platform/tenants/${tenantId}/overrides`).set(bearer(owner)).send({ kind: 'feature', key: 'form_builder', value: false, reason: 'perm test' });
    expect((await get(admin, '/auth/me')).body.permissions.keys).not.toContain('config.forms:action.view');
  });
});

/** Phase 3: document tabs `doc.<key>` in the permission registry (scoped, header/line forms, stage keys, tab scope). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/core/entitlements.service';
import { createCapexType, docsTenant, DocsFixture } from './documents-helpers';
import { API, bearer, bootApp, closeApp, Ctx } from './helpers';
import { createRole, restrictedUser } from './permissions-helpers';

type Tab = { key: string; group: string; scoped: boolean; actions: { key: string; label: string }[]; views: { key: string }[]; forms: { formKey: string; label: string; fields: { key: string }[] }[] };

describe('permissions: document tabs', () => {
  let c: Ctx;
  let f: DocsFixture;
  let typeId: string;

  beforeAll(async () => {
    c = await bootApp();
    f = await docsTenant(c);
    await createCapexType(c, f.token);
    typeId = (await c.db.selectFrom('app.doc_type').select('id').where('tenant_id', '=', f.tenantId).where('key', '=', 'capex').executeTakeFirstOrThrow()).id;
    // Stage keys + views as the workflow module writes them on publish (source 'workflow').
    await c.db.insertInto('app.permission_def').values([
      { tenant_id: f.tenantId, key: 'doc.capex:action.stage_hod', kind: 'action', tab_key: 'doc.capex', label: 'Act on HOD approval', source: 'workflow', source_id: typeId, sort_order: 100 },
      { tenant_id: f.tenantId, key: 'doc.capex:view.waiting_hod', kind: 'view', tab_key: 'doc.capex', label: 'Waiting for HOD approval', source: 'workflow', source_id: typeId, sort_order: 100 },
    ]).onConflict(oc => oc.doNothing()).execute();
    await c.app.get(EntitlementsService).bumpPermissions(f.tenantId);
  });
  afterAll(async () => closeApp(c));

  const registry = async () => (await c.http.get(`${API}/permissions/registry`).set(bearer(f.token))).body as Tab[];

  it('doc.<key> is a scoped "Modules" tab with stage actions/views and header + line forms', async () => {
    const tab = (await registry()).find(t => t.key === 'doc.capex')!;
    expect(tab).toBeDefined();
    expect(tab.scoped).toBe(true);
    expect(tab.group).toBe('Modules');
    expect(tab.actions.map(a => a.key)).toEqual(expect.arrayContaining(['doc.capex:action.view', 'doc.capex:action.submit', 'doc.capex:action.stage_hod']));
    expect(tab.actions.find(a => a.key === 'doc.capex:action.stage_hod')!.label).toBe('Act on HOD approval');
    expect(tab.views.map(v => v.key)).toEqual(expect.arrayContaining(['doc.capex:view.draft', 'doc.capex:view.waiting_hod']));
    expect(tab.forms.map(x => [x.formKey, x.label])).toEqual([['capex_header', 'Capex Request header'], ['capex_line', 'Capex Request lines']]);
    const header = tab.forms[0]!.fields.map(x => x.key);
    const lines = tab.forms[1]!.fields.map(x => x.key);
    expect(header).toEqual(expect.arrayContaining(['location', 'purpose', 'priority']));
    expect(lines).toEqual(expect.arrayContaining(['qty', 'est_rate', 'amount', 'remarks']));
    expect(lines.some(k => k.includes('.'))).toBe(false); // plain line field keys
  });

  it('stage keys and line field access can be granted and reach the user', async () => {
    const role = await createRole(c, f.token, 'Capex HOD');
    const put = await c.http.put(`${API}/roles/${role.id}/permissions/tabs/doc.capex`).set(bearer(f.token)).send({
      actions: ['doc.capex:action.view', 'doc.capex:action.stage_hod'], views: ['doc.capex:view.waiting_hod'],
      fieldAccess: [{ formKey: 'capex_line', fieldKey: 'est_rate', mode: 'readonly' }, { formKey: 'capex_header', fieldKey: 'priority', mode: 'hidden' }],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const u = await restrictedUser(c, f.code, f.token, [role.id]);
    const me = (await c.http.get(`${API}/auth/me`).set(bearer(u.token))).body.permissions;
    expect(me.keys).toEqual(expect.arrayContaining(['doc.capex', 'doc.capex:action.stage_hod', 'doc.capex:view.waiting_hod']));
    expect(me.fieldAccess).toEqual({ capex_line: { est_rate: 'readonly' }, capex_header: { priority: 'hidden' } });
    const bad = await c.http.put(`${API}/roles/${role.id}/permissions/tabs/doc.capex`).set(bearer(f.token)).send({
      fieldAccess: [{ formKey: 'capex_line', fieldKey: 'lines.qty', mode: 'hidden' }],
    });
    expect(bad.status).toBe(400);
  });

  it('per-tab scope is accepted for doc tabs and narrows that tab only', async () => {
    const role = await createRole(c, f.token, 'Scoped capex');
    const res = await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(f.token)).send({
      entries: [{ nodeId: f.pune }, { nodeId: f.chennai, tabKey: 'doc.capex' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scope.map((s: { tabKey: string | null }) => s.tabKey).sort()).toEqual(['doc.capex', null].sort());
    const u = await restrictedUser(c, f.code, f.token, [role.id]);
    const eff = await c.http.get(`${API}/users/${u.id}/effective-permissions`).set(bearer(f.token));
    expect(eff.body.scope.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.chennai, tabKey: 'doc.capex' })]));
    // Non-scoped tabs and unknown doc tabs are still refused.
    expect((await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(f.token)).send({ entries: [{ nodeId: f.pune, tabKey: 'admin.users' }] })).status).toBe(400);
    expect((await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(f.token)).send({ entries: [{ nodeId: f.pune, tabKey: 'doc.nope' }] })).status).toBe(400);
  });
});

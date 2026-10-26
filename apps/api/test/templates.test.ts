import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeTenantAdmin, closeApp, createPlan, createTenant, Ctx, bootApp, superAdmin } from './helpers';
import { api, mustOk } from './forms-helpers';

describe('tenant provisioning installs global templates', () => {
  let c: Ctx;
  beforeAll(async () => { c = await bootApp(); });
  afterAll(async () => { await closeApp(c); });

  it('every new tenant gets the system forms, masters and their permission keys', async () => {
    const sa = await superAdmin(c);
    const plan = await createPlan(c, sa.token, { features: ['indent'], limits: { max_users: 5 } });
    const t = await createTenant(c, sa.token, plan.id);
    const admin = await activeTenantAdmin(c, t);
    const masters = await mustOk(api(c, admin.token).get('/masters'));
    const keys = masters.map((m: { key: string }) => m.key).sort();
    // Phase 2 system masters; module installers (Phase 4 procurement: department, tax_code) may add more system ones.
    expect(keys).toEqual(expect.arrayContaining(['item', 'payment_terms', 'terms', 'uom', 'vendor']));
    expect(masters.every((m: { isSystem: boolean }) => m.isSystem)).toBe(true);

    const defs = await c.db.selectFrom('app.form_def').select(['key', 'kind', 'is_system', 'current_version_id']).where('tenant_id', '=', t.tenantId).execute();
    expect(defs.map(d => d.key)).toEqual(expect.arrayContaining(['item', 'payment_terms', 'terms', 'uom', 'user', 'vendor']));
    expect(defs.filter(d => !d.is_system).map(d => d.key)).toEqual([]);
    expect(defs.find(d => d.key === 'user')!.kind).toBe('system');
    expect(defs.every(d => d.current_version_id)).toBe(true);

    const reg = await c.db.selectFrom('app.permission_def').select(['key', 'source', 'group_label']).where('tenant_id', '=', t.tenantId).where('tab_key', '=', 'master.item').execute();
    expect(reg.map(r => r.key).sort()).toEqual([
      'master.item', 'master.item:action.add', 'master.item:action.deactivate', 'master.item:action.delete', 'master.item:action.edit',
      'master.item:action.export', 'master.item:action.import', 'master.item:action.view', 'master.item:view.active', 'master.item:view.inactive',
    ]);
    expect(reg.every(r => r.source === 'master')).toBe(true);
    expect(reg.find(r => r.key === 'master.item')!.group_label).toBe('Masters');

    // system item form: uom lookup required, all system fields
    const item = await c.db.selectFrom('app.form_def as f').innerJoin('app.form_version as v', 'v.id', 'f.current_version_id')
      .select('v.definition').where('f.tenant_id', '=', t.tenantId).where('f.key', '=', 'item').executeTakeFirstOrThrow();
    const fields = (item.definition as { fields: { key: string; system: boolean; required: boolean; type: string }[] }).fields;
    const phase2 = ['uom', 'hsn_code', 'track_batch', 'track_expiry', 'image'];
    // Phase 2 fields in order; module installers may append system fields (Phase 4: tax_code).
    expect(fields.map(f => f.key).filter(k => phase2.includes(k))).toEqual(phase2);
    expect(fields.every(f => f.system)).toBe(true);
    expect(fields[0]).toMatchObject({ type: 'lookup', required: true });

    // no bundle: no sample UoMs, no starter roles
    const uoms = await mustOk(api(c, admin.token).get('/masters/uom/records'));
    expect(uoms.data).toHaveLength(0);
  });

  it('bundle "standard" adds starter roles with grants and sample units of measure', async () => {
    const sa = await superAdmin(c);
    const plan = await createPlan(c, sa.token, { features: ['indent'], limits: { max_users: 5 } });
    const t = await createTenant(c, sa.token, plan.id, { templateBundle: 'standard' });
    const admin = await activeTenantAdmin(c, t);
    const uoms = await mustOk(api(c, admin.token).get('/masters/uom/records?sort=code'));
    expect(uoms.data.map((r: { code: string }) => r.code)).toEqual(['BOX', 'KG', 'LTR', 'MTR', 'NOS']);
    expect(uoms.data.find((r: { code: string }) => r.code === 'KG').data.decimals).toBe('3');
    const roles = await c.db.selectFrom('app.role').select(['id', 'key']).where('tenant_id', '=', t.tenantId).execute();
    expect(roles.map(r => r.key).sort()).toEqual(['approver', 'buyer', 'requester', 'store_keeper', 'tenant_admin']);
    const buyer = roles.find(r => r.key === 'buyer')!;
    const grants = await c.db.selectFrom('app.permission_grant').select('perm_key').where('role_id', '=', buyer.id).execute();
    expect(grants.map(g => g.perm_key)).toContain('master.vendor:action.add');
    const row = await c.db.selectFrom('platform.global_template').select(['kind', 'key']).where('key', '=', 'standard').executeTakeFirst();
    expect(row).toMatchObject({ kind: 'bundle', key: 'standard' });
    const audit = await c.db.selectFrom('platform.audit_log').select('after').where('tenant_id', '=', t.tenantId).where('action', '=', 'create').where('entity', '=', 'tenant').executeTakeFirstOrThrow();
    expect((audit.after as { templateBundle: unknown }).templateBundle).toEqual({ key: 'standard', applied: true });
  });

  it('an unknown bundle still provisions the system masters', async () => {
    const sa = await superAdmin(c);
    const plan = await createPlan(c, sa.token, { features: ['indent'], limits: { max_users: 5 } });
    const t = await createTenant(c, sa.token, plan.id, { templateBundle: 'nope' });
    const rows = await c.db.selectFrom('app.master_def').select(['key', 'is_system']).where('tenant_id', '=', t.tenantId).execute();
    expect(rows.map(r => r.key)).toEqual(expect.arrayContaining(['item', 'payment_terms', 'terms', 'uom', 'vendor']));
    expect(rows.filter(r => !r.is_system).map(r => r.key)).toEqual([]);
  });
});

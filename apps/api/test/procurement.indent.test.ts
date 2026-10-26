import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/core/db.service';
import { EntitlementsService } from '../src/core/entitlements.service';
import { ProvisioningBoot } from '../src/modules/platform/provisioning-boot';
import { ProcurementInstaller } from '../src/modules/procurement';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, superAdmin, tenantWithAdmin } from './helpers';
import { approvedIndent, buckets, docs, proc, procTenant, ProcFixture, submittedIndent } from './procurement-helpers';

let c: Ctx;
let f: ProcFixture;

beforeAll(async () => {
  c = await bootApp();
  f = await procTenant(c);
});
afterAll(async () => closeApp(c));

const count = async (tenantId: string) => ({
  types: (await c.db.selectFrom('app.doc_type').select(['key', 'kind', 'module_key']).where('tenant_id', '=', tenantId).where('key', 'in', ['indent', 'vendor_selection']).orderBy('key').execute()),
  forms: Number((await c.db.selectFrom('app.form_def').select(e => e.fn.countAll<string>().as('n')).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow()).n),
  wfVersions: Number((await c.db.selectFrom('app.workflow_version').select(e => e.fn.countAll<string>().as('n')).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow()).n),
  series: Number((await c.db.selectFrom('app.numbering_series').select(e => e.fn.countAll<string>().as('n')).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow()).n),
  keys: Number((await c.db.selectFrom('app.permission_def').select(e => e.fn.countAll<string>().as('n')).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow()).n),
  masters: Number((await c.db.selectFrom('app.master_def').select(e => e.fn.countAll<string>().as('n')).where('tenant_id', '=', tenantId).where('key', '=', 'department').executeTakeFirstOrThrow()).n),
});

describe('ProcurementInstaller', () => {
  it('provisions a new tenant with department, indent and vendor_selection (forms, keys, numbering, workflows)', async () => {
    const s = await count(f.tenantId);
    expect(s.types).toEqual([{ key: 'indent', kind: 'system', module_key: 'indent' }, { key: 'vendor_selection', kind: 'system', module_key: 'vendor_quotes' }]);
    expect(s.masters).toBe(1);
    const a = api(c, f.token);
    const wf = await mustOk(a.get('/config/workflows/indent'));
    expect(wf.publishedVersion).toBe(1);
    expect(wf.published.stages.map((x: { key: string; name: string }) => [x.key, x.name])).toEqual([['verify', 'Verification']]);
    const ws = await mustOk(a.get('/config/workflows/vendor_selection'));
    expect(ws.published.stages.map((x: { key: string }) => x.key)).toEqual(['approve']);
    const series = await mustOk(a.get('/config/numbering?docType=indent'));
    expect(series[0].pattern).toBe('IND/{FYS}/{SEQ:5}');
    expect((await mustOk(a.get('/config/numbering?docType=vendor_selection')))[0].pattern).toBe('VS/{FYS}/{SEQ:5}');
    const defs = await c.db.selectFrom('app.permission_def').select(['key', 'requires_feature', 'requires_setting']).where('tenant_id', '=', f.tenantId)
      .where('key', 'in', ['doc.indent', 'doc.indent:action.log_quote', 'doc.indent:action.compare', 'doc.indent:action.short_close', 'doc.vendor_selection', 'doc.vendor_selection:action.over_approve', 'doc.indent:action.stage_verify'])
      .orderBy('key').execute();
    expect(defs).toEqual([
      { key: 'doc.indent', requires_feature: 'indent', requires_setting: 'flow.indent.enabled' },
      { key: 'doc.indent:action.compare', requires_feature: 'vendor_quotes', requires_setting: null },
      { key: 'doc.indent:action.log_quote', requires_feature: 'vendor_quotes', requires_setting: null },
      { key: 'doc.indent:action.short_close', requires_feature: 'indent', requires_setting: null },
      { key: 'doc.indent:action.stage_verify', requires_feature: null, requires_setting: null },
      { key: 'doc.vendor_selection', requires_feature: 'vendor_quotes', requires_setting: 'flow.vendor_selection.enabled' },
      { key: 'doc.vendor_selection:action.over_approve', requires_feature: 'vendor_quotes', requires_setting: null },
    ]);
    // forms: header + line with the contract's fields
    const form = await mustOk(a.get('/config/forms/indent_line'));
    const keys = (form.published?.fields ?? form.definition?.fields ?? form.current?.fields ?? []).map((x: { key: string }) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['item', 'uom', 'qty', 'required_date', 'remarks', 'attachments']));
  });

  it('is idempotent: running ensure again changes nothing and keeps tenant edits', async () => {
    const before = await count(f.tenantId);
    const db = c.app.get(DbService);
    const inst = c.app.get(ProcurementInstaller);
    await db.tenantTx(f.tenantId, tx => inst.ensure(tx, f.tenantId));
    await db.tenantTx(f.tenantId, tx => inst.ensure(tx, f.tenantId));
    expect(await count(f.tenantId)).toEqual(before);
    // ensure refuses a transaction of another tenant
    await expect(db.tenantTx(f.tenantId, tx => inst.ensure(tx, '00000000-0000-0000-0000-000000000000'))).rejects.toThrow(/tenant transaction/);
  });

  it('heals a tenant missing the types (as the boot job does for older tenants)', async () => {
    const sa = await superAdmin(c);
    const { tenant } = await tenantWithAdmin(c, sa.token, { features: ['indent', 'vendor_quotes'], limits: { max_users: 5 } });
    expect((await count(tenant.tenantId)).types).toHaveLength(2);
    const ord = c.app.get(ProcurementInstaller).ordered().map(s => s.key);
    const at = (k: string) => ord.indexOf(k);
    expect(at('department_master')).toBeGreaterThanOrEqual(0);
    expect(at('department_master')).toBeLessThan(at('indent_type'));
    expect(at('indent_type')).toBeLessThan(at('vendor_selection_type'));
  });

  it('hides indent keys when flow.indent.enabled is off and the module feature gates the tab', async () => {
    const a = api(c, f.token);
    const me = async (token: string) => (await mustOk(api(c, token).get('/auth/me'))).permissions?.keys ?? (await mustOk(api(c, token).get('/me/permissions'))).keys;
    const sa = await superAdmin(c);
    const noQuotes = await tenantWithAdmin(c, sa.token, { features: ['indent', 'purchase'], limits: { max_users: 5 } });
    const k1: string[] = await me(noQuotes.admin.token);
    expect(k1).toContain('doc.indent:action.add');
    expect(k1).not.toContain('doc.indent:action.log_quote');
    expect(k1.some(k => k.startsWith('doc.vendor_selection'))).toBe(false);

    await mustOk(proc(c, f.token).setSettings({ 'flow.indent.enabled': false }));
    const k2: string[] = await me(f.token);
    expect(k2.some(k => k.startsWith('doc.indent'))).toBe(false);
    expect((await a.post('/docs/indent', { values: { location: f.pune }, lines: [] })).status).toBe(404);
    await mustOk(proc(c, f.token).setSettings({ 'flow.indent.enabled': true }));
    const k3: string[] = await me(f.token);
    expect(k3).toContain('doc.indent:action.log_quote');
  });
});

describe('indent documents', () => {
  it('raises, numbers and approves an indent through the default workflow', async () => {
    const sub = await submittedIndent(c, f, ['10', '5']);
    expect(sub.number).toMatch(/^IND\/\d{2}-\d{2}\/\d{5}$/);
    expect(sub.statusKey).toBe('waiting_verify');
    const ap = await approvedIndent(c, f, ['10', '5'], { approve: ['8', '5'] });
    expect(ap.statusKey).toBe('partially_approved');
    expect(ap.lines[0].qty.approved).toBe('8');
  });

  it('short-closes the unselected remainder (whole document and per line)', async () => {
    const ind = await approvedIndent(c, f, ['10', '4']);
    const p = proc(c, f.buyer.token);
    const r = await mustOk(p.shortClose(ind.id, { reason: 'Not needed any more', lineIds: [ind.lines[1].id] }));
    expect(r.lines[1].qty.shortClosed).toBe('4');
    expect(r.lines[1].statusKey).toBe('closed');
    expect((await buckets(c, ind.lines[0].id)).shortClosed).toBe(0);
    // selected qty is kept; the rest is closed
    await mustOk(p.select({ submit: true, lines: [{ indentLineId: ind.lines[0].id, vendorId: f.vendors[0], qty: '6', rate: '50' }] }));
    const r2 = await mustOk(p.shortClose(ind.id, { reason: 'Rest not needed' }));
    expect(r2.lines[0].qty.shortClosed).toBe('4');
    expect((await p.shortClose(ind.id, { reason: 'Again' })).status).toBe(409);
    // without the key → 403
    expect((await proc(c, f.indenter.token).shortClose(ind.id, { reason: 'No rights' })).status).toBe(403);
  });

  it('refuses to short-close drafts and lines still waiting for approval', async () => {
    const d = docs(c, f.indenter.token, 'indent');
    const draft = await mustOk(d.create({ values: { location: f.pune }, lines: [{ values: { item: f.items[0], qty: '1' } }] }), 201);
    expect((await proc(c, f.token).shortClose(draft.id, { reason: 'Draft' })).status).toBe(409);
    const sub = await submittedIndent(c, f, ['3']);
    expect((await proc(c, f.token).shortClose(sub.id, { reason: 'Pending', lineIds: [sub.lines[0].id] })).status).toBe(409);
    expect((await proc(c, f.token).shortClose(sub.id, { reason: 'Pending' })).status).toBe(409);
  });

  it('boot provisioning job re-runs the installers for every tenant without errors', async () => {
    const before = await count(f.tenantId);
    const n = await c.app.get(ProvisioningBoot).ensureAll();
    expect(n).toBeGreaterThan(0);
    expect(await count(f.tenantId)).toEqual(before);
    expect(await c.app.get(EntitlementsService).bumpPermissions(f.tenantId)).toBeGreaterThan(0);
  });
});

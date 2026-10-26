/**
 * Phase 5 GRN ↔ procurement integration: PO short-close of the net pending receipt, amending a partially received
 * PO (never below the net received qty), PO statuses list + role view grants on install, receipt valuation with
 * `stock.cost_includes_tax`, and a grn-without-store tenant (no stock-dependent types installed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, superAdmin, tenantWithAdmin } from './helpers';
import { approvedPo, decideGrn, docStatus, grnTenant, GrnFixture, inv, lineQty, submittedGrn } from './grn-helpers';
import { poApi } from './procurement-po-helpers';

let c: Ctx;
let f: GrnFixture;

beforeAll(async () => {
  c = await bootApp();
  f = await grnTenant(c);
});
afterAll(async () => closeApp(c));

describe('PO short-close', () => {
  it('closes ordered − received + rejected at receipt', async () => {
    const po = await approvedPo(c, f, ['100']);
    const pl = po.lines[0]!.id;
    const g = await submittedGrn(c, f, po, [[0, '60']]);
    await mustOk(decideGrn(c, f.token, g.id, 'gate', [[g.lines[0]!.id, '50', '10']], 'Broken'));
    await mustOk(poApi(c, f.token).shortClose(po.id, { reason: 'Vendor cannot supply the rest' }));
    expect(await lineQty(c, pl)).toMatchObject({ shortClosed: 50, ordered: 50, received: 60, rejectedAtReceipt: 10 });
    expect((await mustOk(inv(c, f.storekeeper.token).receivable(`po=${po.id}`))).data).toHaveLength(0);
  });
});

describe('amending a partially received PO', () => {
  it('is allowed; quantities cannot go below the net received qty; fully received POs cannot be amended', async () => {
    const po = await approvedPo(c, f, ['100']);
    const g = await submittedGrn(c, f, po, [[0, '70']]);
    await mustOk(decideGrn(c, f.token, g.id, 'gate', [[g.lines[0]!.id, '60', '10']], 'Wet bags'));
    expect(await docStatus(c, po.id)).toBe('partially_received');
    const p = poApi(c, f.token);
    const am = await mustOk(p.amend(po.id, 'Reduce the order'));
    expect(am.statusKey).toBe('amending');
    const line = am.lines[0];
    const set = async (qty: string, version: number) => mustOk(p.update(po.id, { version, values: {}, lines: [{ id: line.id, values: { ...line.values, qty, schedule: [{ date: '2026-12-01', qty }] } }] }));
    const low = await set('59', am.version);
    const bad = await p.submit(po.id, low.version);
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].path).toBe('lines.0.qty');
    const ok = await set('60', low.version);
    const sent = await mustOk(p.submit(po.id, ok.version));
    expect(sent.statusKey).toBe('waiting_approve');
    const done = await mustOk(p.act(po.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: line.id, approve: '60' }] }));
    expect(done.statusKey).toBe('received');
    expect((await p.amend(po.id, 'Again')).status).toBe(409);
  });
});

describe('PO statuses and view grants', () => {
  it('po statuses list includes partially_received / received; roles seeing approved POs see them too', async () => {
    const types = await mustOk(api(c, f.token).get('/doc-types'));
    const po = (types as { key: string; statuses: { key: string }[] }[]).find(t => t.key === 'po')!;
    const keys = po.statuses.map(s => s.key);
    expect(keys).toEqual(expect.arrayContaining(['partially_received', 'received']));
    expect(keys.indexOf('partially_received')).toBe(keys.indexOf('approved') + 1);
    // The install step (tenant creation, boot job) gives every role holding doc.po:view.approved the receipt views.
    const { ProcurementInstaller } = await import('../src/modules/procurement');
    const { DbService } = await import('../src/core/db.service');
    await c.app.get(DbService).tenantTx(f.tenantId, tx => c.app.get(ProcurementInstaller).ensure(tx, f.tenantId));
    await c.app.get(DbService).tenantTx(f.tenantId, tx => c.app.get(ProcurementInstaller).ensure(tx, f.tenantId)); // idempotent
    const grants = await c.db.selectFrom('app.permission_grant').select(['role_id', 'perm_key']).where('tenant_id', '=', f.tenantId)
      .where('perm_key', 'in', ['doc.po:view.approved', 'doc.po:view.received', 'doc.po:view.partially_received']).execute();
    const roles = (k: string) => new Set(grants.filter(g => g.perm_key === k).map(g => g.role_id));
    expect(roles('doc.po:view.approved').size).toBeGreaterThan(0);
    expect(grants.filter(g => g.perm_key === 'doc.po:view.received')).toHaveLength(roles('doc.po:view.received').size);
    for (const r of roles('doc.po:view.approved')) {
      expect(roles('doc.po:view.received').has(r)).toBe(true);
      expect(roles('doc.po:view.partially_received').has(r)).toBe(true);
    }
  });
});

describe('receipt valuation', () => {
  it('unit cost = PO net rate; + line tax per unit when stock.cost_includes_tax', async () => {
    // Item 0 is GST18 and the vendor is intra-state: tax 18% on rate 50 → 9 per unit.
    const po = await approvedPo(c, f, ['10', '10'], '50');
    const g1 = await submittedGrn(c, f, po, [[0, '10']]);
    await mustOk(decideGrn(c, f.token, g1.id, 'gate', [[g1.lines[0]!.id, '10']]));
    await mustOk(decideGrn(c, f.token, g1.id, 'store', [[g1.lines[0]!.id, '10']]));
    const cost = async (lineId: string) => Number((await c.db.selectFrom('app.stock_movement').select('unit_cost').where('line_id', '=', lineId).executeTakeFirstOrThrow()).unit_cost);
    expect(await cost(g1.lines[0]!.id)).toBe(50);
    await mustOk(inv(c, f.token).settings({ 'stock.cost_includes_tax': true }));
    try {
      const g2 = await submittedGrn(c, f, po, [[1, '10']]);
      await mustOk(decideGrn(c, f.token, g2.id, 'gate', [[g2.lines[0]!.id, '10']]));
      await mustOk(decideGrn(c, f.token, g2.id, 'store', [[g2.lines[0]!.id, '10']]));
      // Item 1 is GST12 → 50 + 6.
      expect(await cost(g2.lines[0]!.id)).toBe(56);
    } finally {
      await mustOk(inv(c, f.token).settings({ 'stock.cost_includes_tax': false }));
    }
  });
});

describe('grn without store', () => {
  it('installs GRN / RTV with the stock-less chain, but no store document types (grn.no-store.test.ts)', async () => {
    const sa = await superAdmin(c);
    const { admin } = await tenantWithAdmin(c, sa.token, { features: ['indent', 'purchase', 'grn'], limits: { max_users: 5 } });
    const types = (await mustOk(api(c, admin.token).get('/doc-types'))) as { key: string }[];
    const keys = types.map(t => t.key);
    for (const k of ['issue_request', 'store_issue', 'store_return']) expect(keys).not.toContain(k);
    expect(keys).toEqual(expect.arrayContaining(['grn', 'rtv']));
    expect(keys).toContain('po');
  });
});

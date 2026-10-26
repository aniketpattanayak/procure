/**
 * Phase 5 GRN core: provisioning of the types + default chain, receivable PO lines, GRN from PO, partial receipts
 * across GRNs, over-receipt tolerance (boundary), PO status transitions, gate rejection re-opening the PO.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { docs } from './procurement-helpers';
import { approvedPo, decideGrn, docStatus, grnTenant, GrnFixture, inv, lineQty, stockAt, submittedGrn } from './grn-helpers';

let c: Ctx;
let f: GrnFixture;

beforeAll(async () => {
  c = await bootApp();
  f = await grnTenant(c);
});
afterAll(async () => closeApp(c));

describe('provisioning', () => {
  it('installs grn, rtv, issue_request, store_issue, store_return with their default workflows', async () => {
    const types = await mustOk(api(c, f.token).get('/doc-types'));
    const keys = (types as { key: string }[]).map(t => t.key);
    for (const k of ['grn', 'rtv', 'issue_request', 'store_issue', 'store_return']) expect(keys).toContain(k);
    const wf = await mustOk(api(c, f.token).get('/config/workflows/grn'));
    expect(wf.published.granularity).toBe('line');
    expect(wf.published.stages.map((s: { key: string }) => s.key)).toEqual(['gate', 'store', 'quality', 'disposition']);
    const store = wf.published.stages[1];
    expect(store.effects.onApprove).toEqual([{ effect: 'post_stock', stockStatus: 'available' }]);
    const quality = wf.published.stages[2];
    expect(quality.when).toContain('requires_qc');
    expect(quality.effects.onReject.map((e: { effect: string }) => e.effect)).toEqual(['block_stock', 'route_to']);
    expect(wf.published.stages[3].effects.onReject).toEqual([{ effect: 'return_to_vendor' }]);
  });

  it('does not install GRN / store types for a plan without those features', async () => {
    const { procTenant } = await import('./procurement-helpers');
    const g = await procTenant(c);
    const types = await mustOk(api(c, g.token).get('/doc-types'));
    const keys = (types as { key: string }[]).map(t => t.key);
    expect(keys).not.toContain('grn');
    expect(keys).not.toContain('store_issue');
  });
});

describe('receivable PO lines and GRN from PO', () => {
  it('lists approved PO lines with pending receipt and tolerance', async () => {
    const po = await approvedPo(c, f, ['100']);
    const page = await mustOk(inv(c, f.storekeeper.token).receivable(`po=${po.id}`));
    expect(page.data).toHaveLength(1);
    const l = page.data[0];
    expect(l).toMatchObject({ poLineId: po.lines[0]!.id, poId: po.id, ordered: '100', received: '0', pendingReceipt: '100', maxReceivable: '105', rate: '50' });
    expect(l.vendor.id).toBe(f.vendors[0]);
  });

  it('creates a draft GRN copying item, PO rate, location; values validated', async () => {
    const po = await approvedPo(c, f, ['40']);
    const out = await mustOk(inv(c, f.storekeeper.token).fromPo({
      values: { invoice_no: 'INV-1', challan_no: 'CH-9' },
      lines: [{ poLineId: po.lines[0]!.id, qty: '10', batchNo: 'B-1', mfgDate: '2026-01-01', expiryDate: '2027-01-01' }],
    }), 201);
    expect(out).toHaveLength(1);
    const g = out[0];
    expect(g.statusKey).toBe('draft');
    expect(g.values.party).toBe(f.vendors[0]);
    expect(g.values.invoice_no).toBe('INV-1');
    expect(g.lines[0].values).toMatchObject({ item: f.items[0], po_line: po.lines[0]!.id, batch_no: 'B-1' });
    expect(Number(g.lines[0].values.rate)).toBe(50);
    // A draft reserves nothing.
    expect((await lineQty(c, po.lines[0]!.id)).received).toBe(0);
  });

  it('rejects quantities above the tolerance, zero, duplicates and mixed vendors (400)', async () => {
    const po = await approvedPo(c, f, ['20']);
    const r1 = await inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: po.lines[0]!.id, qty: '21.001' }] });
    expect(r1.status).toBe(400);
    const r2 = await inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: po.lines[0]!.id, qty: '0' }] });
    expect(r2.status).toBe(400);
    const r3 = await inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: po.lines[0]!.id, qty: '1' }, { poLineId: po.lines[0]!.id, qty: '1' }] });
    expect(r3.status).toBe(400);
  });
});

describe('partial receipts, tolerance and PO status', () => {
  it('two partial GRNs move the PO to partially_received then received', async () => {
    const po = await approvedPo(c, f, ['100']);
    const pl = po.lines[0]!.id;
    const g1 = await submittedGrn(c, f, po, [[0, '60']]);
    expect(g1.statusKey).toBe('waiting_gate');
    expect((await lineQty(c, pl)).received).toBe(60);
    expect(await docStatus(c, po.id)).toBe('partially_received');
    const page = await mustOk(inv(c, f.storekeeper.token).receivable(`po=${po.id}`));
    expect(page.data[0]).toMatchObject({ received: '60', pendingReceipt: '40', maxReceivable: '42' });
    await submittedGrn(c, f, po, [[0, '40']]);
    expect(await docStatus(c, po.id)).toBe('received');
    const line = await mustOk(api(c, f.token).get(`/docs/po/${po.id}`));
    expect(line.lines[0].statusKey).toBe('received');
    expect(line.lines[0].qty.pendingReceipt).toBe('0');
    expect((await mustOk(inv(c, f.storekeeper.token).receivable(`po=${po.id}`))).data).toHaveLength(0);
  });

  it('tolerance boundary: exactly pending × (1 + 5%) passes, one unit more is 409 at submit', async () => {
    const po = await approvedPo(c, f, ['100']);
    const pl = po.lines[0]!.id;
    // Two drafts made while the whole qty is pending; the second one only fails at submit (row-locked check).
    const a = (await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: pl, qty: '80' }] }), 201))[0];
    const b = (await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: pl, qty: '21.001' }] }), 201))[0];
    await mustOk(docs(c, f.storekeeper.token, 'grn').submit(a.id, a.version));
    const bad = await docs(c, f.storekeeper.token, 'grn').submit(b.id, b.version);
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('QTY_EXCEEDS_REMAINING');
    expect(bad.body.meta).toMatchObject({ pendingReceipt: '20', maxReceivable: '21', asked: '21.001' });
    const ok = (await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: pl, qty: '21' }] }), 201))[0];
    await mustOk(docs(c, f.storekeeper.token, 'grn').submit(ok.id, ok.version));
    expect((await lineQty(c, pl)).received).toBe(101);
    expect(await docStatus(c, po.id)).toBe('received');
  });

  it('tolerance follows the setting (0% = exact)', async () => {
    const po = await approvedPo(c, f, ['10']);
    await mustOk(inv(c, f.token).settings({ 'grn.over_receipt_pct': 0 }));
    try {
      const r = await inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: po.lines[0]!.id, qty: '10.001' }] });
      expect(r.status).toBe(400);
      await submittedGrn(c, f, po, [[0, '10']]);
    } finally {
      await mustOk(inv(c, f.token).settings({ 'grn.over_receipt_pct': 5 }));
    }
  });

  it('a GRN covers one PO unless grn.multi_po (then one GRN per vendor)', async () => {
    const p1 = await approvedPo(c, f, ['5']);
    const p2 = await approvedPo(c, f, ['6']);
    const two = await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: p1.lines[0]!.id, qty: '1' }, { poLineId: p2.lines[0]!.id, qty: '1' }] }), 201);
    expect(two).toHaveLength(2);
    await mustOk(inv(c, f.token).settings({ 'grn.multi_po': true }));
    try {
      const one = await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: p1.lines[0]!.id, qty: '1' }, { poLineId: p2.lines[0]!.id, qty: '1' }] }), 201);
      expect(one).toHaveLength(1);
      expect(one[0].lines).toHaveLength(2);
    } finally {
      await mustOk(inv(c, f.token).settings({ 'grn.multi_po': false }));
    }
  });
});

describe('verification chain', () => {
  it('gate rejection writes rejected_at_receipt and re-opens the PO; store approval posts stock', async () => {
    const po = await approvedPo(c, f, ['50']);
    const pl = po.lines[0]!.id;
    const g = await submittedGrn(c, f, po, [[0, '50']]);
    const gl = g.lines[0]!.id;
    const r1 = await mustOk(decideGrn(c, f.token, g.id, 'gate', [[gl, '45', '5']], 'Damaged bags'));
    expect(r1.statusKey).toBe('waiting_store');
    expect(await lineQty(c, gl)).toMatchObject({ rejected: 5, rejectedAtReceipt: 5 });
    expect(await lineQty(c, pl)).toMatchObject({ received: 50, rejectedAtReceipt: 5 });
    expect(await docStatus(c, po.id)).toBe('partially_received');
    const page = await mustOk(inv(c, f.storekeeper.token).receivable(`po=${po.id}`));
    expect(page.data[0].pendingReceipt).toBe('5');
    // Store approves 45 → stock posted (no QC on this item → quality and disposition skipped → approved).
    const before = await stockAt(c, f.items[0]!, f.pune);
    const r2 = await mustOk(decideGrn(c, f.token, g.id, 'store', [[gl, '45']]));
    expect(r2.statusKey).toBe('partially_approved');
    expect((await stockAt(c, f.items[0]!, f.pune)).available - before.available).toBe(45);
    expect(await lineQty(c, gl)).toMatchObject({ accepted: 45, approved: 45 });
    expect(await lineQty(c, pl)).toMatchObject({ accepted: 45 });
    const doc = await mustOk(docs(c, f.token, 'grn').get(g.id));
    expect(doc.lines[0].values).toMatchObject({ accepted_qty: '45', rejected_qty: '5' });
    const mv = await c.db.selectFrom('app.stock_movement').selectAll().where('line_id', '=', gl).execute();
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ movement_type: 'receipt', stock_status: 'available' });
    expect(Number(mv[0]!.unit_cost)).toBe(50);
  });

  it('cancelling a submitted GRN before posting re-opens the PO', async () => {
    const po = await approvedPo(c, f, ['30']);
    const g = await submittedGrn(c, f, po, [[0, '30']]);
    expect(await docStatus(c, po.id)).toBe('received');
    const cur = await mustOk(docs(c, f.storekeeper.token, 'grn').get(g.id));
    await mustOk(api(c, f.storekeeper.token).post(`/docs/grn/${g.id}/cancel`, { reason: 'Wrong vehicle', version: cur.version }));
    expect(await lineQty(c, po.lines[0]!.id)).toMatchObject({ received: 30, rejectedAtReceipt: 30 });
    expect(await docStatus(c, po.id)).toBe('approved');
  });
});

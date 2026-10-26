/**
 * QA Phase 5 — GRN chain, RTV, issue / return through the real workflow: partial receipts across many GRNs at the
 * tolerance boundary, concurrent GRN submits / approvals, gate rejection re-opening the PO, QA reject → block →
 * disposition → RTV → PO re-open (with valuation), idempotent workflow replays, concurrent issues, and the backend
 * follow-ups (FEFO, pendingReceipt incl. RTV, PO short-close / amend after partial receipt, stock.cost_includes_tax).
 *
 * Known bugs are `it.fails` with their id (docs/qa/phase-5-report.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { docs, scoped } from './procurement-helpers';
import { poApi } from './procurement-po-helpers';
import { approvedPo, decideGrn, docStatus, grnTenant, GrnFixture, inv, ISSUER_KEYS, lineQty, requireQc, stockAt, submittedGrn } from './grn-helpers';
import { docKeys, expectIntegrity } from './qa-phase5-helpers';

let c: Ctx;
let f: GrnFixture;

beforeAll(async () => {
  c = await bootApp();
  f = await grnTenant(c);
}, 180_000);
afterAll(async () => closeApp(c));

const settings = (v: Record<string, unknown>) => mustOk(inv(c, f.token).settings(v));
async function gateStore(g: { id: string; lines: { id: string }[] }, qtys: string[]) {
  await mustOk(decideGrn(c, f.token, g.id, 'gate', g.lines.map((l, i) => [l.id, qtys[i]!] as [string, string])));
  return mustOk(decideGrn(c, f.token, g.id, 'store', g.lines.map((l, i) => [l.id, qtys[i]!] as [string, string])));
}
const receivable = async (poId: string) => (await mustOk(inv(c, f.storekeeper.token).receivable(`po=${poId}`))).data as { poLineId: string; pendingReceipt: string; maxReceivable: string; received: string }[];

// ---------------------------------------------------------------------------------------------- receipts
describe('partial receipts across many GRNs and the tolerance boundary', () => {
  it('5% tolerance: many partial GRNs never exceed ordered × 1.05; exactly the boundary is accepted, one unit more is refused', async () => {
    await settings({ 'grn.over_receipt_pct': 5 });
    try {
      const po = await approvedPo(c, f, ['100']);
      const pl = po.lines[0]!.id;
      for (const q of ['12.5', '20', '0.001', '33.333', '30']) await gateStore(await submittedGrn(c, f, po, [[0, q]]), [q]);
      // received 95.834 → pending 4.166 → max floor(4.166 × 1.05) = 4.3743
      const r = (await receivable(po.id))[0]!;
      expect(r).toMatchObject({ received: '95.834', pendingReceipt: '4.166', maxReceivable: '4.3743' });
      expect(await docStatus(c, po.id)).toBe('partially_received');
      expect((await inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: pl, qty: '4.375' }] })).status).toBe(400);
      const g = await submittedGrn(c, f, po, [[0, '4.374']]);
      await gateStore(g, ['4.374']);
      expect(await lineQty(c, pl)).toMatchObject({ received: 100.208, accepted: 100.208 });
      expect(await docStatus(c, po.id)).toBe('received');
      expect(await receivable(po.id)).toEqual([]);
      expect((await inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: pl, qty: '0.001' }] })).status).toBe(400);
      expect((await stockAt(c, f.items[0]!, f.pune)).available).toBeGreaterThanOrEqual(100.208);
    } finally {
      await settings({ 'grn.over_receipt_pct': 0 });
    }
  });

  it('two drafts that each fit but together exceed the pending qty: the second submit is 409 QTY_EXCEEDS_REMAINING', async () => {
    const po = await approvedPo(c, f, ['10']);
    const a = await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: po.lines[0]!.id, qty: '6' }] }), 201);
    const b = await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: po.lines[0]!.id, qty: '6' }] }), 201);
    const d = docs(c, f.storekeeper.token, 'grn');
    await mustOk(d.submit(a[0].id, a[0].version));
    const r = await d.submit(b[0].id, b[0].version);
    expect([r.status, r.body.code]).toEqual([409, 'QTY_EXCEEDS_REMAINING']);
    expect(r.body.meta).toMatchObject({ pendingReceipt: '4', asked: '6' });
  });

  it('concurrent GRN submits against one PO line: the sum received never exceeds the order', async () => {
    const po = await approvedPo(c, f, ['100']);
    const drafts = [];
    for (let i = 0; i < 10; i++) drafts.push((await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: po.lines[0]!.id, qty: '15' }] }), 201))[0]);
    const d = docs(c, f.storekeeper.token, 'grn');
    const res = await Promise.all(drafts.map(x => d.submit(x.id, x.version)));
    expect(res.filter(r => r.status === 200)).toHaveLength(6);
    expect(res.filter(r => r.status !== 200).every(r => r.status === 409 && r.body.code === 'QTY_EXCEEDS_REMAINING')).toBe(true);
    expect(await lineQty(c, po.lines[0]!.id)).toMatchObject({ received: 90 });
  });

  it('concurrent store approvals of many GRNs post stock exactly once each; ledger integrity holds', async () => {
    const po = await approvedPo(c, f, ['40', '40', '40']);
    const before = await stockAt(c, f.items[1]!, f.pune);
    const gs = [];
    for (let i = 0; i < 8; i++) {
      const g = await submittedGrn(c, f, po, [[1, '5']]);
      await mustOk(decideGrn(c, f.token, g.id, 'gate', [[g.lines[0]!.id, '5']]));
      gs.push(g);
    }
    const res = await Promise.all(gs.map(g => decideGrn(c, f.token, g.id, 'store', [[g.lines[0]!.id, '5']])));
    expect(res.map(r => r.status)).toEqual(Array(8).fill(200));
    expect((await stockAt(c, f.items[1]!, f.pune)).available - before.available).toBe(40);
    expect(await lineQty(c, po.lines[1]!.id)).toMatchObject({ received: 40, accepted: 40 });
    expect(await docStatus(c, po.id)).toBe('partially_received');
    await expectIntegrity(c, f.tenantId);
  });

  it('gate rejection (before stock) re-opens the PO line and never touches stock; partial gate approval posts only the approved part', async () => {
    const po = await approvedPo(c, f, ['50']);
    const pl = po.lines[0]!.id;
    const before = await stockAt(c, f.items[0]!, f.pune);
    const g = await submittedGrn(c, f, po, [[0, '50']]);
    await mustOk(decideGrn(c, f.token, g.id, 'gate', [[g.lines[0]!.id, '30', '20']], 'Damaged in transit'));
    expect(await lineQty(c, pl)).toMatchObject({ received: 50, rejectedAtReceipt: 20 });
    expect((await receivable(po.id))[0]).toMatchObject({ pendingReceipt: '20' });
    await mustOk(decideGrn(c, f.token, g.id, 'store', [[g.lines[0]!.id, '30']]));
    expect((await stockAt(c, f.items[0]!, f.pune)).available - before.available).toBe(30);
    const mv = await c.db.selectFrom('app.stock_movement').select(['qty_in']).where('document_id', '=', g.id).execute();
    expect(mv.map(m => Number(m.qty_in))).toEqual([30]);
    // A GRN fully rejected at the gate leaves the PO exactly as it was before it.
    const g2 = await submittedGrn(c, f, po, [[0, '20']]);
    const r = await mustOk(decideGrn(c, f.token, g2.id, 'gate', [[g2.lines[0]!.id, '0', '20']], 'Wrong material'));
    expect(r.statusKey).toBe('rejected');
    expect((await receivable(po.id))[0]).toMatchObject({ pendingReceipt: '20' });
    expect(await c.db.selectFrom('app.stock_movement').select('id').where('document_id', '=', g2.id).execute()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- QA chain
describe('QA reject → block → disposition → RTV → PO re-open', () => {
  it('runs end to end with exact quantities, ledger integrity and the PO back to partially_received', async () => {
    await requireQc(c, [f.items[2]!]);
    const po = await approvedPo(c, f, ['1', '1', '80']);
    const pl = po.lines[2]!.id;
    const before = await stockAt(c, f.items[2]!, f.pune);
    const g = await submittedGrn(c, f, po, [[2, '80', { batchNo: 'QA-LOT', expiryDate: '2028-01-01' }]]);
    const gl = g.lines[0]!.id;
    await gateStore(g, ['80']);
    expect(await docStatus(c, g.id)).toBe('waiting_quality');
    await mustOk(decideGrn(c, f.token, g.id, 'quality', [[gl, '62.5', '17.5']], 'Off spec'));
    let s = await stockAt(c, f.items[2]!, f.pune);
    expect([s.available - before.available, s.quarantine - before.quarantine]).toEqual([62.5, 17.5]);
    await mustOk(decideGrn(c, f.token, g.id, 'disposition', [[gl, '0', '17.5']], 'Return it'));
    const rtvRow = await c.db.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select(['d.id']).where('t.key', '=', 'rtv')
      .where('d.tenant_id', '=', f.tenantId).where('d.status_key', '=', 'draft').orderBy('d.created_at', 'desc').executeTakeFirstOrThrow();
    const rtv = await mustOk(docs(c, f.token, 'rtv').get(rtvRow.id));
    expect(Number(rtv.lines[0].values.qty)).toBe(17.5);
    const sub = await mustOk(docs(c, f.storekeeper.token, 'rtv').submit(rtv.id, rtv.version));
    // Replay the approval three times with one Idempotency-Key: stock leaves once.
    const key = `qa5-rtv-${Date.now()}`;
    const res = await Promise.all([1, 2, 3].map(() => c.http.post(`/api/v1/docs/rtv/${sub.id}/actions`).set({ Authorization: `Bearer ${f.token}`, 'Idempotency-Key': key })
      .send({ action: 'decide', stageKey: 'approve', decisions: [{ lineId: sub.lines[0].id, approve: '17.5' }] })));
    expect(res.map(r => r.status)).toEqual([200, 200, 200]);
    s = await stockAt(c, f.items[2]!, f.pune);
    expect([s.available - before.available, s.quarantine - before.quarantine]).toEqual([62.5, 0]);
    expect(await c.db.selectFrom('app.stock_movement').select('id').where('document_id', '=', sub.id).execute()).toHaveLength(1);
    expect(await lineQty(c, pl)).toMatchObject({ received: 80, accepted: 80, returned: 17.5 });
    expect((await receivable(po.id)).find(r => r.poLineId === pl)).toMatchObject({ pendingReceipt: '17.5' });
    expect(await docStatus(c, po.id)).toBe('partially_received');
    // The re-opened qty can be received again (replacement supply).
    const g2 = await submittedGrn(c, f, po, [[2, '17.5']]);
    await gateStore(g2, ['17.5']);
    await mustOk(decideGrn(c, f.token, g2.id, 'quality', [[g2.lines[0]!.id, '17.5']]));
    expect((await receivable(po.id)).find(r => r.poLineId === pl)).toBeUndefined();
    await expectIntegrity(c, f.tenantId);
  });

  // QA5-BUG-001 (fixed) through the real chain: the RTV (and the QA block before it) leaves at the GRN line's receipt
  // cost, not at the node's average.
  it('QA5-BUG-001 (fixed) the RTV of rejected goods is valued at their receipt rate (PO rate)', async () => {
    await requireQc(c, [f.items[2]!]);
    const a = api(c, f.token);
    // Chennai already holds 100 of the item at 10; the rejected 10 arrive at the PO rate 100.
    await mustOk(a.post('/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: f.items[2], nodeId: f.chennai, qty: '100', unitCost: '10' }] }));
    const po = await approvedPo(c, f, ['1', '1', '10'], '100');
    const g = await mustOk(inv(c, f.storekeeper.token).fromPo({ submit: true, values: { location: f.chennai }, lines: [{ poLineId: po.lines[2]!.id, qty: '10' }] }), 201);
    const gl = g[0].lines[0].id;
    await gateStore(g[0], ['10']);
    await mustOk(decideGrn(c, f.token, g[0].id, 'quality', [[gl, '0', '10']], 'All bad'));
    await mustOk(decideGrn(c, f.token, g[0].id, 'disposition', [[gl, '0', '10']], 'Return'));
    const rtvRow = await c.db.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select(['d.id']).where('t.key', '=', 'rtv')
      .where('d.tenant_id', '=', f.tenantId).where('d.status_key', '=', 'draft').orderBy('d.created_at', 'desc').executeTakeFirstOrThrow();
    const rtv = await mustOk(docs(c, f.token, 'rtv').get(rtvRow.id));
    const sub = await mustOk(docs(c, f.storekeeper.token, 'rtv').submit(rtv.id, rtv.version));
    await mustOk(docs(c, f.token, 'rtv').act(sub.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: sub.lines[0].id, approve: '10' }] }));
    const mv = await c.db.selectFrom('app.stock_movement').select(['unit_cost', 'value']).where('document_id', '=', sub.id).executeTakeFirstOrThrow();
    // Was the Chennai average (2000 / 110 = 18.18), leaving 818.18 of value behind on 100 units.
    expect(Number(mv.unit_cost)).toBe(Number(rtv.lines[0].values.rate));
    expect(Number(mv.value)).toBe(-1000);
    expect((await stockAt(c, f.items[2]!, f.chennai))).toMatchObject({ available: 100, quarantine: 0 });
    const left = await c.db.selectFrom('app.stock_balance').select(['stock_status', 'qty', 'value']).where('tenant_id', '=', f.tenantId).where('item_id', '=', f.items[2]!)
      .where('node_id', '=', f.chennai).where('qty', '<>', '0').execute();
    expect(left.map(r => [r.stock_status, Number(r.qty), Number(r.value)])).toEqual([['available', 100, 1000]]);
    await expectIntegrity(c, f.tenantId);
  });
});

// ---------------------------------------------------------------------------------------------- issues
describe('store issue and return under concurrency', () => {
  it('parallel issue approvals against the same stock never go negative; failures are business 409s', async () => {
    const issuer = await scoped(c, f.token, f.code, ISSUER_KEYS);
    const node = f.chennai;
    await mustOk(api(c, f.token).post('/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: f.items[1], nodeId: node, qty: '10', unitCost: '3.3333' }] }));
    const subs = [];
    for (let i = 0; i < 6; i++) {
      const d = docs(c, issuer.token, 'store_issue');
      const doc = await mustOk(d.create({ values: { location: node }, lines: [{ values: { item: f.items[1], qty: '3' } }] }), 201);
      const s = await d.submit(doc.id, doc.version);
      if (s.status === 200) subs.push(s.body);
    }
    // Submit already refuses issues beyond available less open issues (3 fit).
    expect(subs.length).toBe(3);
    const res = await Promise.all(subs.map(s => docs(c, f.token, 'store_issue').act(s.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: s.lines[0].id, approve: '3' }] })));
    expect(res.map(r => r.status)).toEqual([200, 200, 200]);
    expect(await stockAt(c, f.items[1]!, node)).toMatchObject({ available: 1 });
    await expectIntegrity(c, f.tenantId);
  });

  it('a store return comes back at the issue cost even after the average moved', async () => {
    const issuer = await scoped(c, f.token, f.code, [...ISSUER_KEYS, ...docKeys('stock_adjustment')]);
    const node = f.puneStore;
    const item = f.items[0]!;
    await mustOk(api(c, f.token).post('/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: item, nodeId: node, qty: '10', unitCost: '10' }] }));
    const d = docs(c, issuer.token, 'store_issue');
    const doc = await mustOk(d.create({ values: { location: node }, lines: [{ values: { item, qty: '4' } }] }), 201);
    const s = await mustOk(d.submit(doc.id, doc.version));
    await mustOk(docs(c, f.token, 'store_issue').act(s.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: s.lines[0].id, approve: '4' }] }));
    // Average moves: receive 6 @ 30 → (60 + 180) / 12 = 20.
    const adj = await mustOk(docs(c, issuer.token, 'stock_adjustment').create({ values: { location: node }, lines: [{ values: { item, qty: '6', direction: 'in', rate: '30', reason: 'Found', location: node } }] }), 201);
    const as = await mustOk(docs(c, issuer.token, 'stock_adjustment').submit(adj.id, adj.version));
    await mustOk(docs(c, f.token, 'stock_adjustment').act(as.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: as.lines[0].id, approve: '6' }] }));
    const ret = await mustOk(inv(c, issuer.token).returnFromIssues({ submit: true, lines: [{ issueLineId: s.lines[0].id, qty: '2' }] }), 201);
    await mustOk(docs(c, f.token, 'store_return').act(ret.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: ret.lines[0].id, approve: '2' }] }));
    const mv = await c.db.selectFrom('app.stock_movement').select(['unit_cost', 'value']).where('line_id', '=', ret.lines[0].id).executeTakeFirstOrThrow();
    expect([Number(mv.unit_cost), Number(mv.value)]).toEqual([10, 20]);
    await expectIntegrity(c, f.tenantId);
  });
});

// ---------------------------------------------------------------------------------------------- backend follow-ups
describe('follow-ups: FEFO, pendingReceipt consistency, short-close / amend after receipt, cost incl. tax', () => {
  /** Pending receipt of one PO line as seen by the three read paths. */
  async function pendingViews(poId: string, poLineId: string, itemId: string, nodeId: string) {
    const rec = (await receivable(poId)).find(r => r.poLineId === poLineId);
    const doc = await mustOk(docs(c, f.token, 'po').get(poId));
    const line = doc.lines.find((l: { id: string }) => l.id === poLineId);
    const sum = await mustOk(api(c, f.token).get(`/stock/items/${itemId}/summary`));
    const node = sum.nodes.find((n: { node: { id: string } }) => n.node.id === nodeId);
    return { receivable: Number(rec?.pendingReceipt ?? 0), document: Number(line.qty.pendingReceipt), summaryOpenPo: Number(node?.openPoQty ?? 0) - base };
  }
  /** Item-summary open PO qty of other POs (static during a test) — subtracted so the views compare one PO line. */
  let base = 0;
  async function setBase(itemId: string, nodeId: string) {
    const sum = await mustOk(api(c, f.token).get(`/stock/items/${itemId}/summary`));
    base = Number(sum.nodes.find((n: { node: { id: string } }) => n.node.id === nodeId)?.openPoQty ?? 0);
  }

  it('FEFO: a batch-less issue takes the earliest expiry first, skips quarantined batches, and spans batches', async () => {
    const issuer = await scoped(c, f.token, f.code, ISSUER_KEYS);
    const item = f.items[1]!;
    const node = f.puneStore;
    await mustOk(api(c, f.token).post('/stock/opening', { asOf: '2026-04-01', rows: [
      { itemId: item, nodeId: node, qty: '4', unitCost: '1', batchNo: 'F-2029', expiryDate: '2029-01-01' },
      { itemId: item, nodeId: node, qty: '3', unitCost: '1', batchNo: 'F-2027', expiryDate: '2027-01-01' },
      { itemId: item, nodeId: node, qty: '5', unitCost: '1', batchNo: 'F-2026Q', expiryDate: '2026-12-01' },
      { itemId: item, nodeId: node, qty: '2', unitCost: '1', batchNo: 'F-NOEXP' },
    ] }));
    const q = await c.db.selectFrom('app.stock_batch').select('id').where('tenant_id', '=', f.tenantId).where('batch_no', '=', 'F-2026Q').executeTakeFirstOrThrow();
    await mustOk(api(c, f.token).post('/stock/block', { itemId: item, nodeId: node, batchId: q.id, qty: '5', reason: 'Batch on hold', direction: 'block' }));
    const d = docs(c, issuer.token, 'store_issue');
    const doc = await mustOk(d.create({ values: { location: node }, lines: [{ values: { item, qty: '6' } }] }), 201);
    const s = await mustOk(d.submit(doc.id, doc.version));
    await mustOk(docs(c, f.token, 'store_issue').act(s.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: s.lines[0].id, approve: '6' }] }));
    const mv = await c.db.selectFrom('app.stock_movement as m').leftJoin('app.stock_batch as b', 'b.id', 'm.batch_id').select(['b.batch_no', 'm.qty_out', 'm.stock_status'])
      .where('m.line_id', '=', s.lines[0].id).orderBy('m.id').execute();
    expect(mv.map(m => [m.batch_no, Number(m.qty_out), m.stock_status])).toEqual([['F-2027', 3, 'available'], ['F-2029', 3, 'available']]);
    await expectIntegrity(c, f.tenantId);
  });

  // QA5-BUG-010 (fixed): FEFO allocation included batches whose expiry date had already passed (issued first).
  it('QA5-BUG-010 (fixed) FEFO never allocates an already-expired batch', async () => {
    const issuer = await scoped(c, f.token, f.code, ISSUER_KEYS);
    const item = f.items[2]!;
    const node = f.puneStore;
    await mustOk(api(c, f.token).post('/stock/opening', { asOf: '2026-04-01', rows: [
      { itemId: item, nodeId: node, qty: '5', unitCost: '1', batchNo: 'X-EXPIRED', expiryDate: '2025-01-01' },
      { itemId: item, nodeId: node, qty: '5', unitCost: '1', batchNo: 'X-GOOD', expiryDate: '2030-01-01' },
    ] }));
    const d = docs(c, issuer.token, 'store_issue');
    const doc = await mustOk(d.create({ values: { location: node }, lines: [{ values: { item, qty: '2' } }] }), 201);
    const s = await mustOk(d.submit(doc.id, doc.version));
    await mustOk(docs(c, f.token, 'store_issue').act(s.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: s.lines[0].id, approve: '2' }] }));
    const mv = await c.db.selectFrom('app.stock_movement as m').leftJoin('app.stock_batch as b', 'b.id', 'm.batch_id').select(['b.batch_no']).where('m.line_id', '=', s.lines[0].id).execute();
    expect(mv.map(m => m.batch_no)).toEqual(['X-GOOD']);
  });

  it('QA5-BUG-010 (fixed) an expired batch named on an issue is a 409 unless stock.allow_expired_issue; batch-less issues cannot reach expired stock', async () => {
    const issuer = await scoped(c, f.token, f.code, ISSUER_KEYS);
    const item = f.items[0]!;
    const node = f.chennai;
    await mustOk(api(c, f.token).post('/stock/opening', { asOf: '2026-04-01', rows: [
      { itemId: item, nodeId: node, qty: '5', unitCost: '1', batchNo: 'E-OLD', expiryDate: '2025-06-30' },
      { itemId: item, nodeId: node, qty: '1', unitCost: '1', batchNo: 'E-NEW', expiryDate: '2031-01-01' },
    ] }));
    const d = docs(c, issuer.token, 'store_issue');
    // Named expired batch → 409 at submit.
    const named = await mustOk(d.create({ values: { location: node }, lines: [{ values: { item, qty: '1', batch_no: 'E-OLD' } }] }), 201);
    const r1 = await d.submit(named.id, named.version);
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('STOCK_BATCH_EXPIRED');
    // Batch-less: only the 1 unexpired unit counts as available.
    const many = await mustOk(d.create({ values: { location: node }, lines: [{ values: { item, qty: '3' } }] }), 201);
    expect((await d.submit(many.id, many.version)).status).toBe(409);
    // With the setting on, the named expired batch can be issued.
    await settings({ 'stock.allow_expired_issue': true });
    try {
      const again = await mustOk(d.get(named.id));
      const s = await mustOk(d.submit(again.id, again.version));
      await mustOk(docs(c, f.token, 'store_issue').act(s.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: s.lines[0].id, approve: '1' }] }));
      const mv = await c.db.selectFrom('app.stock_movement as m').leftJoin('app.stock_batch as b', 'b.id', 'm.batch_id').select(['b.batch_no']).where('m.line_id', '=', s.lines[0].id).execute();
      expect(mv.map(m => m.batch_no)).toEqual(['E-OLD']);
    } finally {
      await settings({ 'stock.allow_expired_issue': false });
    }
    await expectIntegrity(c, f.tenantId);
  });

  it('pendingReceipt agrees across receivable lines, the PO document and the item summary (partial, gate reject, RTV)', async () => {
    await setBase(f.items[0]!, f.pune);
    const po = await approvedPo(c, f, ['40']);
    const pl = po.lines[0]!.id;
    const views = () => pendingViews(po.id, pl, f.items[0]!, f.pune);
    expect(await views()).toEqual({ receivable: 40, document: 40, summaryOpenPo: 40 });
    const g = await submittedGrn(c, f, po, [[0, '25']]);
    await mustOk(decideGrn(c, f.token, g.id, 'gate', [[g.lines[0]!.id, '20', '5']], 'Short shipped'));
    await mustOk(decideGrn(c, f.token, g.id, 'store', [[g.lines[0]!.id, '20']]));
    expect(await views()).toEqual({ receivable: 20, document: 20, summaryOpenPo: 20 });
    const r = await mustOk(inv(c, f.storekeeper.token).rtvFromGrn({ submit: true, lines: [{ grnLineId: g.lines[0]!.id, qty: '8', fromStatus: 'available', reason: 'Excess' }] }), 201);
    await mustOk(docs(c, f.token, 'rtv').act(r.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: r.lines[0].id, approve: '8' }] }));
    const v = await views();
    expect({ receivable: v.receivable, document: v.document }).toEqual({ receivable: 28, document: 28 });
  });

  // QA5-BUG-011 (fixed): the item summary's openPoQty (approved − short_closed − received + rejected_at_receipt) ignored
  // `returned` with rtv.reopens_po = true, so after an RTV it disagrees with receivable lines and the PO document.
  it('QA5-BUG-011 (fixed) after an RTV (rtv.reopens_po) the item summary open PO qty matches the PO pending receipt', async () => {
    await setBase(f.items[0]!, f.pune);
    const po = await approvedPo(c, f, ['40']);
    const pl = po.lines[0]!.id;
    const g = await submittedGrn(c, f, po, [[0, '20']]);
    await gateStore(g, ['20']);
    const r = await mustOk(inv(c, f.storekeeper.token).rtvFromGrn({ submit: true, lines: [{ grnLineId: g.lines[0]!.id, qty: '8', fromStatus: 'available', reason: 'Excess' }] }), 201);
    await mustOk(docs(c, f.token, 'rtv').act(r.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: r.lines[0].id, approve: '8' }] }));
    expect(await pendingViews(po.id, pl, f.items[0]!, f.pune)).toEqual({ receivable: 28, document: 28, summaryOpenPo: 28 });
  });

  it('short-close after a partial receipt: nothing receivable, open drafts cannot be submitted, summary shows no open PO qty', async () => {
    await setBase(f.items[0]!, f.pune);
    const po = await approvedPo(c, f, ['30']);
    const pl = po.lines[0]!.id;
    const g = await submittedGrn(c, f, po, [[0, '10']]);
    await gateStore(g, ['10']);
    const draft = (await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: pl, qty: '5' }] }), 201))[0];
    const sc = await poApi(c, f.token).shortClose(po.id, { reason: 'Vendor cannot supply the rest' });
    expect(sc.status).toBe(200);
    expect(await receivable(po.id)).toEqual([]);
    const sub = await docs(c, f.storekeeper.token, 'grn').submit(draft.id, draft.version);
    expect(sub.status).toBeGreaterThanOrEqual(400);
    expect(sub.status).toBeLessThan(500);
    const v = await pendingViews(po.id, pl, f.items[0]!, f.pune);
    expect(v).toEqual({ receivable: 0, document: 0, summaryOpenPo: 0 });
    expect(await lineQty(c, pl)).toMatchObject({ received: 10, accepted: 10 });
    // Returning goods of a short-closed PO must not re-open it for receipt.
    const r = await mustOk(inv(c, f.storekeeper.token).rtvFromGrn({ submit: true, lines: [{ grnLineId: g.lines[0]!.id, qty: '4', fromStatus: 'available', reason: 'Damaged' }] }), 201);
    await mustOk(docs(c, f.token, 'rtv').act(r.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: r.lines[0].id, approve: '4' }] }));
    expect(await receivable(po.id)).toEqual([]);
  });

  it('amend after a partial receipt: no receipts while amending; the amended qty cannot go below the received qty', async () => {
    const po = await approvedPo(c, f, ['30']);
    const pl = po.lines[0]!.id;
    const g = await submittedGrn(c, f, po, [[0, '12']]);
    await gateStore(g, ['12']);
    const p = poApi(c, f.token); // the buyer role predates the partially_received view grant
    const am = await mustOk(p.amend(po.id, 'Revise quantity after first lot'));
    expect(am.statusKey).toBe('amending');
    expect((await inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: pl, qty: '1' }] })).status).toBe(400);
    const line = am.lines[0];
    const low = await mustOk(p.update(po.id, { version: am.version, values: {}, lines: [{ id: line.id, values: { ...line.values, qty: '11', schedule: [{ date: '2026-12-01', qty: '11' }] } }] }));
    const r = await p.submit(low.id, low.version);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body.errors)).toContain('already been received');
  });

  it('stock.cost_includes_tax: the receipt is valued at the PO net rate plus line tax per unit', async () => {
    await settings({ 'stock.cost_includes_tax': true });
    try {
      const po = await approvedPo(c, f, ['10'], '50'); // item 0 → GST18 → 9 tax per unit
      const g = await submittedGrn(c, f, po, [[0, '10']]);
      await gateStore(g, ['10']);
      const mv = await c.db.selectFrom('app.stock_movement').select(['unit_cost', 'value']).where('document_id', '=', g.id).executeTakeFirstOrThrow();
      expect([Number(mv.unit_cost), Number(mv.value)]).toEqual([59, 590]);
    } finally {
      await settings({ 'stock.cost_includes_tax': false });
    }
    const po2 = await approvedPo(c, f, ['10'], '50');
    const g2 = await submittedGrn(c, f, po2, [[0, '10']]);
    await gateStore(g2, ['10']);
    const mv2 = await c.db.selectFrom('app.stock_movement').select(['unit_cost']).where('document_id', '=', g2.id).executeTakeFirstOrThrow();
    expect(Number(mv2.unit_cost)).toBe(50);
  });
});

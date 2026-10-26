/**
 * Phase 5 issue request → store issue → store return: issuable lines, partial and multiple issues, pending and
 * available checks (row locks), direct issues per flow.issue.without_indent, returns ≤ issued − returned (to
 * available or quarantine, valued at the issue cost), permissions and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { docs, scoped } from './procurement-helpers';
import { grnTenant, GrnFixture, inv, ISSUER_KEYS, lineQty, REQUESTER_KEYS, stockAt } from './grn-helpers';

let c: Ctx;
let f: GrnFixture;
let issuer: { token: string; userId: string };
let requester: { token: string; userId: string };

async function opening(itemId: string, qty: string, unitCost = '20', batchNo?: string) {
  return mustOk(api(c, f.token).post('/stock/opening', { asOf: '2026-04-01', rows: [{ itemId, nodeId: f.pune, qty, unitCost, ...(batchNo ? { batchNo } : {}) }] }));
}

async function approvedRequest(qtys: string[], items = f.items) {
  const d = docs(c, requester.token, 'issue_request');
  const doc = await mustOk(d.create({ values: { location: f.pune, department: f.department, purpose: 'Line maintenance' }, lines: qtys.map((q, i) => ({ values: { item: items[i % items.length], qty: q } })) }), 201);
  const sub = await mustOk(d.submit(doc.id, doc.version));
  expect(sub.statusKey).toBe('waiting_approve');
  return mustOk(docs(c, f.token, 'issue_request').act(sub.id, { action: 'decide', stageKey: 'approve', decisions: sub.lines.map((l: { id: string }, i: number) => ({ lineId: l.id, approve: qtys[i] })) }));
}

async function approveDoc(type: string, d: { id: string; lines: { id: string; values: { qty: string } }[] }) {
  return mustOk(docs(c, f.token, type).act(d.id, { action: 'decide', stageKey: 'approve', decisions: d.lines.map(l => ({ lineId: l.id, approve: String(Number(l.values.qty)) })) }));
}

beforeAll(async () => {
  c = await bootApp();
  f = await grnTenant(c);
  issuer = await scoped(c, f.token, f.code, ISSUER_KEYS);
  requester = await scoped(c, f.token, f.code, REQUESTER_KEYS);
  await opening(f.items[0]!, '100');
  await opening(f.items[1]!, '10');
});
afterAll(async () => closeApp(c));

describe('issue against requests', () => {
  it('partial and multiple issues; issued on request lines; stock out at issue cost', async () => {
    const req = await approvedRequest(['30']);
    const rl = req.lines[0].id;
    const page = await mustOk(inv(c, issuer.token).issuable(`request=${req.id}`));
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ requestLineId: rl, requested: '30', issued: '0', pendingIssue: '30', available: '100' });
    expect(page.data[0].location.id).toBe(f.pune);

    const i1 = await mustOk(inv(c, issuer.token).issueFromRequests({ submit: true, lines: [{ requestLineId: rl, qty: '12' }] }), 201);
    expect(i1.statusKey).toBe('waiting_approve');
    expect(i1.values.department).toBe(f.department);
    // Pending in an open issue is not issuable again.
    expect((await mustOk(inv(c, issuer.token).issuable(`request=${req.id}`))).data[0].pendingIssue).toBe('18');
    await approveDoc('store_issue', i1);
    expect((await stockAt(c, f.items[0]!, f.pune)).available).toBe(88);
    expect(await lineQty(c, rl)).toMatchObject({ issued: 12 });
    expect(await lineQty(c, i1.lines[0].id)).toMatchObject({ issued: 12 });
    const mv = await c.db.selectFrom('app.stock_movement').selectAll().where('line_id', '=', i1.lines[0].id).executeTakeFirstOrThrow();
    expect(mv).toMatchObject({ movement_type: 'issue', stock_status: 'available' });
    expect(Number(mv.unit_cost)).toBe(20);

    const i2 = await mustOk(inv(c, issuer.token).issueFromRequests({ submit: true, lines: [{ requestLineId: rl, qty: '18' }] }), 201);
    await approveDoc('store_issue', i2);
    expect(await lineQty(c, rl)).toMatchObject({ issued: 30 });
    expect((await mustOk(inv(c, issuer.token).issuable(`request=${req.id}`))).data).toHaveLength(0);
  });

  it('cannot exceed the pending qty: 400 on create, 409 at submit for concurrent drafts', async () => {
    const req = await approvedRequest(['10']);
    const rl = req.lines[0].id;
    expect((await inv(c, issuer.token).issueFromRequests({ lines: [{ requestLineId: rl, qty: '10.5' }] })).status).toBe(400);
    const a = await mustOk(inv(c, issuer.token).issueFromRequests({ lines: [{ requestLineId: rl, qty: '7' }] }), 201);
    const b = await mustOk(inv(c, issuer.token).issueFromRequests({ lines: [{ requestLineId: rl, qty: '7' }] }), 201);
    const res = await Promise.all([a, b].map(d => docs(c, issuer.token, 'store_issue').submit(d.id, d.version)));
    expect(res.map(r => r.status).sort()).toEqual([200, 409]);
    expect(res.find(r => r.status === 409)!.body.code).toBe('QTY_EXCEEDS_REMAINING');
  });

  it('cannot exceed the available stock (less other open issues) at the issuing location', async () => {
    const req = await approvedRequest(['8', '8'], [f.items[1]!]);
    const [l1, l2] = req.lines.map((l: { id: string }) => l.id);
    await mustOk(inv(c, issuer.token).issueFromRequests({ submit: true, lines: [{ requestLineId: l1, qty: '8' }] }), 201);
    const r = await inv(c, issuer.token).issueFromRequests({ submit: true, lines: [{ requestLineId: l2, qty: '3' }] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STOCK_INSUFFICIENT');
    expect(r.body.meta).toMatchObject({ available: '2', asked: '3' });
    await mustOk(inv(c, issuer.token).issueFromRequests({ submit: true, lines: [{ requestLineId: l2, qty: '2' }] }), 201);
  });

  it('direct issues follow flow.issue.without_indent', async () => {
    const d = docs(c, issuer.token, 'store_issue');
    const direct = await mustOk(d.create({ values: { location: f.pune, issued_to: 'Shift B' }, lines: [{ values: { item: f.items[0], qty: '1' } }] }), 201);
    const sub = await mustOk(d.submit(direct.id, direct.version));
    await approveDoc('store_issue', sub);
    await mustOk(inv(c, f.token).settings({ 'flow.issue.without_indent': false }));
    try {
      const r = await d.create({ values: { location: f.pune }, lines: [{ values: { item: f.items[0], qty: '1' } }] });
      expect(r.status).toBe(400);
      expect(r.body.errors[0].path).toBe('lines.0.request_line');
    } finally {
      await mustOk(inv(c, f.token).settings({ 'flow.issue.without_indent': true }));
    }
  });
});

describe('availability and FEFO', () => {
  it('issuable available is the issuing node only; a batch-less issue is allocated FEFO across batches; the return goes back to the issued batch', async () => {
    const item = f.items[2]!;
    const open = (rows: Record<string, unknown>[]) => mustOk(api(c, f.token).post('/stock/opening', { asOf: '2026-04-01', rows }));
    await open([
      { itemId: item, nodeId: f.pune, qty: '5', unitCost: '10', batchNo: 'P-LATE', expiryDate: '2028-01-01' },
      { itemId: item, nodeId: f.pune, qty: '5', unitCost: '10', batchNo: 'P-EARLY', expiryDate: '2027-01-01' },
      { itemId: item, nodeId: f.puneStore, qty: '50', unitCost: '10' },
    ]);
    const req = await approvedRequest(['7'], [item]);
    const page = await mustOk(inv(c, issuer.token).issuable(`request=${req.id}`));
    expect(page.data[0].available).toBe('10'); // the child store's 50 is not at the issuing node
    expect((await inv(c, issuer.token).issueFromRequests({ submit: true, lines: [{ requestLineId: req.lines[0].id, qty: '11' }] })).status).toBe(400);
    const iss = await mustOk(inv(c, issuer.token).issueFromRequests({ submit: true, lines: [{ requestLineId: req.lines[0].id, qty: '7' }] }), 201);
    await approveDoc('store_issue', iss);
    const mv = await c.db.selectFrom('app.stock_movement as m').innerJoin('app.stock_batch as b', 'b.id', 'm.batch_id')
      .select(['b.batch_no', 'm.qty_out']).where('m.line_id', '=', iss.lines[0].id).orderBy('m.id').execute();
    expect(mv.map(m => [m.batch_no, Number(m.qty_out)])).toEqual([['P-EARLY', 5], ['P-LATE', 2]]);
    expect(await lineQty(c, iss.lines[0].id)).toMatchObject({ issued: 7 });
    const ret = await mustOk(inv(c, issuer.token).returnFromIssues({ submit: true, lines: [{ issueLineId: iss.lines[0].id, qty: '1' }] }), 201);
    await approveDoc('store_return', ret);
    const back = await c.db.selectFrom('app.stock_movement as m').innerJoin('app.stock_batch as b', 'b.id', 'm.batch_id').select('b.batch_no')
      .where('m.line_id', '=', ret.lines[0].id).executeTakeFirstOrThrow();
    expect(back.batch_no).toBe('P-LATE');
  });
});

describe('store returns', () => {
  it('partial and multiple returns ≤ issued − returned; to available or quarantine at the issue cost', async () => {
    const req = await approvedRequest(['20']);
    const i = await mustOk(inv(c, issuer.token).issueFromRequests({ submit: true, lines: [{ requestLineId: req.lines[0].id, qty: '20' }] }), 201);
    await approveDoc('store_issue', i);
    const il = i.lines[0].id;
    const page = await mustOk(inv(c, issuer.token).returnable(`issue=${i.id}`));
    expect(page.data[0]).toMatchObject({ issueLineId: il, issued: '20', returned: '0', returnable: '20' });
    const before = await stockAt(c, f.items[0]!, f.pune);
    const r1 = await mustOk(inv(c, issuer.token).returnFromIssues({ submit: true, lines: [{ issueLineId: il, qty: '5', reason: 'Excess' }] }), 201);
    await approveDoc('store_return', r1);
    const r2 = await mustOk(inv(c, issuer.token).returnFromIssues({ submit: true, lines: [{ issueLineId: il, qty: '3', status: 'quarantine', reason: 'Damaged' }] }), 201);
    await approveDoc('store_return', r2);
    const after = await stockAt(c, f.items[0]!, f.pune);
    expect(after.available - before.available).toBe(5);
    expect(after.quarantine - before.quarantine).toBe(3);
    expect(await lineQty(c, il)).toMatchObject({ issued: 20, returned: 8 });
    const mv = await c.db.selectFrom('app.stock_movement').selectAll().where('line_id', '=', r1.lines[0].id).executeTakeFirstOrThrow();
    expect(mv.movement_type).toBe('return');
    expect(Number(mv.unit_cost)).toBe(20);
    expect((await mustOk(inv(c, issuer.token).returnable(`issue=${i.id}`))).data[0].returnable).toBe('12');
    expect((await inv(c, issuer.token).returnFromIssues({ lines: [{ issueLineId: il, qty: '12.5' }] })).status).toBe(400);
    // Concurrent returns over the remaining 12: one fits.
    const a = await mustOk(inv(c, issuer.token).returnFromIssues({ lines: [{ issueLineId: il, qty: '8' }] }), 201);
    const b = await mustOk(inv(c, issuer.token).returnFromIssues({ lines: [{ issueLineId: il, qty: '8' }] }), 201);
    const res = await Promise.all([a, b].map(d => docs(c, issuer.token, 'store_return').submit(d.id, d.version)));
    expect(res.map(r => r.status).sort()).toEqual([200, 409]);
  });

  it('a return must reference an issue line of the same item', async () => {
    const d = docs(c, issuer.token, 'store_return');
    const draft = await mustOk(d.create({ values: { location: f.pune }, lines: [{ values: { item: f.items[0], qty: '1' } }] }), 201);
    const r = await d.submit(draft.id, draft.version);
    expect(r.status).toBe(400);
    expect(r.body.errors[0].path).toBe('lines.0.issue_line');
  });
});

describe('permissions and isolation', () => {
  it('a requester cannot issue; another tenant sees none of the lines', async () => {
    const req = await approvedRequest(['2']);
    expect((await inv(c, requester.token).issuable()).status).toBe(403);
    expect((await inv(c, requester.token).issueFromRequests({ lines: [{ requestLineId: req.lines[0].id, qty: '1' }] })).status).toBe(403);
    const other = await grnTenant(c);
    const page = await mustOk(inv(c, other.token).issuable());
    expect(page.data.find((l: { requestId: string }) => l.requestId === req.id)).toBeUndefined();
    expect((await inv(c, other.token).issueFromRequests({ lines: [{ requestLineId: req.lines[0].id, qty: '1' }] })).status).toBe(400);
    expect((await docs(c, other.token, 'issue_request').get(req.id)).status).toBe(404);
  });
});

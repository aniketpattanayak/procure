/**
 * QA Phase 5 — security: 403 per action key on every stock / inventory endpoint, value hiding without
 * stock:action.view_value, status-view hiding, data scope by location subtree, plan feature gating and cross-tenant
 * isolation on every new endpoint and document type (ids of tenant A presented by tenant B).
 *
 * Known bugs are `it.fails` with their id (docs/qa/phase-5-report.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { docs, scoped } from './procurement-helpers';
import { approvedPo, decideGrn, grnTenant, GrnFixture, inv, ISSUER_KEYS, REQUESTER_KEYS, STOREKEEPER_KEYS, submittedGrn } from './grn-helpers';
import { approveAll, clerk, CLERK_KEYS, docKeys, opening, STOCK_VIEW, storeDoc } from './qa-phase5-helpers';
import { limitedUser, stockWorld, StockWorld } from './stock-helpers';

let c: Ctx;

beforeAll(async () => { c = await bootApp(); }, 120_000);
afterAll(async () => closeApp(c));

// ---------------------------------------------------------------------------------------------- per action key
describe('403 per action key', () => {
  let w: StockWorld;
  let ruleId: string;
  beforeAll(async () => {
    w = await stockWorld(c);
    await mustOk(opening(c, w.adminToken, [{ itemId: w.items[0], nodeId: w.store, qty: '10', unitCost: '2' }]));
    ruleId = (await mustOk(api(c, w.adminToken).post('/stock/reorder-rules', { itemId: w.items[0], nodeId: w.store, minQty: '1', reorderQty: '5' }), 201)).id;
  });

  const calls = (w: StockWorld, ruleId: string) => ({
    'GET balances': ['stock:action.view', (a: ReturnType<typeof api>) => a.get('/stock/balances')],
    'GET ledger': ['stock:action.view', (a: ReturnType<typeof api>) => a.get('/stock/ledger')],
    'GET summary': ['stock:action.view', (a: ReturnType<typeof api>) => a.get(`/stock/items/${w.items[0]}/summary`)],
    'GET reorder': ['stock:action.view', (a: ReturnType<typeof api>) => a.get('/stock/reorder')],
    'GET valuation': ['stock:action.view_value', (a: ReturnType<typeof api>) => a.get('/stock/valuation')],
    'POST opening': ['stock:action.opening', (a: ReturnType<typeof api>) => a.post('/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: w.items[2], nodeId: w.bin, qty: '1', unitCost: '1' }] })],
    'POST block': ['stock:action.block', (a: ReturnType<typeof api>) => a.post('/stock/block', { itemId: w.items[0], nodeId: w.store, qty: '1', reason: 'Hold it', direction: 'block' })],
    'GET rules': ['stock:action.reorder', (a: ReturnType<typeof api>) => a.get('/stock/reorder-rules')],
    'GET rule': ['stock:action.reorder', (a: ReturnType<typeof api>) => a.get(`/stock/reorder-rules/${ruleId}`)],
    'POST rule': ['stock:action.reorder', (a: ReturnType<typeof api>) => a.post('/stock/reorder-rules', { itemId: w.items[1], nodeId: w.bin, minQty: '1', reorderQty: '2' })],
    'PUT rule': ['stock:action.reorder', (a: ReturnType<typeof api>) => a.put(`/stock/reorder-rules/${ruleId}`, { itemId: w.items[0], nodeId: w.store, minQty: '1', reorderQty: '6' })],
    'DELETE rule': ['stock:action.reorder', (a: ReturnType<typeof api>) => a.del(`/stock/reorder-rules/${ruleId}`)],
    'POST snapshot': ['doc.stock_count:action.add', (a: ReturnType<typeof api>) => a.post('/stock/counts/snapshot', { nodeId: w.store })],
    'GET receivable-po-lines': ['doc.grn:action.add', (a: ReturnType<typeof api>) => a.get('/inventory/receivable-po-lines')],
    'POST grn/from-po': ['doc.grn:action.add', (a: ReturnType<typeof api>) => a.post('/inventory/grn/from-po', { lines: [{ poLineId: w.items[0], qty: '1' }] })],
    'GET returnable-grn-lines': ['doc.rtv:action.add', (a: ReturnType<typeof api>) => a.get('/inventory/returnable-grn-lines')],
    'POST rtv/from-grn': ['doc.rtv:action.add', (a: ReturnType<typeof api>) => a.post('/inventory/rtv/from-grn', { lines: [{ grnLineId: w.items[0], qty: '1' }] })],
    'GET issuable-lines': ['doc.store_issue:action.add', (a: ReturnType<typeof api>) => a.get('/inventory/issuable-lines')],
    'POST issues/from-requests': ['doc.store_issue:action.add', (a: ReturnType<typeof api>) => a.post('/inventory/issues/from-requests', { lines: [{ requestLineId: w.items[0], qty: '1' }] })],
    'GET returnable-lines': ['doc.store_return:action.add', (a: ReturnType<typeof api>) => a.get('/inventory/returnable-lines')],
    'POST returns/from-issues': ['doc.store_return:action.add', (a: ReturnType<typeof api>) => a.post('/inventory/returns/from-issues', { lines: [{ issueLineId: w.items[0], qty: '1' }] })],
  } as Record<string, [string, (a: ReturnType<typeof api>) => Promise<{ status: number; body: { code?: string } }>]>);

  it('a user with every key EXCEPT the endpoint\'s own key gets 403 (and never a 500)', async () => {
    const all = [...STOCK_VIEW, 'stock:action.view_value', 'stock:action.opening', 'stock:action.block', 'stock:action.reorder',
      ...docKeys('stock_count'), ...STOREKEEPER_KEYS, ...ISSUER_KEYS];
    const got: string[] = [];
    const users = new Map<string, { token: string }>();
    for (const [name, [key, call]] of Object.entries(calls(w, ruleId))) {
      if (!users.has(key)) users.set(key, await limitedUser(c, w, all.filter(k => k !== key)));
      const u = users.get(key)!;
      const r = await call(api(c, u.token));
      if (r.status !== 403) got.push(`${name} → ${r.status}`);
    }
    expect(got).toEqual([]);
  });

  it('a user with no stock / inventory keys at all gets 403 everywhere', async () => {
    const u = await limitedUser(c, w, ['doc.indent:action.view']);
    const got: string[] = [];
    for (const [name, [, call]] of Object.entries(calls(w, ruleId))) {
      const r = await call(api(c, u.token));
      if (r.status !== 403) got.push(`${name} → ${r.status}`);
    }
    expect(got).toEqual([]);
  });

  it('a tenant whose plan lacks `store` / `grn`: even its admin gets 403 on stock and inventory endpoints', async () => {
    const nf = await stockWorld(c, { features: ['indent', 'purchase'] });
    const got: string[] = [];
    for (const [name, [, call]] of Object.entries(calls(nf, '00000000-0000-4000-8000-000000000000'))) {
      const r = await call(api(c, nf.adminToken));
      if (r.status !== 403) got.push(`${name} → ${r.status}`);
    }
    expect(got).toEqual([]);
    expect((await api(c, nf.adminToken).get('/docs/stock_transfer')).status).not.toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------- values and statuses
describe('value hiding and status views', () => {
  let w: StockWorld;
  beforeAll(async () => {
    w = await stockWorld(c, { features: ['indent', 'purchase', 'store', 'reports', 'report_builder'] });
    await mustOk(opening(c, w.adminToken, [{ itemId: w.items[0], nodeId: w.store, qty: '10', unitCost: '3' }]));
    await mustOk(api(c, w.adminToken).post('/stock/block', { itemId: w.items[0], nodeId: w.store, qty: '4', reason: 'QA hold', direction: 'block' }));
  });

  it('no view_value: values null on balances, ledger, summary and the block response; report sources drop value fields', async () => {
    const u = await limitedUser(c, w, [...STOCK_VIEW, 'stock:action.block', 'reports:action.view', 'reports:action.build']);
    const a = api(c, u.token);
    const b = await mustOk(a.get('/stock/balances'));
    expect(b.data.every((r: { value: unknown; avgCost: unknown }) => r.value === null && r.avgCost === null)).toBe(true);
    const l = await mustOk(a.get('/stock/ledger'));
    expect(l.data.every((r: { value: unknown; unitCost: unknown }) => r.value === null && r.unitCost === null)).toBe(true);
    const s = await mustOk(a.get(`/stock/items/${w.items[0]}/summary`));
    expect([s.totals.value, ...s.nodes.map((n: { value: unknown; avgCost: unknown }) => [n.value, n.avgCost]).flat()].every(v => v === null)).toBe(true);
    const blk = await mustOk(a.post('/stock/block', { itemId: w.items[0], nodeId: w.store, qty: '1', reason: 'QA hold', direction: 'block' }));
    expect(blk.every((m: { value: unknown; unitCost: unknown }) => m.value === null && m.unitCost === null)).toBe(true);
    // A report that asks for `value` anyway is refused, not silently answered.
    const rep = await a.post('/reports/preview', { definition: { source: { kind: 'engine', key: 'stock_ledger' }, columns: [{ field: 'item.name' }, { field: 'value' }] }, params: {} });
    expect(rep.status).toBe(400);
    const rep2 = await a.post('/reports/preview', { definition: { source: { kind: 'engine', key: 'stock_balance' }, columns: [{ field: 'item.name' }], filters: [{ field: 'value', op: 'gt', value: '0' }] }, params: {} });
    expect(rep2.status).toBe(400);
  });

  it('status views: without quarantine the bucket is 0 in balances and summary, its ledger rows are absent, the filter is 403, reports omit it', async () => {
    const u = await limitedUser(c, w, ['stock', 'stock:action.view', 'stock:view.available', 'stock:action.view_value', 'reports:action.view', 'reports:action.build']);
    const a = api(c, u.token);
    const b = await mustOk(a.get(`/stock/balances?item=${w.items[0]}`));
    expect(b.data[0]).toMatchObject({ quarantine: '0', total: b.data[0].available });
    expect(Number(b.data[0].value)).toBe(Number(b.data[0].available) * 3);
    const s = await mustOk(a.get(`/stock/items/${w.items[0]}/summary`));
    expect(s.totals.quarantine).toBe('0');
    const l = await mustOk(a.get(`/stock/ledger?item=${w.items[0]}`));
    expect(l.data.some((r: { status: string }) => r.status === 'quarantine')).toBe(false);
    expect((await a.get('/stock/balances?status=quarantine')).status).toBe(403);
    const rep = await mustOk(a.post('/reports/preview', { definition: { source: { kind: 'engine', key: 'stock_ledger' }, columns: [{ field: 'status' }, { field: 'qty_in', aggregate: 'sum' }], groupBy: ['status'] }, params: {} }));
    expect(JSON.stringify(rep.rows)).not.toContain('quarantine');
    // No status view at all: empty pages, not errors.
    const none = await limitedUser(c, w, ['stock', 'stock:action.view']);
    expect((await mustOk(api(c, none.token).get('/stock/balances'))).data).toEqual([]);
    expect((await mustOk(api(c, none.token).get('/stock/ledger'))).data).toEqual([]);
  });

  // QA5-BUG-005: /stock/valuation sums every status regardless of the viewer's stock:view.<status> keys, so a user who
  // may not see quarantine stock learns its value (balances / summary / reports all hide it).
  it('QA5-BUG-005 (fixed) valuation respects status views', async () => {
    const u = await limitedUser(c, w, ['stock', 'stock:action.view', 'stock:view.available', 'stock:action.view_value']);
    const val = await mustOk(api(c, u.token).get('/stock/valuation'));
    const bal = await mustOk(api(c, u.token).get('/stock/balances'));
    const balValue = bal.data.reduce((t: number, r: { value: string }) => t + Number(r.value), 0);
    expect(Number(val.totalValue)).toBe(balValue);
  });
});

// ---------------------------------------------------------------------------------------------- data scope
describe('data scope by location subtree', () => {
  let w: StockWorld;
  let u: { token: string };
  beforeAll(async () => {
    w = await stockWorld(c);
    await mustOk(opening(c, w.adminToken, [
      { itemId: w.items[0], nodeId: w.plant, qty: '1', unitCost: '1' },
      { itemId: w.items[0], nodeId: w.store, qty: '2', unitCost: '1' },
      { itemId: w.items[0], nodeId: w.bin, qty: '3', unitCost: '1' },
      { itemId: w.items[0], nodeId: w.otherPlant, qty: '4', unitCost: '1' },
    ]));
    await mustOk(api(c, w.adminToken).post('/stock/reorder-rules', { itemId: w.items[0], nodeId: w.plant, minQty: '100', reorderQty: '5' }), 201);
    await mustOk(api(c, w.adminToken).post('/stock/reorder-rules', { itemId: w.items[0], nodeId: w.bin, minQty: '100', reorderQty: '5' }), 201);
    u = await limitedUser(c, w, [...STOCK_VIEW, 'stock:action.view_value', 'stock:action.block', 'stock:action.opening', 'stock:action.reorder', ...docKeys('stock_count')], w.store);
  });

  it('reads: balances, ledger, summary, valuation, rules and below-min only show the store subtree (not its parent plant)', async () => {
    const a = api(c, u.token);
    const nodes = (rows: { node: { id: string } }[]) => [...new Set(rows.map(r => r.node.id))].sort();
    const inScope = [w.store, w.bin].sort();
    expect(nodes((await mustOk(a.get('/stock/balances'))).data)).toEqual(inScope);
    expect(nodes((await mustOk(a.get(`/stock/ledger?item=${w.items[0]}`))).data)).toEqual(inScope);
    expect(nodes((await mustOk(a.get(`/stock/items/${w.items[0]}/summary`))).nodes)).toEqual(inScope);
    const val = await mustOk(a.get('/stock/valuation'));
    expect(nodes(val.rows)).toEqual(inScope);
    expect(val.totalValue).toBe('5');
    expect(nodes(await mustOk(a.get('/stock/reorder-rules')))).toEqual([w.bin]);
    expect(nodes(await mustOk(a.get('/stock/reorder')))).toEqual([w.bin]);
    for (const p of [`/stock/balances?node=${w.plant}`, `/stock/ledger?node=${w.plant}`, `/stock/valuation?node=${w.plant}`, `/stock/reorder?node=${w.plant}`]) {
      expect((await a.get(p)).status, p).toBe(404);
    }
  });

  it('writes outside the subtree are refused: block, opening, rules, count snapshot', async () => {
    const a = api(c, u.token);
    expect((await a.post('/stock/block', { itemId: w.items[0], nodeId: w.plant, qty: '1', reason: 'Out of scope', direction: 'block' })).status).toBe(404);
    expect((await a.post('/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: w.items[1], nodeId: w.plant, qty: '1', unitCost: '1' }] })).status).toBe(400);
    expect((await a.post('/stock/reorder-rules', { itemId: w.items[1], nodeId: w.otherPlant, minQty: '1', reorderQty: '1' })).status).toBe(404);
    const plantRule = (await mustOk(api(c, w.adminToken).get('/stock/reorder-rules'))).find((r: { node: { id: string } }) => r.node.id === w.plant);
    expect((await a.get(`/stock/reorder-rules/${plantRule.id}`)).status).toBe(404);
    expect((await a.put(`/stock/reorder-rules/${plantRule.id}`, { itemId: w.items[0], nodeId: w.store, minQty: '1', reorderQty: '1' })).status).toBe(404);
    expect((await a.del(`/stock/reorder-rules/${plantRule.id}`)).status).toBe(404);
    // Moving an in-scope rule to an out-of-scope node is refused too.
    const binRule = (await mustOk(a.get('/stock/reorder-rules')))[0];
    expect((await a.put(`/stock/reorder-rules/${binRule.id}`, { itemId: w.items[0], nodeId: w.plant, minQty: '1', reorderQty: '1' })).status).toBe(404);
    expect((await a.post('/stock/counts/snapshot', { nodeId: w.plant, includeChildren: true })).status).toBe(404);
    // Snapshot of the store with children counts store + bin only.
    const snap = await mustOk(a.post('/stock/counts/snapshot', { nodeId: w.store, includeChildren: true }), 201);
    expect(snap.lines.map((l: { values: { location: string } }) => l.values.location).sort()).toEqual([w.store, w.bin].sort());
  });

  it('store documents: a clerk scoped to the store cannot raise a transfer FROM, or an adjustment line AT, a node outside scope', async () => {
    const clk = await clerk(c, w, CLERK_KEYS, w.store);
    const tr = await docs(c, clk.token, 'stock_transfer').create({ values: { location: w.otherPlant, to_location: w.store }, lines: [{ values: { item: w.items[0], qty: '1' } }] });
    expect([400, 403, 404]).toContain(tr.status);
    const adj = await docs(c, clk.token, 'stock_adjustment').create({ values: { location: w.store }, lines: [{ values: { item: w.items[0], qty: '1', direction: 'out', reason: 'x', location: w.otherPlant } }] });
    expect([400, 403, 404]).toContain(adj.status);
  });
});

// ---------------------------------------------------------------------------------------------- cross-tenant
describe('cross-tenant isolation on every Phase 5 endpoint and document type', () => {
  let A: GrnFixture;
  let B: StockWorld;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    A = await grnTenant(c);
    const a = api(c, A.token);
    await mustOk(a.post('/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: A.items[1], nodeId: A.pune, qty: '50', unitCost: '5', batchNo: 'A-LOT' }] }));
    const po = await approvedPo(c, A, ['20']);
    const g = await submittedGrn(c, A, po, [[0, '10']]);
    await mustOk(decideGrn(c, A.token, g.id, 'gate', [[g.lines[0]!.id, '10']]));
    await mustOk(decideGrn(c, A.token, g.id, 'store', [[g.lines[0]!.id, '10']]));
    const rtv = await mustOk(inv(c, A.storekeeper.token).rtvFromGrn({ lines: [{ grnLineId: g.lines[0]!.id, qty: '1' }] }), 201);
    const requester = await scoped(c, A.token, A.code, REQUESTER_KEYS);
    const issuer = await scoped(c, A.token, A.code, ISSUER_KEYS);
    const rq = docs(c, requester.token, 'issue_request');
    const req0 = await mustOk(rq.create({ values: { location: A.pune, department: A.department, purpose: 'x' }, lines: [{ values: { item: A.items[1], qty: '5' } }] }), 201);
    const req = await mustOk(rq.submit(req0.id, req0.version));
    await mustOk(docs(c, A.token, 'issue_request').act(req.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: req.lines[0].id, approve: '5' }] }));
    const iss = await mustOk(inv(c, issuer.token).issueFromRequests({ submit: true, lines: [{ requestLineId: req.lines[0].id, qty: '2' }] }), 201);
    await mustOk(docs(c, A.token, 'store_issue').act(iss.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: iss.lines[0].id, approve: '2' }] }));
    const ret = await mustOk(inv(c, issuer.token).returnFromIssues({ lines: [{ issueLineId: iss.lines[0].id, qty: '1' }] }), 201);
    const rule = await mustOk(a.post('/stock/reorder-rules', { itemId: A.items[1], nodeId: A.pune, minQty: '1', reorderQty: '1' }), 201);
    const batch = await c.db.selectFrom('app.stock_batch').select('id').where('tenant_id', '=', A.tenantId).where('batch_no', '=', 'A-LOT').executeTakeFirstOrThrow();
    Object.assign(ids, {
      item: A.items[1], node: A.pune, po: po.id, poLine: po.lines[0]!.id, grn: g.id, grnLine: g.lines[0]!.id, rtv: rtv.id, request: req.id, requestLine: req.lines[0].id,
      issue: iss.id, issueLine: iss.lines[0].id, ret: ret.id, rule: rule.id, batch: batch.id, vendor: A.vendors[0]!,
    });
    B = await stockWorld(c, { features: ['indent', 'purchase', 'store', 'grn', 'workflow_designer'] });
    await mustOk(opening(c, B.adminToken, [{ itemId: B.items[0], nodeId: B.store, qty: '5', unitCost: '1' }]));
  }, 240_000);

  it('stock endpoints: tenant B never reads or writes tenant A\'s stock through A\'s ids', async () => {
    const b = api(c, B.adminToken);
    const expectNot2xx: [string, () => Promise<{ status: number; body: unknown }>][] = [
      ['balances node', () => b.get(`/stock/balances?node=${ids.node}`)],
      ['ledger node', () => b.get(`/stock/ledger?node=${ids.node}`)],
      ['summary', () => b.get(`/stock/items/${ids.item}/summary`)],
      ['valuation node', () => b.get(`/stock/valuation?node=${ids.node}`)],
      ['reorder node', () => b.get(`/stock/reorder?node=${ids.node}`)],
      ['rule get', () => b.get(`/stock/reorder-rules/${ids.rule}`)],
      ['rule put', () => b.put(`/stock/reorder-rules/${ids.rule}`, { itemId: B.items[0], nodeId: B.store, minQty: '1', reorderQty: '1' })],
      ['rule delete', () => b.del(`/stock/reorder-rules/${ids.rule}`)],
      ['rule create with A item', () => b.post('/stock/reorder-rules', { itemId: ids.item, nodeId: B.store, minQty: '1', reorderQty: '1' })],
      ['rule create with A node', () => b.post('/stock/reorder-rules', { itemId: B.items[0], nodeId: ids.node, minQty: '1', reorderQty: '1' })],
      ['opening A item', () => b.post('/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: ids.item, nodeId: B.bin, qty: '1', unitCost: '1' }] })],
      ['opening A node', () => b.post('/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: B.items[1], nodeId: ids.node, qty: '1', unitCost: '1' }] })],
      ['block A item', () => b.post('/stock/block', { itemId: ids.item, nodeId: B.store, qty: '1', reason: 'Probe', direction: 'block' })],
      ['block A node', () => b.post('/stock/block', { itemId: B.items[0], nodeId: ids.node, qty: '1', reason: 'Probe', direction: 'block' })],
      ['block A batch', () => b.post('/stock/block', { itemId: B.items[0], nodeId: B.store, batchId: ids.batch, qty: '1', reason: 'Probe', direction: 'block' })],
      ['snapshot A node', () => b.post('/stock/counts/snapshot', { nodeId: ids.node })],
      ['snapshot A items', () => b.post('/stock/counts/snapshot', { nodeId: B.store, itemIds: [ids.item] })],
    ];
    const leaks: string[] = [];
    for (const [name, p] of expectNot2xx) {
      const r = await p();
      if (r.status < 400 || r.status >= 500) leaks.push(`${name} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
    expect(leaks).toEqual([]);
    // Filters by A's ids answer an empty page (never A's rows).
    for (const p of [`/stock/balances?item=${ids.item}`, `/stock/ledger?item=${ids.item}`, `/stock/ledger?document=${ids.grn}`]) {
      expect((await mustOk(b.get(p))).data, p).toEqual([]);
    }
    expect((await mustOk(b.get('/stock/valuation'))).rows.map((r: { item: { id: string } }) => r.item.id)).not.toContain(ids.item);
    // A's rule survived B's PUT / DELETE attempts.
    expect((await api(c, A.token).get(`/stock/reorder-rules/${ids.rule}`)).status).toBe(200);
  });

  it('inventory endpoints and documents: A\'s PO / GRN / RTV / request / issue / return ids are invisible to B', async () => {
    const b = api(c, B.adminToken);
    const ib = inv(c, B.adminToken);
    expect((await mustOk(ib.receivable(`po=${ids.po}`))).data).toEqual([]);
    expect((await mustOk(ib.receivable(''))).data.map((r: { poLineId: string }) => r.poLineId)).not.toContain(ids.poLine);
    expect((await mustOk(ib.returnableGrn(`grn=${ids.grn}`))).data).toEqual([]);
    expect((await mustOk(ib.issuable(`request=${ids.request}`))).data).toEqual([]);
    expect((await mustOk(ib.returnable(`issue=${ids.issue}`))).data).toEqual([]);
    const writes: [string, () => Promise<{ status: number; body: unknown }>][] = [
      ['grn from A po line', () => ib.fromPo({ lines: [{ poLineId: ids.poLine, qty: '1' }] })],
      ['rtv from A grn line', () => ib.rtvFromGrn({ lines: [{ grnLineId: ids.grnLine, qty: '1' }] })],
      ['issue from A request line', () => ib.issueFromRequests({ lines: [{ requestLineId: ids.requestLine, qty: '1' }] })],
      ['return from A issue line', () => ib.returnFromIssues({ lines: [{ issueLineId: ids.issueLine, qty: '1' }] })],
      ['grn doc A', () => b.get(`/docs/grn/${ids.grn}`)],
      ['rtv doc A', () => b.get(`/docs/rtv/${ids.rtv}`)],
      ['issue_request doc A', () => b.get(`/docs/issue_request/${ids.request}`)],
      ['store_issue doc A', () => b.get(`/docs/store_issue/${ids.issue}`)],
      ['store_return doc A', () => b.get(`/docs/store_return/${ids.ret}`)],
      ['rtv submit A', () => b.post(`/docs/rtv/${ids.rtv}/submit`, { version: 1 })],
      ['grn action A', () => b.post(`/docs/grn/${ids.grn}/actions`, { action: 'decide', stageKey: 'quality', decisions: [{ lineId: ids.grnLine, approve: '0', reject: '10', reason: 'x' }] })],
      ['transfer to A node', () => docs(c, B.adminToken, 'stock_transfer').create({ values: { location: B.store, to_location: ids.node }, lines: [{ values: { item: B.items[0], qty: '1' } }] })],
      ['transfer of A item', () => docs(c, B.adminToken, 'stock_transfer').create({ values: { location: B.store, to_location: B.bin }, lines: [{ values: { item: ids.item, qty: '1' } }] })],
      ['adjustment at A node', () => docs(c, B.adminToken, 'stock_adjustment').create({ values: { location: B.store }, lines: [{ values: { item: B.items[0], qty: '1', direction: 'in', reason: 'x', location: ids.node } }] })],
      ['direct issue of A item', () => docs(c, B.adminToken, 'store_issue').create({ values: { location: B.store }, lines: [{ values: { item: ids.item, qty: '1' } }] })],
      ['GRN with A vendor/po', () => docs(c, B.adminToken, 'grn').create({ values: { location: B.store, party: ids.vendor }, lines: [{ values: { item: B.items[0], qty: '1', po_line: ids.poLine } }] })],
    ];
    const leaks: string[] = [];
    for (const [name, p] of writes) {
      const r = await p();
      if (r.status < 400 || r.status >= 500) leaks.push(`${name} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
    expect(leaks).toEqual([]);
    // Lists of every new document type in B show nothing of A.
    for (const t of ['grn', 'rtv', 'stock_transfer', 'stock_adjustment', 'stock_count', 'issue_request', 'store_issue', 'store_return']) {
      const r = await b.get(`/docs/${t}`);
      expect(r.status, t).toBe(200);
      expect(JSON.stringify(r.body), t).not.toContain(A.tenantId);
      for (const id of Object.values(ids)) expect(JSON.stringify(r.body).includes(id), `${t} lists ${id}`).toBe(false);
    }
  });

  it('transfer approval in B cannot move stock into A even if a forged to_location is written to the draft', async () => {
    const clk = await clerk(c, B);
    const sub = await storeDoc(c, B, clk.token, 'stock_transfer', { values: { location: B.store, to_location: B.bin }, lines: [{ values: { item: B.items[0], qty: '1' } }] });
    await c.db.updateTable('app.document').set({ custom: JSON.stringify({ to_location: ids.node }) }).where('id', '=', sub.id).execute();
    const r = await approveAll(c, B, 'stock_transfer', sub);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    const leaked = await c.db.selectFrom('app.stock_movement').select('id').where('tenant_id', '=', B.tenantId).where('node_id', '=', ids.node).execute();
    expect(leaked).toEqual([]);
  });
});

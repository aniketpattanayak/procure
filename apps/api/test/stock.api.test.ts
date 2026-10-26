/**
 * Stock endpoints (Phase 5 contract "Stock ledger" table): permission keys, data scope on the node, value hiding
 * without stock:action.view_value, status views, opening rules, block/unblock, re-order rules, summary, valuation,
 * report engine sources and cross-tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { limitedUser, stockWorld, StockWorld } from './stock-helpers';

let c: Ctx;
let w: StockWorld;
const VIEW = ['stock:action.view', 'stock:view.available', 'stock:view.quarantine', 'stock:view.rejected'];

beforeAll(async () => {
  c = await bootApp();
  w = await stockWorld(c, { features: ['indent', 'purchase', 'store', 'reports', 'report_builder'] });
  await mustOk(api(c, w.adminToken).post('/stock/opening', {
    asOf: '2026-04-01',
    rows: [
      { itemId: w.items[0], nodeId: w.store, qty: '10', unitCost: '4.5' },
      { itemId: w.items[0], nodeId: w.otherPlant, qty: '2', unitCost: '5' },
      { itemId: w.items[1], nodeId: w.bin, batchNo: 'LOT-9', expiryDate: '2026-11-15', qty: '8', unitCost: '1.25' },
    ],
  }));
});
afterAll(async () => closeApp(c));

describe('opening balances', () => {
  it('needs stock:action.opening and only applies to pairs without movements', async () => {
    const viewer = await limitedUser(c, w, VIEW);
    const body = { asOf: '2026-04-01', rows: [{ itemId: w.items[2], nodeId: w.store, qty: '1', unitCost: '1' }] };
    expect((await api(c, viewer.token).post('/stock/opening', body)).status).toBe(403);
    const r = await api(c, w.adminToken).post('/stock/opening', { ...body, rows: [{ itemId: w.items[0], nodeId: w.store, qty: '1', unitCost: '1' }] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STOCK_OPENING_EXISTS');
    const bad = await api(c, w.adminToken).post('/stock/opening', { ...body, rows: [{ itemId: w.store, nodeId: w.store, qty: '1', unitCost: '1' }] });
    expect(bad.status).toBe(400);
  });
});

describe('balances and ledger', () => {
  it('admin sees quantities, values, avg cost, batches and node paths', async () => {
    const page = await mustOk(api(c, w.adminToken).get(`/stock/balances?node=${w.plant}`));
    expect(page.data).toHaveLength(2);
    const steel = page.data.find((r: { item: { id: string } }) => r.item.id === w.items[0]);
    expect(steel).toMatchObject({ available: '10', quarantine: '0', total: '10', value: '45', avgCost: '4.5', batch: null });
    expect(steel.node.path).toEqual(['Plant', 'Main Store']);
    const byBatch = await mustOk(api(c, w.adminToken).get(`/stock/balances?byBatch=true&item=${w.items[1]}`));
    expect(byBatch.data[0].batch).toMatchObject({ batchNo: 'LOT-9', expiryDate: '2026-11-15' });
    const expiring = await mustOk(api(c, w.adminToken).get('/stock/balances?expiringWithinDays=3650'));
    expect(expiring.data.map((r: { batch: { batchNo: string } | null }) => r.batch?.batchNo)).toEqual(['LOT-9']);
    const notChildren = await mustOk(api(c, w.adminToken).get(`/stock/balances?node=${w.store}&includeChildren=false`));
    expect(notChildren.data.map((r: { node: { id: string } }) => r.node.id)).toEqual([w.store]);
    const paged = await mustOk(api(c, w.adminToken).get('/stock/balances?limit=2'));
    expect(paged.nextCursor).toBeTruthy();
    const next = await mustOk(api(c, w.adminToken).get(`/stock/balances?limit=2&cursor=${paged.nextCursor}`));
    expect(next.data).toHaveLength(1);
  });

  it('values are null without stock:action.view_value; valuation endpoint is 403', async () => {
    const viewer = await limitedUser(c, w, VIEW);
    const a = api(c, viewer.token);
    const page = await mustOk(a.get('/stock/balances'));
    expect(page.data.length).toBe(3);
    for (const r of page.data) expect([r.value, r.avgCost]).toEqual([null, null]);
    const led = await mustOk(a.get('/stock/ledger'));
    for (const r of led.data) expect([r.value, r.unitCost]).toEqual([null, null]);
    expect((await a.get('/stock/valuation')).status).toBe(403);
    const sum = await mustOk(a.get(`/stock/items/${w.items[0]}/summary`));
    expect(sum.totals.value).toBeNull();
    const valuer = await limitedUser(c, w, [...VIEW, 'stock:action.view_value']);
    const val = await mustOk(api(c, valuer.token).get(`/stock/valuation?node=${w.plant}`));
    expect(val.totalValue).toBe('55');
    const asOf = await mustOk(api(c, valuer.token).get('/stock/valuation?asOf=2026-03-31'));
    expect(asOf.rows).toHaveLength(0);
  });

  it('data scope on the node: rows, ledger, summary and node filters outside scope', async () => {
    const plantOnly = await limitedUser(c, w, [...VIEW, 'stock:action.view_value', 'stock:action.block'], w.plant);
    const a = api(c, plantOnly.token);
    const page = await mustOk(a.get('/stock/balances'));
    expect(page.data.map((r: { node: { id: string } }) => r.node.id).sort()).toEqual([w.bin, w.store].sort());
    const led = await mustOk(a.get(`/stock/ledger?item=${w.items[0]}`));
    expect(led.data.every((r: { node: { id: string } }) => r.node.id !== w.otherPlant)).toBe(true);
    expect((await a.get(`/stock/balances?node=${w.otherPlant}`)).status).toBe(404);
    const sum = await mustOk(a.get(`/stock/items/${w.items[0]}/summary`));
    expect(sum.nodes.map((n: { node: { id: string } }) => n.node.id)).toEqual([w.store]);
    expect((await a.post('/stock/block', { itemId: w.items[0], nodeId: w.otherPlant, qty: '1', reason: 'QC hold', direction: 'block' })).status).toBe(404);
  });

  it('without the quarantine view the quarantine bucket is hidden and its filter refused', async () => {
    const r = await mustOk(api(c, w.adminToken).post('/stock/block', { itemId: w.items[0], nodeId: w.store, qty: '2', reason: 'Visual damage', direction: 'block' }));
    expect(r).toHaveLength(2);
    expect(r[0].pairId).toBe(r[1].pairId);
    const availOnly = await limitedUser(c, w, ['stock:action.view', 'stock:view.available']);
    const page = await mustOk(api(c, availOnly.token).get(`/stock/balances?item=${w.items[0]}&node=${w.store}`));
    expect(page.data[0]).toMatchObject({ available: '8', quarantine: '0', total: '8' });
    expect((await api(c, availOnly.token).get('/stock/balances?status=quarantine')).status).toBe(403);
    const admin = await mustOk(api(c, w.adminToken).get(`/stock/balances?item=${w.items[0]}&node=${w.store}&includeChildren=false`));
    expect(admin.data[0]).toMatchObject({ available: '8', quarantine: '2', total: '10', value: '45' });
    // unblock back, more than blocked → 409
    expect((await api(c, w.adminToken).post('/stock/block', { itemId: w.items[0], nodeId: w.store, qty: '3', reason: 'Released', direction: 'unblock' })).status).toBe(409);
    await mustOk(api(c, w.adminToken).post('/stock/block', { itemId: w.items[0], nodeId: w.store, qty: '2', reason: 'Released', direction: 'unblock' }));
  });

  it('ledger rows carry the running balance per item × node × status and filter by type', async () => {
    const led = await mustOk(api(c, w.adminToken).get(`/stock/ledger?item=${w.items[0]}&node=${w.store}&includeChildren=false`));
    const avail = led.data.filter((r: { status: string }) => r.status === 'available');
    expect(avail.map((r: { movementType: string; balanceAfter: string }) => [r.movementType, r.balanceAfter])).toEqual([['unblock', '10'], ['block', '8'], ['opening', '10']]);
    const onlyOpening = await mustOk(api(c, w.adminToken).get('/stock/ledger?movementType=opening'));
    expect(onlyOpening.data).toHaveLength(3);
    const first = await mustOk(api(c, w.adminToken).get('/stock/ledger?limit=2'));
    const second = await mustOk(api(c, w.adminToken).get(`/stock/ledger?limit=2&cursor=${first.nextCursor}`));
    expect(new Set([...first.data, ...second.data].map((r: { id: string }) => r.id)).size).toBe(4);
  });
});

describe('re-order rules', () => {
  it('CRUD with stock:action.reorder; GET /stock/reorder lists items below min with the suggested qty', async () => {
    const viewer = await limitedUser(c, w, VIEW);
    expect((await api(c, viewer.token).get('/stock/reorder-rules')).status).toBe(403);
    const a = api(c, w.adminToken);
    const rule = await mustOk(a.post('/stock/reorder-rules', { itemId: w.items[0], nodeId: w.store, minQty: '12', reorderQty: '20', maxQty: '30' }), 201);
    expect(rule).toMatchObject({ minQty: '12', reorderQty: '20', maxQty: '30', autoIndent: false, isActive: true });
    expect((await a.post('/stock/reorder-rules', { itemId: w.items[0], nodeId: w.store, minQty: '1', reorderQty: '2' })).status).toBe(409);
    expect((await a.post('/stock/reorder-rules', { itemId: w.items[1], nodeId: w.store, minQty: '5', reorderQty: '2', maxQty: '1' })).status).toBe(400);
    const below = await mustOk(api(c, viewer.token).get(`/stock/reorder?node=${w.plant}`));
    expect(below).toEqual([expect.objectContaining({ ruleId: rule.id, available: '10', suggestedQty: '20' })]); // max 30 − 10
    const bal = await mustOk(a.get(`/stock/balances?item=${w.items[0]}&node=${w.store}&includeChildren=false`));
    expect(bal.data[0].reorder).toEqual({ minQty: '12', reorderQty: '20', belowMin: true });
    const upd = await mustOk(a.put(`/stock/reorder-rules/${rule.id}`, { itemId: w.items[0], nodeId: w.store, minQty: '5', reorderQty: '20' }));
    expect(upd.version).toBe(2);
    expect(await mustOk(a.get('/stock/reorder'))).toEqual([]);
    expect((await mustOk(a.get('/stock/reorder-rules'))).length).toBe(1);
    expect((await a.del(`/stock/reorder-rules/${rule.id}`)).status).toBe(204);
    expect((await a.get(`/stock/reorder-rules/${rule.id}`)).status).toBe(404);
  });
});

describe('item summary, report sources, isolation', () => {
  it('summary per node with totals', async () => {
    const s = await mustOk(api(c, w.adminToken).get(`/stock/items/${w.items[0]}/summary`));
    expect(s.item).toMatchObject({ id: w.items[0], name: 'Steel' });
    expect(s.totals).toMatchObject({ available: '12', quarantine: '0', value: '55', openPoQty: '0', pendingIssueQty: '0' });
    expect((await api(c, w.adminToken).get(`/stock/items/${w.store}/summary`)).status).toBe(404);
  });

  it('engine:stock_balance and engine:stock_ledger run through the report engine (values only with view_value)', async () => {
    const a = api(c, w.adminToken);
    const sources = await mustOk(a.get('/reports/sources'));
    const keys = sources.map((s: { source: { kind: string; key: string } }) => `${s.source.kind}:${s.source.key}`);
    expect(keys).toEqual(expect.arrayContaining(['engine:stock_balance', 'engine:stock_ledger']));
    const res = await mustOk(a.post('/reports/preview', {
      definition: { source: { kind: 'engine', key: 'stock_balance' }, columns: [{ field: 'item.name' }, { field: 'qty', aggregate: 'sum' }, { field: 'value', aggregate: 'sum' }], groupBy: ['item.name'] },
      params: {},
    }));
    expect(res.rows).toEqual(expect.arrayContaining([['Steel', '12.0000', '55.0000']].map(r => expect.arrayContaining([r[0]]))));
    const led = await mustOk(a.post('/reports/preview', { definition: { source: { kind: 'engine', key: 'stock_ledger' }, columns: [{ field: 'movement_type' }, { field: 'qty_in' }] }, params: {} }));
    expect(led.rows.length).toBeGreaterThanOrEqual(3);
    const reporter = await limitedUser(c, w, [...VIEW, 'reports:action.view', 'reports:action.build']);
    const srcs = await mustOk(api(c, reporter.token).get('/reports/sources'));
    const bal = srcs.find((s: { source: { key: string } }) => s.source.key === 'stock_balance');
    expect(bal.fields.map((f: { id: string }) => f.id)).not.toContain('value');
  });

  it('another tenant sees none of this stock (RLS)', async () => {
    const other = await stockWorld(c);
    const a = api(c, other.adminToken);
    expect((await mustOk(a.get('/stock/balances'))).data).toEqual([]);
    expect((await mustOk(a.get('/stock/ledger'))).data).toEqual([]);
    expect((await a.get(`/stock/items/${w.items[0]}/summary`)).status).toBe(404);
    expect((await a.get(`/stock/balances?node=${w.store}`)).status).toBe(404);
    expect((await a.post('/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: w.items[0], nodeId: other.store, qty: '1', unitCost: '1' }] })).status).toBe(400);
  });
});

/**
 * Stock ledger (Phase 5, ADR-0016): StockLedger.post math and guarantees — WAC / FIFO with decimals, idempotency,
 * negative checks, paired status moves and transfers, concurrency, re-order alerts, valuation lock, drift check.
 */
import type { StockPost } from '@procure/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/core/db.service';
import { StockDriftCheck, StockLedger } from '../src/modules/stock';
import { API, bearer, bootApp, closeApp, Ctx } from './helpers';
import { stockWorld, StockWorld } from './stock-helpers';

let c: Ctx;
let ledger: StockLedger;
let db: DbService;

const post = (w: StockWorld, posts: StockPost[], actor: string | null = null) => db.tenantTx(w.tenantId, tx => ledger.post(tx, posts, actor));
const bal = async (w: StockWorld, item: string, node: string, status = 'available') => {
  const r = await c.db.selectFrom('app.stock_balance').select(['qty', 'value']).where('tenant_id', '=', w.tenantId).where('item_id', '=', item).where('node_id', '=', node)
    .where('stock_status', '=', status as 'available').execute();
  return { qty: r.reduce((t, x) => t + Number(x.qty), 0), value: r.reduce((t, x) => t + Number(x.value), 0), raw: r };
};
const avg = async (w: StockWorld, item: string, node: string) =>
  c.db.selectFrom('app.item_avg_cost').select(['qty', 'value', 'avg_cost']).where('tenant_id', '=', w.tenantId).where('item_id', '=', item).where('node_id', '=', node).executeTakeFirstOrThrow();
const setSetting = (w: StockWorld, key: string, value: unknown) =>
  c.db.insertInto('app.tenant_setting').values({ tenant_id: w.tenantId, key, value: JSON.stringify(value) })
    .onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(value) })).execute();
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as { status?: number; code?: string; meta?: Record<string, unknown> }; } };

beforeAll(async () => {
  c = await bootApp();
  ledger = c.app.get(StockLedger);
  db = c.app.get(DbService);
});
afterAll(async () => closeApp(c));

describe('WAC valuation (decimals)', () => {
  it('averages receipts, values issues at the node average, clears the residual on the last issue', async () => {
    const w = await stockWorld(c);
    const [steel] = w.items as [string];
    await post(w, [{ itemId: steel, nodeId: w.store, status: 'available', movementType: 'opening', qtyIn: '10', unitCost: '12.345678' }]);
    expect(await avg(w, steel, w.store)).toMatchObject({ qty: '10.0000', value: '123.4568', avg_cost: '12.345680' });
    await post(w, [{ itemId: steel, nodeId: w.store, status: 'available', movementType: 'receipt', qtyIn: '5', unitCost: '20.5' }]);
    const a = await avg(w, steel, w.store);
    expect(a).toMatchObject({ qty: '15.0000', value: '225.9568', avg_cost: '15.063787' });
    const [issue] = await post(w, [{ itemId: steel, nodeId: w.store, status: 'available', movementType: 'issue', qtyOut: '4' }]);
    expect(issue).toMatchObject({ qtyOut: '4', unitCost: '15.063787', value: '-60.2551', duplicate: false });
    expect(await avg(w, steel, w.store)).toMatchObject({ qty: '11.0000', value: '165.7017' });
    const [last] = await post(w, [{ itemId: steel, nodeId: w.store, status: 'available', movementType: 'issue', qtyOut: '11' }]);
    expect(last!.value).toBe('-165.7017');
    expect(await bal(w, steel, w.store)).toMatchObject({ qty: 0, value: 0 });
    // A return with no explicit cost comes back at the last average.
    const [ret] = await post(w, [{ itemId: steel, nodeId: w.store, status: 'available', movementType: 'return', qtyIn: '0.5' }]);
    expect(ret).toMatchObject({ unitCost: '15.063787', value: '7.5319' });
  });

  it('rejects malformed posts (both / neither qty, >4 decimals, unknown item)', async () => {
    const w = await stockWorld(c);
    const base = { itemId: w.items[0]!, nodeId: w.store, status: 'available' as const, movementType: 'receipt' as const };
    expect((await err(post(w, [{ ...base, qtyIn: '1', qtyOut: '1' }])))?.status).toBe(400);
    expect((await err(post(w, [{ ...base }])))?.status).toBe(400);
    expect((await err(post(w, [{ ...base, qtyIn: '1.00001' }])))?.status).toBe(400);
    expect((await err(post(w, [{ ...base, itemId: w.store, qtyIn: '1' }])))?.status).toBe(400);
  });
});

describe('FIFO valuation (decimals)', () => {
  it('consumes the oldest layers first and keeps the rest at their own cost', async () => {
    const w = await stockWorld(c);
    await setSetting(w, 'stock.valuation', 'fifo');
    const [paint] = [w.items[2]!];
    await post(w, [{ itemId: paint, nodeId: w.store, status: 'available', movementType: 'opening', qtyIn: '10', unitCost: '10' }]);
    await post(w, [{ itemId: paint, nodeId: w.store, status: 'available', movementType: 'receipt', qtyIn: '10', unitCost: '13.3333' }]);
    const [m] = await post(w, [{ itemId: paint, nodeId: w.store, status: 'available', movementType: 'issue', qtyOut: '15' }]);
    expect(m!.value).toBe('-166.6665');                        // 10 × 10 + 5 × 13.3333
    expect(m!.unitCost).toBe('11.1111');
    const layers = await c.db.selectFrom('app.valuation_layer').select(['qty_left', 'unit_cost']).where('tenant_id', '=', w.tenantId).where('item_id', '=', paint).orderBy('id').execute();
    expect(layers.map(l => [l.qty_left, l.unit_cost])).toEqual([['0.0000', '10.000000'], ['5.0000', '13.333300']]);
    expect(await bal(w, paint, w.store)).toMatchObject({ qty: 5, value: 66.6665 });
    const [m2] = await post(w, [{ itemId: paint, nodeId: w.store, status: 'available', movementType: 'issue', qtyOut: '2.5' }]);
    expect(m2!.value).toBe('-33.3333');                        // 2.5 × 13.3333 = 33.33325 → 33.3333
  });

  it('values stock received before a WAC→FIFO switch as the oldest layer', async () => {
    const w = await stockWorld(c);
    const item = w.items[0]!;
    await post(w, [{ itemId: item, nodeId: w.store, status: 'available', movementType: 'opening', qtyIn: '4', unitCost: '5' }]);
    await setSetting(w, 'stock.valuation', 'fifo');
    await post(w, [{ itemId: item, nodeId: w.store, status: 'available', movementType: 'receipt', qtyIn: '4', unitCost: '9' }]);
    const [m] = await post(w, [{ itemId: item, nodeId: w.store, status: 'available', movementType: 'issue', qtyOut: '6' }]);
    expect(m!.value).toBe('-38');                              // 4 × 5 (pre-FIFO) + 2 × 9
  });
});

describe('idempotency, negatives, pairs', () => {
  it('a repeated idempotency key writes nothing and returns the original movement', async () => {
    const w = await stockWorld(c);
    const p: StockPost = { itemId: w.items[0]!, nodeId: w.store, status: 'available', movementType: 'receipt', qtyIn: '3', unitCost: '2', idempotencyKey: 'grn:1:line:1' };
    const [first] = await post(w, [p]);
    const [again] = await post(w, [p]);
    expect(again).toMatchObject({ id: first!.id, duplicate: true });
    expect(await bal(w, w.items[0]!, w.store)).toMatchObject({ qty: 3, value: 6 });
    const n = await c.db.selectFrom('app.stock_movement').select(c.db.fn.countAll<string>().as('n')).where('tenant_id', '=', w.tenantId).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(1);
    // Same key twice inside one post is a caller bug → 400.
    expect((await err(post(w, [p, { ...p }])))?.status).toBe(400);
  });

  it('refuses to go negative unless stock.allow_negative', async () => {
    const w = await stockWorld(c);
    const item = w.items[1]!;
    await post(w, [{ itemId: item, nodeId: w.store, status: 'available', movementType: 'opening', qtyIn: '2', unitCost: '1' }]);
    const e = await err(post(w, [{ itemId: item, nodeId: w.store, status: 'available', movementType: 'issue', qtyOut: '2.0001' }]));
    expect(e).toMatchObject({ status: 409, code: 'STOCK_NEGATIVE' });
    expect(e!.meta).toMatchObject({ available: '2', requested: '2.0001' });
    expect(await bal(w, item, w.store)).toMatchObject({ qty: 2 });
    await setSetting(w, 'stock.allow_negative', true);
    await post(w, [{ itemId: item, nodeId: w.store, status: 'available', movementType: 'issue', qtyOut: '3' }]);
    expect((await bal(w, item, w.store)).qty).toBe(-1);
  });

  it('block / unblock are paired movements that carry value between statuses', async () => {
    const w = await stockWorld(c);
    const item = w.items[0]!;
    await post(w, [{ itemId: item, nodeId: w.store, status: 'available', movementType: 'opening', qtyIn: '9', unitCost: '3.333333' }]);
    const pairId = ledger.newPairId();
    const out = await post(w, [
      { itemId: item, nodeId: w.store, status: 'available', movementType: 'block', qtyOut: '3', pairId },
      { itemId: item, nodeId: w.store, status: 'quarantine', movementType: 'block', qtyIn: '3', pairId },
    ]);
    expect(out.map(m => m.pairId)).toEqual([pairId, pairId]);
    expect(out[0]!.value).toBe('-10');
    expect(out[1]!.value).toBe('10');
    expect(await bal(w, item, w.store, 'quarantine')).toMatchObject({ qty: 3, value: 10 });
    expect(await bal(w, item, w.store)).toMatchObject({ qty: 6, value: 20 });
    expect(await avg(w, item, w.store)).toMatchObject({ qty: '9.0000', value: '30.0000' }); // status moves keep node valuation
    // Blocking more than available fails and writes neither side.
    expect((await err(post(w, [
      { itemId: item, nodeId: w.store, status: 'available', movementType: 'block', qtyOut: '7', pairId: ledger.newPairId() },
      { itemId: item, nodeId: w.store, status: 'quarantine', movementType: 'block', qtyIn: '7' },
    ])))?.code).toBe('STOCK_NEGATIVE');
    const pair2 = ledger.newPairId();
    await post(w, [
      { itemId: item, nodeId: w.store, status: 'quarantine', movementType: 'unblock', qtyOut: '3', pairId: pair2 },
      { itemId: item, nodeId: w.store, status: 'available', movementType: 'unblock', qtyIn: '3', pairId: pair2 },
    ]);
    expect(await bal(w, item, w.store, 'quarantine')).toMatchObject({ qty: 0, value: 0 });
    expect(await bal(w, item, w.store)).toMatchObject({ qty: 9, value: 30 });
  });

  it('a transfer carries the source cost to the destination', async () => {
    const w = await stockWorld(c);
    const item = w.items[0]!;
    await post(w, [{ itemId: item, nodeId: w.store, status: 'available', movementType: 'opening', qtyIn: '3', unitCost: '10' }]);
    await post(w, [{ itemId: item, nodeId: w.store, status: 'available', movementType: 'receipt', qtyIn: '3', unitCost: '11' }]);
    await post(w, [{ itemId: item, nodeId: w.bin, status: 'available', movementType: 'opening', qtyIn: '1', unitCost: '99' }]);
    const pairId = ledger.newPairId();
    const out = await post(w, [
      { itemId: item, nodeId: w.bin, status: 'available', movementType: 'transfer_in', qtyIn: '2', pairId },     // order does not matter
      { itemId: item, nodeId: w.store, status: 'available', movementType: 'transfer_out', qtyOut: '2', pairId },
    ]);
    expect(out[1]).toMatchObject({ unitCost: '10.5', value: '-21' });
    expect(out[0]).toMatchObject({ unitCost: '10.5', value: '21' });
    expect(await avg(w, item, w.bin)).toMatchObject({ qty: '3.0000', value: '120.0000', avg_cost: '40.000000' });
  });
});

describe('concurrency', () => {
  it('parallel issues never take a balance below zero (row locks in key order)', async () => {
    const w = await stockWorld(c);
    const [a, b] = [w.items[0]!, w.items[1]!];
    await post(w, [
      { itemId: a, nodeId: w.store, status: 'available', movementType: 'opening', qtyIn: '10', unitCost: '1' },
      { itemId: b, nodeId: w.store, status: 'available', movementType: 'opening', qtyIn: '10', unitCost: '1' },
    ]);
    // 24 concurrent posts each taking 1 of BOTH items, in opposite orders (deadlock bait) → exactly 10 succeed.
    const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => post(w, (i % 2 ? [a, b] : [b, a]).map(item => ({
      itemId: item, nodeId: w.store, status: 'available' as const, movementType: 'issue' as const, qtyOut: '1',
    })))));
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason as { code?: string });
    expect(ok).toBe(10);
    expect(failed.every(f => f.code === 'STOCK_NEGATIVE')).toBe(true);
    expect(await bal(w, a, w.store)).toMatchObject({ qty: 0, value: 0 });
    expect(await bal(w, b, w.store)).toMatchObject({ qty: 0, value: 0 });
    expect(await c.app.get(StockDriftCheck).checkTenant(w.tenantId)).toEqual([]);
  });

  it('a concurrent retry with the same idempotency key posts once', async () => {
    const w = await stockWorld(c);
    const p: StockPost = { itemId: w.items[0]!, nodeId: w.store, status: 'available', movementType: 'receipt', qtyIn: '1', unitCost: '1', idempotencyKey: 'retry-1' };
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => post(w, [p])));
    expect(r.every(x => x.status === 'fulfilled')).toBe(true);
    expect((await bal(w, w.items[0]!, w.store)).qty).toBe(1);
  });
});

describe('re-order alerts', () => {
  it('alerts once per rule per day with an outbox event and drafts an indent when auto_indent', async () => {
    const w = await stockWorld(c);
    const item = w.items[0]!;
    await post(w, [{ itemId: item, nodeId: w.bin, status: 'available', movementType: 'opening', qtyIn: '20', unitCost: '2' }]);
    // Rule on the store covers its bins.
    await c.db.insertInto('app.reorder_rule').values({ tenant_id: w.tenantId, item_id: item, node_id: w.store, min_qty: '15', reorder_qty: '25', auto_indent: true }).execute();
    await post(w, [{ itemId: item, nodeId: w.bin, status: 'available', movementType: 'issue', qtyOut: '4' }], w.adminId);
    expect(await c.db.selectFrom('app.notification').select('id').where('tenant_id', '=', w.tenantId).where('kind', '=', 'stock_below_min').execute()).toHaveLength(0);
    await post(w, [{ itemId: item, nodeId: w.bin, status: 'available', movementType: 'issue', qtyOut: '2' }], w.adminId);
    const notes = await c.db.selectFrom('app.notification').select(['user_id', 'title', 'link']).where('tenant_id', '=', w.tenantId).where('kind', '=', 'stock_below_min').execute();
    expect(notes.map(n => n.user_id)).toContain(w.adminId);
    const ev = await c.db.selectFrom('app.outbox_event').select('payload').where('tenant_id', '=', w.tenantId).where('event_type', '=', 'stock.below_min').execute();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ available: '14', minQty: '15', suggestedQty: '25' });
    const indentId = (ev[0]!.payload as { indentId: string | null }).indentId;
    expect(indentId).toBeTruthy();
    const line = await c.db.selectFrom('app.document_line').select(['item_id', 'qty', 'location_node_id']).where('document_id', '=', indentId!).executeTakeFirstOrThrow();
    expect(line).toMatchObject({ item_id: item, qty: '25.0000', location_node_id: w.store });
    // Throttled: another out the same day does not alert again.
    await post(w, [{ itemId: item, nodeId: w.bin, status: 'available', movementType: 'issue', qtyOut: '1' }]);
    expect(await c.db.selectFrom('app.outbox_event').select('id').where('tenant_id', '=', w.tenantId).where('event_type', '=', 'stock.below_min').execute()).toHaveLength(1);
    expect(await c.db.selectFrom('app.outbox_event').select('id').where('tenant_id', '=', w.tenantId).where('event_type', '=', 'stock.moved').execute()).toHaveLength(4);
  });
});

describe('valuation method lock and drift check', () => {
  it('stock.valuation can change before the first movement of the FY, not after (409)', async () => {
    const w = await stockWorld(c);
    const put = (v: string) => c.http.put(`${API}/config/settings`).set(bearer(w.adminToken)).send({ 'stock.valuation': v });
    expect((await put('fifo')).status).toBe(200);
    expect((await put('wac')).status).toBe(200);
    await post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: 'available', movementType: 'opening', qtyIn: '1', unitCost: '1' }]);
    const r = await put('fifo');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STOCK_VALUATION_LOCKED');
    expect((await put('wac')).status).toBe(200); // unchanged value is fine
  });

  it('detects a balance that no longer matches the ledger', async () => {
    const w = await stockWorld(c);
    await post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: 'available', movementType: 'opening', qtyIn: '5', unitCost: '2' }]);
    const drift = c.app.get(StockDriftCheck);
    expect(await drift.checkTenant(w.tenantId)).toEqual([]);
    await c.db.updateTable('app.stock_balance').set({ qty: '6' }).where('tenant_id', '=', w.tenantId).execute();
    const rows = await drift.checkTenant(w.tenantId);
    expect(rows).toEqual([expect.objectContaining({ kind: 'balance', stored: { qty: '6', value: '10' }, ledger: { qty: '5', value: '10' } })]);
    const res = await drift.runAll();
    expect(res.drifted).toBeGreaterThanOrEqual(1);
  });
});

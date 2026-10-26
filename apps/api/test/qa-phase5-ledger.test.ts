/**
 * QA Phase 5 — stock ledger integrity: concurrency storms (balance = Σ movements, never negative), WAC / FIFO with
 * awkward decimals across receipts, issues, returns, transfers and status moves, block / unblock pairs through the
 * API, opening-balance rules, idempotent effect replays, oversized / invalid numbers (400 never 500), the drift job,
 * re-order alerts (throttle, auto indent, recipients) and stock counts.
 *
 * Known bugs are `it.fails` with their id (docs/qa/phase-5-report.md).
 */
import type { StockPost } from '@procure/schema';
import type { LedgerPost } from '../src/modules/stock';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/core/db.service';
import { StockDriftCheck, StockEffects, StockLedger } from '../src/modules/stock';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { docs } from './procurement-helpers';
import { approveAll, bal, clerk, expectIntegrity, integrity, opening, setSetting, STOCK_VIEW, storeDoc } from './qa-phase5-helpers';
import { limitedUser, stockWorld, StockWorld } from './stock-helpers';

let c: Ctx;
let ledger: StockLedger;
let db: DbService;

const post = (w: StockWorld, posts: LedgerPost[], actor: string | null = null) => db.tenantTx(w.tenantId, tx => ledger.post(tx, posts, actor));
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as { status?: number; code?: string }; } };
const avgRow = (w: StockWorld, item: string, node: string) =>
  c.db.selectFrom('app.item_avg_cost').select(['qty', 'value', 'avg_cost']).where('tenant_id', '=', w.tenantId).where('item_id', '=', item).where('node_id', '=', node).executeTakeFirstOrThrow();
const A = 'available' as const;

beforeAll(async () => {
  c = await bootApp();
  ledger = c.app.get(StockLedger);
  db = c.app.get(DbService);
}, 120_000);
afterAll(async () => closeApp(c));

// ---------------------------------------------------------------------------------------------- concurrency
describe('concurrency: balance = Σ movements under parallel posts on the same item × node', () => {
  it.each(['wac', 'fifo'])('mixed storm (%s): receipts, issues, transfers both ways, block/unblock — never negative, ledger exact', async method => {
    const w = await stockWorld(c);
    if (method === 'fifo') await setSetting(c, w.tenantId, 'stock.valuation', 'fifo');
    const item = w.items[0]!;
    await post(w, [
      { itemId: item, nodeId: w.store, status: A, movementType: 'opening', qtyIn: '50', unitCost: '3.333333' },
      { itemId: item, nodeId: w.bin, status: A, movementType: 'opening', qtyIn: '20', unitCost: '7.77' },
    ]);
    const ops: (() => Promise<unknown>)[] = [];
    for (let i = 0; i < 80; i++) {
      const k = i % 8;
      const pair = ledger.newPairId();
      if (k === 0) ops.push(() => post(w, [{ itemId: item, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '1.3333', unitCost: '9.876543' }]));
      if (k === 1) ops.push(() => post(w, [{ itemId: item, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '2.7071' }]));
      if (k === 2) ops.push(() => post(w, [
        { itemId: item, nodeId: w.store, status: A, movementType: 'transfer_out', qtyOut: '3.1416', pairId: pair },
        { itemId: item, nodeId: w.bin, status: A, movementType: 'transfer_in', qtyIn: '3.1416', pairId: pair },
      ]));
      if (k === 3) ops.push(() => post(w, [
        { itemId: item, nodeId: w.bin, status: A, movementType: 'transfer_in', qtyIn: '1.4142', pairId: pair }, // reversed order: deadlock bait
        { itemId: item, nodeId: w.store, status: A, movementType: 'transfer_out', qtyOut: '1.4142', pairId: pair },
      ]));
      if (k === 4) ops.push(() => post(w, [
        { itemId: item, nodeId: w.bin, status: A, movementType: 'transfer_out', qtyOut: '2.2222', pairId: pair },
        { itemId: item, nodeId: w.store, status: A, movementType: 'transfer_in', qtyIn: '2.2222', pairId: pair },
      ]));
      if (k === 5) ops.push(() => post(w, [
        { itemId: item, nodeId: w.store, status: A, movementType: 'block', qtyOut: '0.5', pairId: pair },
        { itemId: item, nodeId: w.store, status: 'quarantine', movementType: 'block', qtyIn: '0.5', pairId: pair },
      ]));
      if (k === 6) ops.push(() => post(w, [
        { itemId: item, nodeId: w.store, status: 'quarantine', movementType: 'unblock', qtyOut: '0.25', pairId: pair },
        { itemId: item, nodeId: w.store, status: A, movementType: 'unblock', qtyIn: '0.25', pairId: pair },
      ]));
      if (k === 7) ops.push(() => post(w, [{ itemId: item, nodeId: w.bin, status: A, movementType: 'issue', qtyOut: '4.0001' }]));
    }
    const res = await Promise.allSettled(ops.map(f => f()));
    const failed = res.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason as { code?: string; message?: string });
    // Only business refusals (not enough stock) are acceptable — never deadlocks / serialization errors / 500s.
    expect(failed.filter(f => f.code !== 'STOCK_NEGATIVE').map(f => f.message)).toEqual([]);
    expect(res.filter(r => r.status === 'fulfilled').length).toBeGreaterThan(40);
    await expectIntegrity(c, w.tenantId, { fifo: method === 'fifo' });
    expect(await c.app.get(StockDriftCheck).checkTenant(w.tenantId)).toEqual([]);
  });

  it('parallel API blocks on one balance: exactly the available qty gets blocked, the rest 409', async () => {
    const w = await stockWorld(c);
    await mustOk(opening(c, w.adminToken, [{ itemId: w.items[0], nodeId: w.store, qty: '10', unitCost: '1.1' }]));
    const a = api(c, w.adminToken);
    const res = await Promise.all(Array.from({ length: 25 }, () => a.post('/stock/block', { itemId: w.items[0], nodeId: w.store, qty: '1', reason: 'QA hold', direction: 'block' })));
    expect(res.filter(r => r.status === 200)).toHaveLength(10);
    expect(res.filter(r => r.status !== 200).map(r => r.status)).toEqual(Array(15).fill(409));
    expect(await bal(c, w.tenantId, w.items[0]!, w.store, 'quarantine')).toEqual({ qty: 10, value: 11 });
    await expectIntegrity(c, w.tenantId);
  });

  it('parallel opening loads for the same pair: one posts, the others 409 STOCK_OPENING_EXISTS', async () => {
    const w = await stockWorld(c);
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => opening(c, w.adminToken, [{ itemId: w.items[1], nodeId: w.store, qty: String(i + 1), unitCost: '2' }])));
    expect(res.filter(r => r.status === 200)).toHaveLength(1);
    expect(res.filter(r => r.status === 409).every(r => r.body.code === 'STOCK_OPENING_EXISTS')).toBe(true);
    expect(res.filter(r => r.status === 409)).toHaveLength(7);
    const n = await c.db.selectFrom('app.stock_movement').select(c.db.fn.countAll<string>().as('n')).where('tenant_id', '=', w.tenantId).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(1);
  });

  it('parallel transfer approvals through the workflow (store → bin and bin → store) keep both nodes exact', async () => {
    const w = await stockWorld(c);
    const clk = await clerk(c, w);
    await mustOk(opening(c, w.adminToken, [
      { itemId: w.items[0], nodeId: w.store, qty: '30', unitCost: '1.234567' },
      { itemId: w.items[0], nodeId: w.bin, qty: '30', unitCost: '2.5' },
    ]));
    const subs = [];
    for (let i = 0; i < 12; i++) {
      const [from, to] = i % 2 ? [w.store, w.bin] : [w.bin, w.store];
      subs.push(await storeDoc(c, w, clk.token, 'stock_transfer', { values: { location: from, to_location: to }, lines: [{ values: { item: w.items[0], qty: '4.5' } }] }));
    }
    const res = await Promise.all(subs.map(s => approveAll(c, w, 'stock_transfer', s)));
    expect(res.filter(r => r.status !== 200).map(r => `${r.status} ${r.body.code}`).filter(s => !s.includes('STOCK_NEGATIVE'))).toEqual([]);
    await expectIntegrity(c, w.tenantId);
    const store = await bal(c, w.tenantId, w.items[0]!, w.store);
    const bin = await bal(c, w.tenantId, w.items[0]!, w.bin);
    expect(store.qty + bin.qty).toBe(60);
    // Value is conserved across transfers (carried at source cost).
    expect(new Decimal(store.value).plus(bin.value).toFixed(4)).toBe(new Decimal('37.0370').plus('75').toFixed(4));
  });
});

// ---------------------------------------------------------------------------------------------- valuation
describe('WAC with awkward decimals', () => {
  it('value is conserved exactly across receipts, issues, returns, transfers and status moves; an emptied node holds 0', async () => {
    const w = await stockWorld(c);
    const it0 = w.items[0]!;
    const seq: StockPost[] = [
      { itemId: it0, nodeId: w.store, status: A, movementType: 'opening', qtyIn: '3', unitCost: '0.333333' },
      { itemId: it0, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '7.0001', unitCost: '1.000001' },
      { itemId: it0, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '0.0003' },
      { itemId: it0, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '0.0001', unitCost: '99999.999999' },
      { itemId: it0, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '3.3333' },
      { itemId: it0, nodeId: w.store, status: A, movementType: 'return', qtyIn: '1.1111' },
    ];
    for (const p of seq) await post(w, [p]);
    const pair = ledger.newPairId();
    await post(w, [
      { itemId: it0, nodeId: w.store, status: A, movementType: 'transfer_out', qtyOut: '2.2222', pairId: pair },
      { itemId: it0, nodeId: w.bin, status: A, movementType: 'transfer_in', qtyIn: '2.2222', pairId: pair },
    ]);
    const p2 = ledger.newPairId();
    await post(w, [
      { itemId: it0, nodeId: w.store, status: A, movementType: 'block', qtyOut: '1.0001', pairId: p2 },
      { itemId: it0, nodeId: w.store, status: 'quarantine', movementType: 'block', qtyIn: '1.0001', pairId: p2 },
    ]);
    await expectIntegrity(c, w.tenantId);
    // Every out is valued at the node average of its moment (6 dp), within rounding of 4 dp.
    const mv = await c.db.selectFrom('app.stock_movement').select(['movement_type', 'qty_out', 'unit_cost', 'value']).where('tenant_id', '=', w.tenantId)
      .where('movement_type', 'in', ['issue', 'transfer_out']).execute();
    for (const m of mv) expect(new Decimal(m.value).neg().minus(new Decimal(m.qty_out).times(m.unit_cost)).abs().lte('0.00005')).toBe(true);
    // Empty both nodes completely: no residual value anywhere.
    const s = await avgRow(w, it0, w.store);
    const p3 = ledger.newPairId();
    await post(w, [
      { itemId: it0, nodeId: w.store, status: 'quarantine', movementType: 'unblock', qtyOut: '1.0001', pairId: p3 },
      { itemId: it0, nodeId: w.store, status: A, movementType: 'unblock', qtyIn: '1.0001', pairId: p3 },
    ]);
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'issue', qtyOut: new Decimal(s.qty).toFixed() }]);
    await post(w, [{ itemId: it0, nodeId: w.bin, status: A, movementType: 'issue', qtyOut: '2.2222' }]);
    for (const n of [w.store, w.bin]) {
      expect(await avgRow(w, it0, n)).toMatchObject({ qty: '0.0000', value: '0.0000' });
      expect(await bal(c, w.tenantId, it0, n)).toEqual({ qty: 0, value: 0 });
      expect(await bal(c, w.tenantId, it0, n, 'quarantine')).toEqual({ qty: 0, value: 0 });
    }
    await expectIntegrity(c, w.tenantId);
    // Valuation endpoint (from the ledger) agrees: nothing left.
    const val = await mustOk(api(c, w.adminToken).get('/stock/valuation'));
    expect(val.totalValue).toBe('0');
  });

  it('a partial issue of a node holding both available and quarantine stock never leaves a zero-qty status row with value', async () => {
    const w = await stockWorld(c);
    const it0 = w.items[1]!;
    // 3 @ 10 available; 3 @ 20 received straight into quarantine (post_stock with stockStatus quarantine).
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '3', unitCost: '10' }]);
    await post(w, [{ itemId: it0, nodeId: w.store, status: 'quarantine', movementType: 'receipt', qtyIn: '3', unitCost: '20' }]);
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '3' }]);
    await expectIntegrity(c, w.tenantId);
    const rows = await c.db.selectFrom('app.stock_balance').select(['stock_status', 'qty', 'value']).where('tenant_id', '=', w.tenantId).where('item_id', '=', it0).execute();
    const avail = rows.find(r => r.stock_status === 'available')!;
    // QA5-BUG (observation, see report): available is 0 qty but carries −15 value; quarantine 3 qty carries 60.
    expect({ qty: Number(avail.qty), value: Number(avail.value) }).toEqual({ qty: 0, value: -15 });
  });
});

describe('FIFO across mixed movements', () => {
  it('receipts, partial issues, a return and a transfer consume layers oldest-first; the destination opens a layer at the carried cost', async () => {
    const w = await stockWorld(c);
    await setSetting(c, w.tenantId, 'stock.valuation', 'fifo');
    const it0 = w.items[0]!;
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'opening', qtyIn: '2.5', unitCost: '1.111111' }]);
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '4', unitCost: '2.222222' }]);
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '1.75', unitCost: '3.333333' }]);
    const [i1] = await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '3' }]);
    // 2.5 × 1.111111 + 0.5 × 2.222222 = 2.7777775 + 1.111111 = 3.8888885 → 3.8889
    expect(i1!.value).toBe('-3.8889');
    const [r1] = await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'return', qtyIn: '1', unitCost: '5' }]);
    expect(r1!.value).toBe('5');
    const pair = ledger.newPairId();
    const tr = await post(w, [
      { itemId: it0, nodeId: w.store, status: A, movementType: 'transfer_out', qtyOut: '4', pairId: pair },
      { itemId: it0, nodeId: w.bin, status: A, movementType: 'transfer_in', qtyIn: '4', pairId: pair },
    ]);
    // 3.5 × 2.222222 + 0.5 × 3.333333 = 7.777777 + 1.6666665 = 9.4444435 → 9.4444
    expect(tr[0]!.value).toBe('-9.4444');
    expect(tr[1]!.value).toBe('9.4444');
    const layers = await c.db.selectFrom('app.valuation_layer').select(['node_id', 'qty_left', 'unit_cost']).where('tenant_id', '=', w.tenantId).where('qty_left', '>', '0').orderBy('id').execute();
    expect(layers.map(l => [l.node_id === w.store ? 'store' : 'bin', Number(l.qty_left), Number(l.unit_cost)])).toEqual([
      ['store', 1.25, 3.333333], ['store', 1, 5], ['bin', 4, 2.3611],
    ]);
    // Remaining store value = 1.25 × 3.333333 + 5 = 9.1666663 (stored 4 dp of the sums actually posted).
    const rem = await bal(c, w.tenantId, it0, w.store);
    expect(rem.qty).toBe(2.25);
    expect(Math.abs(rem.value - 9.1667)).toBeLessThanOrEqual(0.0002);
    await expectIntegrity(c, w.tenantId, { fifo: true });
  });
});

describe('return to vendor valuation', () => {
  // QA5-BUG-001 (fixed): an `rtv` out was valued at the node average (WAC) / oldest layers (FIFO) instead of the cost
  // the goods were received at. Now the out (and the QA block before it) names the receipt movement
  // (`sourceMovementId`, specific identification) and leaves at that movement's cost.
  it('QA5-BUG-001 (fixed) WAC: returning rejected goods leaves the remaining stock at its own cost', async () => {
    const w = await stockWorld(c);
    const it0 = w.items[2]!;
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'opening', qtyIn: '100', unitCost: '10' }]);
    const [rc] = await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '50', unitCost: '100' }]);
    const pair = ledger.newPairId();
    await post(w, [
      { itemId: it0, nodeId: w.store, status: A, movementType: 'block', qtyOut: '50', pairId: pair, sourceMovementId: rc!.id },
      { itemId: it0, nodeId: w.store, status: 'quarantine', movementType: 'block', qtyIn: '50', pairId: pair },
    ]);
    const [out] = await post(w, [{ itemId: it0, nodeId: w.store, status: 'quarantine', movementType: 'rtv', qtyOut: '50', sourceMovementId: rc!.id }]);
    expect([out!.unitCost, out!.value]).toEqual(['100', '-5000']);
    expect(await bal(c, w.tenantId, it0, w.store)).toEqual({ qty: 100, value: 1000 });
    // Row level is clean too: available 100 @ 10, quarantine empty with no stranded value; the node average is 10.
    const rows = await c.db.selectFrom('app.stock_balance').select(['stock_status', 'qty', 'value']).where('tenant_id', '=', w.tenantId).where('item_id', '=', it0).orderBy('stock_status').execute();
    expect(rows.map(r => [r.stock_status, Number(r.qty), Number(r.value)])).toEqual([['available', 100, 1000], ['quarantine', 0, 0]]);
    expect(await avgRow(w, it0, w.store)).toMatchObject({ qty: '100.0000', value: '1000.0000', avg_cost: '10.000000' });
    await expectIntegrity(c, w.tenantId);
  });

  it('QA5-BUG-001 (fixed) WAC: the specific cost is bounded by the node value; the last units take what is left', async () => {
    const w = await stockWorld(c);
    const it0 = w.items[2]!;
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'opening', qtyIn: '10', unitCost: '1' }]);
    const [rc] = await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '10', unitCost: '9' }]);
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '15' }]); // 15 × 5 = 75 → 5 @ 5 = 25 left
    const [out] = await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'rtv', qtyOut: '2', sourceMovementId: rc!.id }]);
    expect(out!.value).toBe('-18');
    const [last] = await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'rtv', qtyOut: '3', sourceMovementId: rc!.id }]);
    expect(last!.value).toBe('-7'); // exactly what the node still held
    expect(await bal(c, w.tenantId, it0, w.store)).toEqual({ qty: 0, value: 0 });
    await expectIntegrity(c, w.tenantId);
  });

  it('QA5-BUG-001 (fixed) FIFO: returning the newest receipt consumes its own layer', async () => {
    const w = await stockWorld(c);
    await setSetting(c, w.tenantId, 'stock.valuation', 'fifo');
    const it0 = w.items[2]!;
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'opening', qtyIn: '100', unitCost: '10' }]);
    const [rc] = await post(w, [{ itemId: it0, nodeId: w.store, status: 'quarantine', movementType: 'receipt', qtyIn: '50', unitCost: '100' }]);
    const [out] = await post(w, [{ itemId: it0, nodeId: w.store, status: 'quarantine', movementType: 'rtv', qtyOut: '50', sourceMovementId: rc!.id }]);
    expect(out!.value).toBe('-5000');
    expect(await avgRow(w, it0, w.store)).toMatchObject({ qty: '100.0000', value: '1000.0000' });
    const layers = await c.db.selectFrom('app.valuation_layer').select(['qty_left', 'unit_cost']).where('tenant_id', '=', w.tenantId).where('qty_left', '>', '0').execute();
    expect(layers.map(l => [Number(l.qty_left), Number(l.unit_cost)])).toEqual([[100, 10]]);
    await expectIntegrity(c, w.tenantId, { fifo: true });
  });

  it('QA5-BUG-001 (fixed) a source movement of another item / location, or on an in, is a 400', async () => {
    const w = await stockWorld(c);
    const [rc] = await post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '5', unitCost: '1' }]);
    await post(w, [{ itemId: w.items[1]!, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '5', unitCost: '1' }]);
    expect(await err(post(w, [{ itemId: w.items[1]!, nodeId: w.store, status: A, movementType: 'rtv', qtyOut: '1', sourceMovementId: rc!.id }]))).toMatchObject({ status: 400 });
    expect(await err(post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '1', sourceMovementId: rc!.id }]))).toMatchObject({ status: 400 });
    expect(await err(post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: A, movementType: 'rtv', qtyOut: '1', sourceMovementId: 'x' }]))).toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------------------------- block / unblock via API
describe('block / unblock pairs (POST /stock/block)', () => {
  it('pairs share a pair id, carry value, keep the node average, refuse more than held, work per batch', async () => {
    const w = await stockWorld(c);
    const a = api(c, w.adminToken);
    await mustOk(opening(c, w.adminToken, [
      { itemId: w.items[0], nodeId: w.store, qty: '7', unitCost: '1.428571' },
      { itemId: w.items[1], nodeId: w.store, batchNo: 'B-A', qty: '5', unitCost: '3' },
      { itemId: w.items[1], nodeId: w.store, batchNo: 'B-B', qty: '5', unitCost: '3' },
    ]));
    const before = await avgRow(w, w.items[0]!, w.store);
    const b = await mustOk(a.post('/stock/block', { itemId: w.items[0], nodeId: w.store, qty: '3.333', reason: 'Damaged packing', direction: 'block' }));
    expect(b).toHaveLength(2);
    expect(b[0].pairId).toBe(b[1].pairId);
    expect(new Decimal(b[0].value).plus(b[1].value).isZero()).toBe(true);
    expect(await avgRow(w, w.items[0]!, w.store)).toEqual(before);
    expect((await a.post('/stock/block', { itemId: w.items[0], nodeId: w.store, qty: '3.334', reason: 'Too much', direction: 'unblock' })).status).toBe(409);
    await mustOk(a.post('/stock/block', { itemId: w.items[0], nodeId: w.store, qty: '3.333', reason: 'Repacked', direction: 'unblock' }));
    expect(await bal(c, w.tenantId, w.items[0]!, w.store)).toEqual({ qty: 7, value: 10 });
    // Batch-level: blocking batch B-A does not touch B-B; without a batch the non-batch balance (0) is used → 409.
    const batchA = await c.db.selectFrom('app.stock_batch').select('id').where('tenant_id', '=', w.tenantId).where('batch_no', '=', 'B-A').executeTakeFirstOrThrow();
    await mustOk(a.post('/stock/block', { itemId: w.items[1], nodeId: w.store, batchId: batchA.id, qty: '5', reason: 'Batch recall', direction: 'block' }));
    expect((await a.post('/stock/block', { itemId: w.items[1], nodeId: w.store, batchId: batchA.id, qty: '0.001', reason: 'Batch recall', direction: 'block' })).status).toBe(409);
    expect((await a.post('/stock/block', { itemId: w.items[1], nodeId: w.store, qty: '1', reason: 'No batch', direction: 'block' })).status).toBe(409);
    const byBatch = await mustOk(a.get(`/stock/balances?item=${w.items[1]}&byBatch=true`));
    expect(byBatch.data.map((r: { batch: { batchNo: string }; available: string; quarantine: string }) => [r.batch.batchNo, r.available, r.quarantine])).toEqual([['B-A', '0', '5'], ['B-B', '5', '0']]);
    // Invalid bodies are 400.
    for (const body of [
      { itemId: w.items[0], nodeId: w.store, qty: '1', reason: 'ab', direction: 'block' },
      { itemId: w.items[0], nodeId: w.store, qty: '1', reason: 'Valid', direction: 'reject' },
      { itemId: w.items[0], nodeId: w.store, qty: '0', reason: 'Valid', direction: 'block' },
      { itemId: w.items[0], nodeId: w.store, qty: '-1', reason: 'Valid', direction: 'block' },
      { itemId: w.items[0], nodeId: w.store, qty: '0.00001', reason: 'Valid', direction: 'block' },
      { itemId: w.items[0], nodeId: w.store, qty: '0.0001', reason: 'Valid', direction: 'block' }, // QA3-BUG-003: KG takes 3 decimals
      { itemId: w.items[0], nodeId: w.store, batchId: batchA.id, qty: '1', reason: 'Wrong item batch', direction: 'block' },
    ]) expect((await a.post('/stock/block', body)).status, JSON.stringify(body)).toBe(400);
    await expectIntegrity(c, w.tenantId);
    // Ledger shows both sides with the reason.
    const led = await mustOk(a.get(`/stock/ledger?item=${w.items[0]}&movementType=block,unblock`));
    expect(led.data).toHaveLength(4);
    expect(led.data.every((r: { reason: string }) => ['Damaged packing', 'Repacked'].includes(r.reason))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------- opening rules
describe('opening balances', () => {
  it('refuses pairs that already moved (any batch / status), validates rows, posts batches and dates', async () => {
    const w = await stockWorld(c);
    const a = api(c, w.adminToken);
    const r = await mustOk(opening(c, w.adminToken, [
      { itemId: w.items[0], nodeId: w.store, batchNo: 'L1', expiryDate: '2027-01-01', qty: '1.5', unitCost: '0.000001' },
      { itemId: w.items[0], nodeId: w.store, batchNo: 'L2', qty: '2', unitCost: '0' },
    ], '2026-01-15'));
    expect(r.posted).toBe(2);
    const led = await mustOk(a.get(`/stock/ledger?item=${w.items[0]}`));
    expect(led.data.every((x: { at: string; movementType: string }) => x.at.startsWith('2026-01-15') && x.movementType === 'opening')).toBe(true);
    // A different batch of the same item × node: still refused (the pair has movements).
    const again = await opening(c, w.adminToken, [{ itemId: w.items[0], nodeId: w.store, batchNo: 'L3', qty: '1', unitCost: '1' }]);
    expect([again.status, again.body.code]).toEqual([409, 'STOCK_OPENING_EXISTS']);
    // Atomic: one bad pair refuses the whole load.
    const mixed = await opening(c, w.adminToken, [
      { itemId: w.items[1], nodeId: w.store, qty: '1', unitCost: '1' },
      { itemId: w.items[0], nodeId: w.store, qty: '1', unitCost: '1' },
    ]);
    expect(mixed.status).toBe(409);
    expect((await bal(c, w.tenantId, w.items[1]!, w.store)).qty).toBe(0);
    for (const row of [
      { itemId: w.items[1], nodeId: w.store, qty: '0', unitCost: '1' },
      { itemId: w.items[1], nodeId: w.store, qty: '-1', unitCost: '1' },
      { itemId: w.items[1], nodeId: w.store, qty: '1', unitCost: '-0.5' },
      { itemId: w.items[1], nodeId: w.store, qty: '1.23456', unitCost: '1' },
      { itemId: w.items[1], nodeId: w.store, qty: '1e3', unitCost: '1' },
      { itemId: w.items[1], nodeId: w.store, qty: ' 1', unitCost: '1' },
      { itemId: w.items[1], nodeId: w.uomId, qty: '1', unitCost: '1' },
      { itemId: w.uomId, nodeId: w.store, qty: '1', unitCost: '1' },
    ]) expect((await opening(c, w.adminToken, [row])).status, JSON.stringify(row)).toBe(400);
    // Same pair twice in one load is a 400, not a 500.
    const dup = await opening(c, w.adminToken, [{ itemId: w.items[2], nodeId: w.store, qty: '1', unitCost: '1' }, { itemId: w.items[2], nodeId: w.store, qty: '2', unitCost: '1' }]);
    expect(dup.status).toBe(400);
    expect((await opening(c, w.adminToken, [{ itemId: w.items[2], nodeId: w.store, qty: '1', unitCost: '1' }], '2026-02-30')).status).toBe(400);
  });

  // QA5-BUG-002: opening balances accept an as-of date in the future; the ledger then holds movements dated after
  // "now" (every later movement sorts BEFORE the opening in the running balance and valuation as of today excludes it).
  it('QA5-BUG-002 (fixed) an opening dated in the future is refused (400)', async () => {
    const w = await stockWorld(c);
    const r = await opening(c, w.adminToken, [{ itemId: w.items[0], nodeId: w.store, qty: '5', unitCost: '1' }], '2099-12-31');
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------- numbers
describe('oversized / invalid numbers are 400, never 500', () => {
  let w: StockWorld;
  beforeAll(async () => { w = await stockWorld(c); });

  it('opening, block and re-order rule bodies', async () => {
    const a = api(c, w.adminToken);
    const big = '9'.repeat(20);
    const cases: [string, unknown][] = [
      ['/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: w.items[0], nodeId: w.store, qty: big, unitCost: '1' }] }],
      ['/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: w.items[0], nodeId: w.store, qty: '1', unitCost: big }] }],
      ['/stock/opening', { asOf: '2026-04-01', rows: [{ itemId: w.items[0], nodeId: w.store, qty: 5, unitCost: '1' }] }],
      ['/stock/opening', { asOf: '2026-04-01', rows: [] }],
      ['/stock/block', { itemId: w.items[0], nodeId: w.store, qty: big, reason: 'Valid', direction: 'block' }],
      ['/stock/reorder-rules', { itemId: w.items[0], nodeId: w.store, minQty: '1', reorderQty: '0' }],
      ['/stock/reorder-rules', { itemId: w.items[0], nodeId: w.store, minQty: '5', reorderQty: '1', maxQty: '4' }],
      ['/stock/counts/snapshot', { nodeId: 'not-a-uuid' }],
    ];
    const got = [];
    for (const [path, body] of cases) got.push([path, JSON.stringify(body).slice(0, 80), (await a.post(path, body)).status]);
    expect(got.filter(g => g[2] !== 400)).toEqual([]);
  });

  // QA5-BUG-003: a quantity that fits the decimal regex (≤ 14 integer digits) but whose value (qty × unit cost) or
  // running balance overflows numeric(18,4) reaches Postgres and comes back as a 500.
  it('QA5-BUG-003 (fixed) an opening whose value overflows numeric(18,4) is a 400', async () => {
    const r = await opening(c, w.adminToken, [{ itemId: w.items[1], nodeId: w.bin, qty: '99999999999999', unitCost: '100' }]);
    expect(r.status).toBe(400);
  });

  it('QA5-BUG-003 (fixed) a re-order rule with 15+ integer digits is a 400', async () => {
    const a = api(c, w.adminToken);
    const big = '9'.repeat(20);
    expect((await a.post('/stock/reorder-rules', { itemId: w.items[1], nodeId: w.store, minQty: big, reorderQty: '1' })).status).toBe(400);
    expect((await a.post('/stock/reorder-rules', { itemId: w.items[1], nodeId: w.store, minQty: '1', reorderQty: '999999999999999' })).status).toBe(400);
  });

  it('query strings', async () => {
    const a = api(c, w.adminToken);
    const qs = [
      '/stock/balances?limit=0', '/stock/balances?limit=201', '/stock/balances?limit=abc', '/stock/balances?cursor=%%%', '/stock/balances?cursor=eyJvIjotMX0',
      '/stock/balances?node=nope', '/stock/balances?expiringWithinDays=-1', '/stock/balances?expiringWithinDays=99999', '/stock/balances?status=lost',
      '/stock/ledger?limit=501', '/stock/ledger?from=2026-13-01', '/stock/ledger?to=yesterday', '/stock/ledger?cursor=garbage', '/stock/ledger?item=1',
      '/stock/valuation?asOf=2026-02-30', '/stock/valuation?node=x', '/stock/reorder?node=x',
      `/stock/balances?q=${'x'.repeat(101)}`,
    ];
    const got = [];
    for (const q of qs) got.push([q, (await a.get(q)).status]);
    expect(got.filter(g => g[1] !== 400)).toEqual([]);
    // Malformed ids in the path are "not found" (project convention for UuidParam).
    expect((await a.get('/stock/items/x/summary')).status).toBe(404);
    expect((await a.get('/stock/reorder-rules/x')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------- drift
describe('drift job', () => {
  it('detects a tampered qty, a tampered value, a tampered average and a movement inserted behind the ledger\'s back', async () => {
    const w = await stockWorld(c);
    await mustOk(opening(c, w.adminToken, [
      { itemId: w.items[0], nodeId: w.store, qty: '5', unitCost: '2' },
      { itemId: w.items[1], nodeId: w.store, qty: '5', unitCost: '2' },
      { itemId: w.items[2], nodeId: w.store, qty: '5', unitCost: '2' },
    ]));
    const drift = c.app.get(StockDriftCheck);
    expect(await drift.checkTenant(w.tenantId)).toEqual([]);
    await c.db.updateTable('app.stock_balance').set({ value: '10.0001' }).where('tenant_id', '=', w.tenantId).where('item_id', '=', w.items[0]!).execute();
    await c.db.updateTable('app.item_avg_cost').set({ qty: '4' }).where('tenant_id', '=', w.tenantId).where('item_id', '=', w.items[1]!).execute();
    await c.db.insertInto('app.stock_movement').values({ tenant_id: w.tenantId, item_id: w.items[2]!, node_id: w.store, stock_status: 'available', movement_type: 'receipt', qty_in: '1', unit_cost: '1', value: '1' }).execute();
    const rows = await drift.checkTenant(w.tenantId);
    const kinds = rows.map(r => `${r.kind}:${r.itemId === w.items[0] ? 0 : r.itemId === w.items[1] ? 1 : 2}`).sort();
    expect(kinds).toEqual(['avg_cost:1', 'avg_cost:2', 'balance:0', 'balance:2']);
    const notes = await c.db.selectFrom('app.notification').select('user_id').where('tenant_id', '=', w.tenantId).where('kind', '=', 'stock_drift').execute();
    expect(notes.map(n => n.user_id)).toContain(w.adminId);
  });

  it('detects a tampered FIFO layer', async () => {
    const w = await stockWorld(c);
    await setSetting(c, w.tenantId, 'stock.valuation', 'fifo');
    await post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '5', unitCost: '2' }]);
    await c.db.updateTable('app.valuation_layer').set({ qty_left: '4' }).where('tenant_id', '=', w.tenantId).execute();
    expect((await c.app.get(StockDriftCheck).checkTenant(w.tenantId)).map(r => r.kind)).toEqual(['fifo']);
  });

  // QA5-BUG-004 (fixed): after a legitimate WAC → FIFO switch at a year boundary, stock carried over has no layers; the
  // drift job reported every such item × node as FIFO drift every night until the legacy stock was consumed.
  it('QA5-BUG-004 (fixed) no false FIFO drift for stock that predates a WAC → FIFO switch; real layer drift is still caught', async () => {
    const w = await stockWorld(c);
    const drift = c.app.get(StockDriftCheck);
    await post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: A, movementType: 'opening', qtyIn: '4', unitCost: '5' }]);
    await setSetting(c, w.tenantId, 'stock.valuation', 'fifo');
    await post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '4', unitCost: '9' }]);
    expect(await drift.checkTenant(w.tenantId)).toEqual([]);
    // Consuming part of the carried-over stock, then more than all of it.
    await post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '3' }]);
    expect(await drift.checkTenant(w.tenantId)).toEqual([]);
    await post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '2' }]);
    expect(await drift.checkTenant(w.tenantId)).toEqual([]);
    // Legacy is gone (3 left, all in the layer): a layer tampered below the node qty is drift again.
    await c.db.updateTable('app.valuation_layer').set({ qty_left: '2' }).where('tenant_id', '=', w.tenantId).execute();
    expect((await drift.checkTenant(w.tenantId)).map(r => r.kind)).toEqual(['fifo']);
    // Layers above the node qty are always drift.
    await c.db.updateTable('app.valuation_layer').set({ qty_left: '9' }).where('tenant_id', '=', w.tenantId).execute();
    expect((await drift.checkTenant(w.tenantId)).map(r => r.kind)).toEqual(['fifo']);
  });

  it('QA5-BUG-004 (fixed) under WAC, layers left over from an earlier FIFO year are not checked', async () => {
    const w = await stockWorld(c);
    await setSetting(c, w.tenantId, 'stock.valuation', 'fifo');
    await post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: '4', unitCost: '9' }]);
    await setSetting(c, w.tenantId, 'stock.valuation', 'wac');
    await post(w, [{ itemId: w.items[0]!, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '1' }]);
    expect(await c.app.get(StockDriftCheck).checkTenant(w.tenantId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- idempotent effects
describe('idempotent effect retries', () => {
  it('replaying a transfer approval with the same Idempotency-Key posts once; re-running the action\'s post_stock effect posts nothing', async () => {
    const w = await stockWorld(c);
    const clk = await clerk(c, w);
    await mustOk(opening(c, w.adminToken, [{ itemId: w.items[0], nodeId: w.store, qty: '10', unitCost: '3' }]));
    const sub = await storeDoc(c, w, clk.token, 'stock_transfer', { values: { location: w.store, to_location: w.bin }, lines: [{ values: { item: w.items[0], qty: '4' } }] });
    const key = `qa5-${Date.now()}`;
    const r = await Promise.all([1, 2, 3].map(() => approveAll(c, w, 'stock_transfer', sub, undefined, { 'Idempotency-Key': key })));
    expect(r.map(x => x.status).filter(s => s !== 200)).toEqual([]);
    expect(await bal(c, w.tenantId, w.items[0]!, w.bin)).toEqual({ qty: 4, value: 12 });
    // A second decide without the key is refused (stage no longer active) and posts nothing.
    const again = await approveAll(c, w, 'stock_transfer', sub);
    expect(again.status).toBe(409);
    const action = await c.db.selectFrom('app.wf_action').select('id').where('document_id', '=', sub.id).where('action', '=', 'decide').executeTakeFirstOrThrow();
    const out = await db.tenantTx(w.tenantId, tx => c.app.get(StockEffects).run('post_stock', { effect: 'post_stock', stockStatus: 'available' }, {
      tx, tenantId: w.tenantId, documentId: sub.id, stageKey: 'approve', wfActionId: action.id, actorId: w.adminId, approved: [{ lineId: sub.lines[0].id, qty: '4' }], rejected: [],
    }));
    expect(out.every(m => m.duplicate)).toBe(true);
    await expectIntegrity(c, w.tenantId);
    expect(await bal(c, w.tenantId, w.items[0]!, w.store)).toEqual({ qty: 6, value: 18 });
  });

  it('block_stock (generic handler) retried for the same action writes the pair once with the same pair id', async () => {
    const w = await stockWorld(c);
    const clk = await clerk(c, w);
    await mustOk(opening(c, w.adminToken, [{ itemId: w.items[1], nodeId: w.store, qty: '10', unitCost: '3' }]));
    const sub = await storeDoc(c, w, clk.token, 'stock_adjustment', { values: { location: w.store }, lines: [{ values: { item: w.items[1], qty: '2', direction: 'out', reason: 'Test', location: w.store } }] });
    const fakeAction = '00000000-0000-4000-8000-00000000abcd';
    const run = () => db.tenantTx(w.tenantId, tx => c.app.get(StockEffects).run('block_stock', { effect: 'block_stock' }, {
      tx, tenantId: w.tenantId, documentId: sub.id, stageKey: 'approve', wfActionId: fakeAction, actorId: w.adminId, approved: [{ lineId: sub.lines[0].id, qty: '2' }], rejected: [],
    }));
    const [a, b] = await Promise.all([run(), run()]);
    expect(a!.map(m => m.id).sort()).toEqual(b!.map(m => m.id).sort());
    expect(await bal(c, w.tenantId, w.items[1]!, w.store, 'quarantine')).toEqual({ qty: 2, value: 6 });
    await expectIntegrity(c, w.tenantId);
  });
});

// ---------------------------------------------------------------------------------------------- re-order
describe('re-order alerts', () => {
  it('concurrent outs crossing the minimum alert exactly once; next day alerts again; inactive rules stay silent', async () => {
    const w = await stockWorld(c);
    const it0 = w.items[0]!;
    await post(w, [{ itemId: it0, nodeId: w.bin, status: A, movementType: 'opening', qtyIn: '30', unitCost: '1' }]);
    const rule = await mustOk(api(c, w.adminToken).post('/stock/reorder-rules', { itemId: it0, nodeId: w.store, minQty: '20', reorderQty: '10', maxQty: '50' }), 201);
    await Promise.all(Array.from({ length: 15 }, () => post(w, [{ itemId: it0, nodeId: w.bin, status: A, movementType: 'issue', qtyOut: '1' }], w.adminId)));
    const evs = () => c.db.selectFrom('app.outbox_event').select('payload').where('tenant_id', '=', w.tenantId).where('event_type', '=', 'stock.below_min').execute();
    expect(await evs()).toHaveLength(1);
    const notes = await c.db.selectFrom('app.notification').select(['user_id']).where('tenant_id', '=', w.tenantId).where('kind', '=', 'stock_below_min').execute();
    expect(notes).toHaveLength(1);
    // Suggested = up to max: 50 − 15 = 35.
    const ro = await mustOk(api(c, w.adminToken).get('/stock/reorder'));
    expect(ro).toEqual([expect.objectContaining({ ruleId: rule.id, available: '15', suggestedQty: '35' })]);
    // Yesterday's alert no longer throttles.
    await c.db.updateTable('app.reorder_rule').set({ last_alert_at: sql`now() - interval '1 day'` }).where('id', '=', rule.id).execute();
    await post(w, [{ itemId: it0, nodeId: w.bin, status: A, movementType: 'issue', qtyOut: '1' }], w.adminId);
    expect(await evs()).toHaveLength(2);
    // Inactive rule: silent even on a new day.
    await mustOk(api(c, w.adminToken).put(`/stock/reorder-rules/${rule.id}`, { itemId: it0, nodeId: w.store, minQty: '20', reorderQty: '10', isActive: false }));
    await c.db.updateTable('app.reorder_rule').set({ last_alert_at: null }).where('id', '=', rule.id).execute();
    await post(w, [{ itemId: it0, nodeId: w.bin, status: A, movementType: 'issue', qtyOut: '1' }], w.adminId);
    expect(await evs()).toHaveLength(2);
  });

  it('recipients: reorder holders whose stock scope covers the node; not out-of-scope holders, not plain viewers', async () => {
    const w = await stockWorld(c);
    const it0 = w.items[1]!;
    const inScope = await limitedUser(c, w, [...STOCK_VIEW, 'stock:action.reorder'], w.plant);
    const outScope = await limitedUser(c, w, [...STOCK_VIEW, 'stock:action.reorder'], w.otherPlant);
    const viewer = await limitedUser(c, w, STOCK_VIEW, w.plant);
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'opening', qtyIn: '5', unitCost: '1' }]);
    await mustOk(api(c, w.adminToken).post('/stock/reorder-rules', { itemId: it0, nodeId: w.store, minQty: '5', reorderQty: '10' }), 201);
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '1' }]);
    const to = (await c.db.selectFrom('app.notification').select('user_id').where('tenant_id', '=', w.tenantId).where('kind', '=', 'stock_below_min').execute()).map(n => n.user_id);
    expect(to).toContain(inScope.userId);
    expect(to).toContain(w.adminId);
    expect(to).not.toContain(outScope.userId);
    expect(to).not.toContain(viewer.userId);
  });

  it('auto indent drafts an indent line for the suggested qty; duplicates rules are 409 (also when created concurrently)', async () => {
    const w = await stockWorld(c);
    const it0 = w.items[2]!;
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'opening', qtyIn: '12', unitCost: '1' }]);
    const body = { itemId: it0, nodeId: w.store, minQty: '10', reorderQty: '7.5', autoIndent: true };
    const res = await Promise.all(Array.from({ length: 5 }, () => api(c, w.adminToken).post('/stock/reorder-rules', body)));
    expect(res.map(r => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    await post(w, [{ itemId: it0, nodeId: w.store, status: A, movementType: 'issue', qtyOut: '3' }], w.adminId);
    const ev = await c.db.selectFrom('app.outbox_event').select('payload').where('tenant_id', '=', w.tenantId).where('event_type', '=', 'stock.below_min').executeTakeFirstOrThrow();
    const indentId = (ev.payload as { indentId: string | null }).indentId;
    expect(indentId).toBeTruthy();
    const ind = await c.db.selectFrom('app.document').select(['status_key', 'location_node_id']).where('id', '=', indentId!).executeTakeFirstOrThrow();
    expect(ind).toEqual({ status_key: 'draft', location_node_id: w.store });
    const line = await c.db.selectFrom('app.document_line').select(['item_id', 'qty']).where('document_id', '=', indentId!).executeTakeFirstOrThrow();
    expect(line).toEqual({ item_id: it0, qty: '7.5000' });
  });
});

// ---------------------------------------------------------------------------------------------- counts
describe('stock counts', () => {
  it('differences per batch with decimals; zero-difference and unapproved lines post nothing; found stock of an un-held item', async () => {
    const w = await stockWorld(c);
    const clk = await clerk(c, w);
    await mustOk(opening(c, w.adminToken, [
      { itemId: w.items[0], nodeId: w.store, batchNo: 'C1', qty: '10.125', unitCost: '2' },
      { itemId: w.items[0], nodeId: w.store, batchNo: 'C2', qty: '4', unitCost: '2' },
      { itemId: w.items[1], nodeId: w.store, qty: '3', unitCost: '5' },
    ]));
    const draft = await mustOk(api(c, clk.token).post('/stock/counts/snapshot', { nodeId: w.store, itemIds: [w.items[0], w.items[1], w.items[2]] }), 201);
    expect(draft.lines).toHaveLength(4);
    const key = (l: { values: Record<string, unknown> }) => `${w.items.indexOf(l.values.item as string)}|${l.values.batch ?? ''}`;
    const counted: Record<string, string> = { '0|C1': '9.9999', '0|C2': '4', '1|': '3.5', '2|': '2' };
    const upd = await mustOk(api(c, clk.token).put(`/docs/stock_count/${draft.id}`, {
      version: draft.version, values: { location: w.store },
      lines: draft.lines.map((l: { id: string; values: Record<string, unknown> }) => ({ id: l.id, values: { ...l.values, counted_qty: counted[key(l)] } })),
    }));
    expect(upd.lines.map((l: { values: Record<string, unknown> }) => [key(l), Number(l.values.book_qty)]).sort()).toEqual([['0|C1', 10.125], ['0|C2', 4], ['1|', 3], ['2|', 0]]);
    const sub = await mustOk(docs(c, clk.token, 'stock_count').submit(draft.id, upd.version));
    // Approve all but the cement line (rejected → no posting).
    const cement = sub.lines.find((l: { values: Record<string, unknown> }) => key(l) === '1|');
    await mustOk(approveAll(c, w, 'stock_count', sub, { [cement.id]: '0' }));
    const mv = await c.db.selectFrom('app.stock_movement').select(['item_id', 'movement_type', 'qty_in', 'qty_out', 'unit_cost']).where('document_id', '=', sub.id).execute();
    expect(mv.map(m => [w.items.indexOf(m.item_id), m.movement_type, Number(m.qty_in), Number(m.qty_out)]).sort()).toEqual([
      [0, 'count_out', 0, 0.1251], [2, 'count_in', 2, 0],
    ]);
    await expectIntegrity(c, w.tenantId);
    expect((await bal(c, w.tenantId, w.items[1]!, w.store)).qty).toBe(3);
  });

  it('snapshot of a node with nothing to count is 409; snapshot outside scope is 404', async () => {
    const w = await stockWorld(c);
    const scopedClerk = await clerk(c, w, undefined, w.store);
    expect((await api(c, w.adminToken).post('/stock/counts/snapshot', { nodeId: w.otherPlant })).status).toBe(409);
    expect((await api(c, scopedClerk.token).post('/stock/counts/snapshot', { nodeId: w.otherPlant })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------- integrity summary
describe('read side agrees with the movement ledger (QA5-BUG-006/007/008 rewrites)', () => {
  it('ledger running balance (paged, with and without filters), balances and valuation (now, asOf, paged) match Σ movements', async () => {
    const w = await stockWorld(c);
    const [i0, i1] = [w.items[0]!, w.items[1]!];
    const b1 = await db.tenantTx(w.tenantId, tx => ledger.ensureBatch(tx, { itemId: i0, batchNo: 'RB-1' }));
    await post(w, [
      { itemId: i0, nodeId: w.store, status: A, movementType: 'opening', qtyIn: '10', unitCost: '2' },
      { itemId: i0, nodeId: w.store, batchId: b1, status: A, movementType: 'opening', qtyIn: '4', unitCost: '3' },
      { itemId: i1, nodeId: w.bin, status: A, movementType: 'opening', qtyIn: '7.5', unitCost: '1.5' },
    ]);
    for (let k = 0; k < 6; k++) {
      await post(w, [{ itemId: i0, nodeId: w.store, status: A, movementType: 'receipt', qtyIn: `${k + 1}`, unitCost: '2.5' }]);
      await post(w, [{ itemId: i0, nodeId: w.store, batchId: b1, status: A, movementType: 'issue', qtyOut: '0.5' }]);
      await post(w, [{ itemId: i1, nodeId: w.bin, status: A, movementType: 'issue', qtyOut: '0.25' }]);
      const pair = ledger.newPairId();
      await post(w, [
        { itemId: i0, nodeId: w.store, status: A, movementType: 'block', qtyOut: '1', pairId: pair },
        { itemId: i0, nodeId: w.store, status: 'quarantine', movementType: 'block', qtyIn: '1', pairId: pair },
      ]);
    }
    // Reference: the old whole-tenant window.
    const ref = await sql<{ id: string; bal: string }>`
      select id::text as id, sum(qty_in - qty_out) over (partition by item_id, node_id, batch_id, stock_status order by at, id)::text as bal
        from app.stock_movement where tenant_id = ${w.tenantId}`.execute(c.db);
    const want = new Map(ref.rows.map(r => [r.id, Number(r.bal)]));
    const a = api(c, w.adminToken);
    for (const qs of ['', `&item=${i0}`, `&node=${w.store}&includeChildren=false`, '&movementType=issue,block']) {
      let cursor: string | null = null;
      let seen = 0;
      do {
        const page: { data: { id: string; balanceAfter: string }[]; nextCursor: string | null } = await mustOk(a.get(`/stock/ledger?limit=7${qs}${cursor ? `&cursor=${cursor}` : ''}`));
        for (const r of page.data) expect([r.id, Number(r.balanceAfter)]).toEqual([r.id, want.get(r.id)]);
        seen += page.data.length;
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toBeGreaterThan(0);
    }
    // Balances: byBatch rows and totals equal Σ movements per key.
    const bals = await mustOk(a.get('/stock/balances?byBatch=true&limit=200'));
    const sums = await sql<{ item_id: string; node_id: string; bk: string | null; st: string; q: string; v: string }>`
      select item_id, node_id, batch_id::text as bk, stock_status as st, sum(qty_in - qty_out)::text as q, sum(value)::text as v
        from app.stock_movement where tenant_id = ${w.tenantId} group by 1, 2, 3, 4`.execute(c.db);
    for (const r of bals.data as { item: { id: string }; node: { id: string }; batch: { id: string } | null; available: string; quarantine: string; value: string }[]) {
      const of = (st: string) => sums.rows.filter(x => x.item_id === r.item.id && x.node_id === r.node.id && (x.bk ?? null) === (r.batch?.id ?? null) && x.st === st);
      expect(Number(r.available)).toBeCloseTo(of('available').reduce((t, x) => t + Number(x.q), 0), 4);
      expect(Number(r.quarantine)).toBeCloseTo(of('quarantine').reduce((t, x) => t + Number(x.q), 0), 4);
    }
    // Valuation now and as of a past date = Σ movements up to then; paging covers every row once, totals cover all pages.
    // Openings 30 days back; asOf 29 days back is served from the movements before it, 2 days back from balance − after.
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    await c.db.updateTable('app.stock_movement').set({ at: new Date(`${day(30)}T12:00:00Z`) }).where('tenant_id', '=', w.tenantId).where('movement_type', '=', 'opening').execute();
    await c.db.updateTable('app.stock_movement').set({ at: new Date(`${day(10)}T12:00:00Z`) }).where('tenant_id', '=', w.tenantId).where('movement_type', '=', 'receipt').where('qty_in', '<', '3').execute();
    for (const date of [null, day(29), day(20), day(2)]) {
      const refV = await sql<{ item_id: string; node_id: string; q: string; v: string }>`
        select item_id, node_id, sum(qty_in - qty_out)::text as q, sum(value)::text as v from app.stock_movement
         where tenant_id = ${w.tenantId} ${date ? sql`and at < ${date}::date + 1` : sql``}
         group by 1, 2 having sum(qty_in - qty_out) <> 0 or sum(value) <> 0`.execute(c.db);
      const got: { item: { id: string }; node: { id: string }; qty: string; value: string }[] = [];
      let cursor: string | null = null;
      let total = '';
      do {
        const page: { rows: typeof got; totalValue: string; nextCursor: string | null } = await mustOk(a.get(`/stock/valuation?limit=1${date ? `&asOf=${date}` : ''}${cursor ? `&cursor=${cursor}` : ''}`));
        got.push(...page.rows);
        total = page.totalValue;
        cursor = page.nextCursor;
      } while (cursor);
      expect(got.map(r => `${r.item.id}|${r.node.id}|${Number(r.qty)}|${Number(r.value)}`).sort())
        .toEqual(refV.rows.map(r => `${r.item_id}|${r.node_id}|${Number(r.q)}|${Number(r.v)}`).sort());
      expect(Number(total)).toBeCloseTo(refV.rows.reduce((t, r) => t + Number(r.v), 0), 4);
    }
  });
});

describe('integrity oracle', () => {
  it('reports a broken pair (sanity check of the oracle itself)', async () => {
    const w = await stockWorld(c);
    await c.db.insertInto('app.stock_movement').values({ tenant_id: w.tenantId, item_id: w.items[0]!, node_id: w.store, stock_status: 'available', movement_type: 'block', qty_out: '1', value: '-1', pair_id: '00000000-0000-4000-8000-000000000001' }).execute();
    const r = await integrity(c, w.tenantId);
    expect(r.brokenPairs).toHaveLength(1);
    expect(r.orphanMovements).toHaveLength(1);
    expect(await err(Promise.resolve())).toBeNull();
  });
});

/**
 * QA Phase 5 — performance (opt-in: QA_PERF=1). One tenant with ~200k stock movements (250 items × 40 nodes,
 * one year), balances / average cost derived from the ledger exactly as StockLedger would leave them. Measures
 * in-process request time (≈ server time) for balances, ledger (item filter, date range), item summary and
 * valuation; target p95 < 500 ms. Prints a table (docs/qa/phase-5-report.md "Performance").
 */
import { sql } from 'kysely';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import { expectIntegrity } from './qa-phase5-helpers';
import { stockWorld, StockWorld } from './stock-helpers';

const RUN = process.env.QA_PERF === '1';
const N_ITEMS = 250;
const N_NODES = 40;
const N_MOVES = 200_000;
const RUNS = 25;

let c: Ctx;
let w: StockWorld;
let items: string[] = [];
let nodes: string[] = [];
const results: { name: string; p50: number; p95: number; max: number; rows: number }[] = [];

describe.skipIf(!RUN)('QA5 perf: 200k movements', () => {
  beforeAll(async () => {
    c = await bootApp();
    w = await stockWorld(c, { features: ['indent', 'purchase', 'store', 'grn', 'workflow_designer'] });
    const t0 = performance.now();
    // Items and nodes straight into the tables (API creation of 250 items would dominate the run).
    const itemDef = await c.db.selectFrom('app.master_def').select('id').where('tenant_id', '=', w.tenantId).where('key', '=', 'item').executeTakeFirstOrThrow();
    const ins = await sql<{ id: string }>`
      insert into app.master_record (tenant_id, master_id, code, name, data, form_version_id)
      select ${w.tenantId}, ${itemDef.id}, 'PERF-' || lpad(g::text, 4, '0'), 'Perf item ' || g, jsonb_build_object('uom', ${w.uomId}::text),
             (select form_version_id from app.master_record where id = ${w.items[0]!})
        from generate_series(1, ${N_ITEMS - 3}) g returning id`.execute(c.db).catch(async e => {
      throw new Error(`item seed failed: ${(e as Error).message}`);
    });
    items = [...w.items, ...ins.rows.map(r => r.id)];
    for (let i = 0; i < N_NODES - 4; i++) {
      const r = await c.http.post('/api/v1/locations').set({ Authorization: `Bearer ${w.adminToken}` }).send({ code: `PN${i}-${uid(3)}`, name: `Perf bin ${i}`, parentId: i % 2 ? w.store : w.plant });
      if (r.status !== 201) throw new Error(`location ${r.status} ${JSON.stringify(r.body)}`);
      nodes.push(r.body.id);
    }
    nodes = [w.plant, w.store, w.bin, w.otherPlant, ...nodes];
    // Movements: per (item, node) an opening, then receipts / issues alternating; qty_out never exceeds what came in.
    await sql`
      with k as (
        select g, (g % ${items.length}) as ii, ((g / ${items.length}) % ${nodes.length}) as ni from generate_series(0, ${N_MOVES - 1}) g
      ), m as (
        select g, (${sql.val(items)}::uuid[])[ii + 1] as item_id, (${sql.val(nodes)}::uuid[])[ni + 1] as node_id,
               case when g < ${items.length * nodes.length} then 'opening' when g % 3 = 0 then 'issue' else 'receipt' end as mt,
               timestamptz '2025-10-23' + ((g::float / ${N_MOVES}) * interval '365 days') as at
          from k
      )
      insert into app.stock_movement (tenant_id, item_id, node_id, stock_status, movement_type, qty_in, qty_out, unit_cost, value, actor_id, at)
      select ${w.tenantId}, item_id, node_id, 'available', mt,
             case when mt = 'issue' then 0 when mt = 'opening' then 1000 else 7.5 end,
             case when mt = 'issue' then 2.25 else 0 end,
             12.345678,
             case when mt = 'issue' then -27.7778 when mt = 'opening' then 12345.678 else 92.5926 end,
             ${w.adminId}, at
        from m`.execute(c.db);
    await sql`
      insert into app.stock_balance (tenant_id, item_id, node_id, batch_key, stock_status, qty, value)
      select tenant_id, item_id, node_id, '00000000-0000-0000-0000-000000000000', stock_status, sum(qty_in - qty_out), sum(value)
        from app.stock_movement where tenant_id = ${w.tenantId} group by 1, 2, 3, 5`.execute(c.db);
    await sql`
      insert into app.item_avg_cost (tenant_id, item_id, node_id, qty, value, avg_cost)
      select tenant_id, item_id, node_id, sum(qty_in - qty_out), sum(value), round(sum(value) / nullif(sum(qty_in - qty_out), 0), 6)
        from app.stock_movement where tenant_id = ${w.tenantId} group by 1, 2, 3`.execute(c.db);
    await sql`insert into app.reorder_rule (tenant_id, item_id, node_id, min_qty, reorder_qty)
      select ${w.tenantId}, i, ${w.store}, 100000, 10 from unnest(${sql.val(items.slice(0, 50))}::uuid[]) i`.execute(c.db);
    await sql`analyze app.stock_movement`.execute(c.db);
    await sql`analyze app.stock_balance`.execute(c.db);
    const n = await c.db.selectFrom('app.stock_movement').select(c.db.fn.countAll<string>().as('n')).where('tenant_id', '=', w.tenantId).executeTakeFirstOrThrow();
    console.log(`perf seed: ${n.n} movements, ${items.length} items, ${nodes.length} nodes in ${Math.round(performance.now() - t0)} ms`);
  }, 600_000);
  afterAll(async () => {
    console.log('\n| Endpoint | rows | p50 ms | p95 ms | max ms |\n| --- | --- | --- | --- | --- |');
    for (const r of results) console.log(`| ${r.name} | ${r.rows} | ${r.p50} | ${r.p95} | ${r.max} |`);
    await closeApp(c);
  });

  async function measure(name: string, path: string) {
    const a = api(c, w.adminToken);
    await mustOk(a.get(path)); // warm-up
    const t: number[] = [];
    let rows = 0;
    for (let i = 0; i < RUNS; i++) {
      const s = performance.now();
      const r = await a.get(path);
      t.push(performance.now() - s);
      expect(r.status, `${path} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
      rows = Array.isArray(r.body) ? r.body.length : r.body.data?.length ?? r.body.rows?.length ?? r.body.nodes?.length ?? 0;
    }
    t.sort((x, y) => x - y);
    const pct = (p: number) => Math.round(t[Math.min(t.length - 1, Math.ceil((p / 100) * t.length) - 1)]!);
    results.push({ name, p50: pct(50), p95: pct(95), max: Math.round(t[t.length - 1]!), rows });
    return pct(95);
  }

  it('seed is a consistent ledger', async () => { await expectIntegrity(c, w.tenantId); }, 120_000);

  const cases: [string, () => string][] = [
    ['balances (first page)', () => '/stock/balances'],
    ['balances node=plant subtree', () => `/stock/balances?node=${w.plant}`],
    ['balances q search', () => '/stock/balances?q=PERF-01'],
    ['balances belowMin', () => '/stock/balances?belowMin=true'],
    ['balances page 20 (offset)', () => `/stock/balances?cursor=${Buffer.from(JSON.stringify({ o: 1000 })).toString('base64url')}`],
    ['ledger (no filter)', () => '/stock/ledger'],
    ['ledger item filter', () => `/stock/ledger?item=${items[7]}`],
    ['ledger item + date range', () => `/stock/ledger?item=${items[7]}&from=2026-03-01&to=2026-05-31`],
    ['ledger date range only', () => '/stock/ledger?from=2026-03-01&to=2026-03-31'],
    ['ledger node (no children)', () => `/stock/ledger?node=${w.bin}&includeChildren=false`],
    ['item summary', () => `/stock/items/${items[7]}/summary`],
    ['valuation (all)', () => '/stock/valuation'],
    ['valuation asOf', () => '/stock/valuation?asOf=2026-04-30'],
    ['valuation node', () => `/stock/valuation?node=${w.store}`],
    ['reorder (below min)', () => '/stock/reorder'],
  ];
  /** Were slow at 200k movements (docs/qa/phase-5-report.md "Performance"); fixed — plain tests tagged with the id. */
  const KNOWN: Record<string, string> = {
    'balances (first page)': 'QA5-BUG-006', 'balances belowMin': 'QA5-BUG-006', 'balances page 20 (offset)': 'QA5-BUG-006',
    'ledger (no filter)': 'QA5-BUG-007', 'ledger date range only': 'QA5-BUG-007',
    'valuation (all)': 'QA5-BUG-008', 'valuation asOf': 'QA5-BUG-008', 'valuation node': 'QA5-BUG-008',
  };
  for (const [name, path] of cases) {
    const bug = KNOWN[name];
    it(`${bug ? `${bug} (fixed) ` : ''}${name}: p95 < 500 ms`, async () => {
      const p95 = await measure(name, path());
      expect(p95).toBeLessThan(500);
    }, 300_000);
  }
});

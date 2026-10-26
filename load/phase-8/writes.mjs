#!/usr/bin/env node
/**
 * Phase 8 write-path measurements on tenant `big` (real API calls, full ledger / workflow / stock posting):
 * per iteration
 *   1. buyer: 150 orderable indent lines of one store → POST /procurement/po/from-lines   (150-line PO draft)
 *   2. buyer: POST /docs/po/:id/submit                                                     (ledger: 150 × requested + ordered on the indent)
 *   3. plant approver: POST /docs/po/:id/actions decide, all 150 lines approved            ("workflow decide on a 150-line doc")
 *   4. store keeper: POST /inventory/grn/from-po with 100 PO lines, submit: true            ("GRN submit with 100 lines")
 *   5. approver: GRN gate decide (100 lines), then store decide (100 lines → 100 stock receipts)
 * 2 warm-up iterations + N measured (default 30). Results: load/results/phase-8/<label>-writes.json.
 *
 *   API=… DATABASE_MIGRATOR_URL=… node load/phase-8/writes.mjs <label> [N=30]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { call, loadAvg, login, stats } from './lib.mjs';

const [label = 'run', nArg] = process.argv.slice(2);
const N = Number(nArg ?? 30);
const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure_load' });
await db.connect();
const tid = (await db.query(`select id from platform.tenant where code = 'big'`)).rows[0].id;
const rates = new Map((await db.query(`select r.id, r.data->>'std_rate' rate from app.master_record r join app.master_def m on m.id = r.master_id
  where r.tenant_id = $1 and m.key = 'item'`, [tid])).rows.map(r => [r.id, r.rate]));
const vendors = (await db.query(`select r.id from app.master_record r join app.master_def m on m.id = r.master_id where r.tenant_id = $1 and m.key = 'vendor' order by r.code`, [tid])).rows.map(r => r.id);
// stores with their keeper / plant approver (keeper k covers store k; approver p covers plant p)
const stores = (await db.query(`select n.id, n.code, split_part(n.code::text, '-', 1) plant from app.location_node n where n.tenant_id = $1 and n.depth = 2 order by n.code`, [tid])).rows;
await db.end();

const tok = {};
const token = async email => (tok[email] ??= await login('big', email, 'Admin@12345'));
const must = async (what, method, path, opts) => {
  const r = await call(method, path, opts);
  if (r.status >= 400) throw new Error(`${what}: ${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 600)}`);
  return r;
};

const series = { createPo: [], submitPo: [], decidePo: [], grnSubmit: [], grnGate: [], grnStore: [] };
const la0 = await loadAvg();
let si = 0;
for (let it = 0; it < N + 2; it++) {
  // pick a store with ≥ 150 orderable lines (rotate across stores)
  let store, picks;
  for (let tries = 0; tries < stores.length; tries++) {
    store = stores[si++ % stores.length];
    const buyer = await token('buyer_all1@big.test');
    const lines = [];
    let cursor;
    while (lines.length < 150) {
      const r = await must('orderable', 'GET', `/procurement/orderable-lines?limit=500&location=${store.id}${cursor ? `&cursor=${cursor}` : ''}`, { token: buyer });
      lines.push(...r.body.data);
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    if (lines.length >= 150) { picks = lines.slice(0, 150); break; }
  }
  if (!picks) throw new Error('no store with 150 orderable lines left');
  const vendorId = vendors[it % vendors.length];
  const buyer = await token('buyer_all1@big.test');
  const approver = await token(`approver${store.plant.slice(1)}@big.test`);
  const storeIdx = stores.findIndex(s => s.id === store.id) + 1;
  const keeper = await token(`keeper${storeIdx}@big.test`);
  const keep = it >= 2;

  const c1 = await must('po/from-lines', 'POST', '/procurement/po/from-lines', {
    token: buyer,
    body: { picks: picks.map(p => ({ sourceLineId: p.sourceLineId, qty: p.pendingOrder, vendorId, rate: rates.get(p.item.id) })), values: { location: store.id } },
  });
  const po = c1.body[0];
  const c2 = await must('po submit', 'POST', `/docs/po/${po.id}/submit`, { token: buyer, body: { version: po.version } });
  const lines = c2.body.lines;
  const c3 = await must('po decide', 'POST', `/docs/po/${po.id}/actions`, {
    token: approver, body: { action: 'decide', stageKey: 'approve', decisions: lines.map(l => ({ lineId: l.id, approve: l.values?.qty ?? l.qty })) },
  });
  const rec = await must('receivable', 'GET', `/inventory/receivable-po-lines?po=${po.id}&limit=200`, { token: keeper });
  const grnLines = rec.body.data.slice(0, 100);
  const c4 = await must('grn from-po', 'POST', '/inventory/grn/from-po', {
    token: keeper,
    body: { lines: grnLines.map(l => ({ poLineId: l.poLineId, qty: l.pendingReceipt })), values: { challan_no: `LT-${it}`, invoice_no: `LT/INV/${it}`, invoice_date: new Date().toISOString().slice(0, 10) }, submit: true },
  });
  const grn = c4.body[0];
  const gl = grn.lines.map(l => ({ lineId: l.id, approve: l.values?.qty ?? l.qty }));
  const c5 = await must('grn gate', 'POST', `/docs/grn/${grn.id}/actions`, { token: approver, body: { action: 'decide', stageKey: 'gate', decisions: gl } });
  const c6 = await must('grn store', 'POST', `/docs/grn/${grn.id}/actions`, { token: approver, body: { action: 'decide', stageKey: 'store', decisions: gl } });
  if (keep) {
    series.createPo.push(c1.ms); series.submitPo.push(c2.ms); series.decidePo.push(c3.ms);
    series.grnSubmit.push(c4.ms); series.grnGate.push(c5.ms); series.grnStore.push(c6.ms);
  }
  console.log(`#${it} ${store.code} PO ${po.number ?? po.id} create ${Math.round(c1.ms)} submit ${Math.round(c2.ms)} decide ${Math.round(c3.ms)} | GRN ${grn.lines.length} lines submit ${Math.round(c4.ms)} gate ${Math.round(c5.ms)} store ${Math.round(c6.ms)} ms (status ${c6.body.statusKey})`);
}
const la1 = await loadAvg();
const out = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, stats(v)]));
await mkdir(new URL('../results/phase-8/', import.meta.url), { recursive: true });
await writeFile(new URL(`../results/phase-8/${label}-writes.json`, import.meta.url), JSON.stringify({ label, at: new Date().toISOString(), loadAvg: [la0, la1], N, out }, null, 2));
console.log(`load avg ${la0} → ${la1}`);
console.log(JSON.stringify(out, null, 2));

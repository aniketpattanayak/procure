#!/usr/bin/env node
/**
 * Phase 8 read-path measurements against a running API (warm, sequential, keep-alive on localhost, so the client
 * time ≈ server time + < 1 ms). Each case: 3 warm-up calls, then N samples (default 30); p50 / p95 / max.
 * Writes load/results/phase-8/<label>.json and prints a markdown table.
 *
 *   API=http://localhost:4121/api/v1 DATABASE_MIGRATOR_URL=… node load/phase-8/measure.mjs <label> [filter-regex] [N=30]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { call, loadAvg, login, ok, stats } from './lib.mjs';

const [label = 'run', filter = '.', nArg] = process.argv.slice(2);
const N = Number(nArg ?? 30);
const re = new RegExp(filter);
const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure_load' });
await db.connect();
const one = async (q, p = []) => (await db.query(q, p)).rows[0];
const T = 'big';
const tid = (await one(`select id from platform.tenant where code = $1`, [T])).id;
const ty = async key => (await one(`select id from app.doc_type where tenant_id = $1 and key = $2`, [tid, key])).id;
const [indentT, poT] = [await ty('indent'), await ty('po')];

// ---------------------------------------------------------------- fixtures from the dataset
const plant3 = (await one(`select id from app.location_node where tenant_id = $1 and code = 'P3'`, [tid])).id;
const store2 = (await one(`select id from app.location_node where tenant_id = $1 and code = 'P1-S2'`, [tid])).id;
const big150 = (await one(`select document_id id from app.document_line where tenant_id = $1 and doc_type_id = $2 and line_no = 150
  order by created_at limit 1`, [tid, poT])).id;
const popularItem = (await one(`select item_id from app.document_line where tenant_id = $1 and doc_type_id = $2 group by item_id order by count(*) desc limit 1`, [tid, indentT])).item_id;
const rareItem = (await one(`select r.id from app.master_record r join app.master_def m on m.id = r.master_id where r.tenant_id = $1 and m.key = 'item' order by r.code desc limit 1`, [tid])).id;
const oldNumber = (await one(`select number from app.document where tenant_id = $1 and doc_type_id = $2 and number is not null order by created_at limit 1 offset 500`, [tid, indentT])).number;
const oldPoNumber = (await one(`select number from app.document where tenant_id = $1 and doc_type_id = $2 and number is not null order by created_at limit 1 offset 500`, [tid, poT])).number;
const vendorName = (await one(`select r.name from app.master_record r join app.master_def m on m.id = r.master_id where r.tenant_id = $1 and m.key = 'vendor' order by r.code limit 1 offset 7`, [tid])).name;
const enc = (v, id) => Buffer.from(JSON.stringify({ v, id })).toString('base64url');
async function docCursor(typeId, offset) {
  const r = await one(`select id, created_at::text v from app.document where tenant_id = $1 and doc_type_id = $2 and not is_deleted order by created_at desc, id desc offset $3 limit 1`, [tid, typeId, offset]);
  return enc(r.v, r.id);
}
async function lineCursor(typeId, offset) {
  const r = await one(`select id, created_at::text v from app.document_line where tenant_id = $1 and doc_type_id = $2 and not is_deleted order by created_at desc, id desc offset $3 limit 1`, [tid, typeId, offset]);
  return enc(r.v, r.id);
}
const curIndentDoc = await docCursor(indentT, 30_000);
const curPoDoc = await docCursor(poT, 22_000);
const curIndentLine = await lineCursor(indentT, 300_000);
const curPoLine = await lineCursor(poT, 230_000);
const nodeCount = Number((await one(`select count(*) n from app.location_node where tenant_id = $1`, [tid])).n);
await db.end();

// ---------------------------------------------------------------- users
const users = {};
for (const u of ['admin', 'approver1', 'indenter1', 'buyer1', 'buyer_all1', 'keeper1', 'manager1']) {
  users[u] = await login(T, `${u}@${T}.test`, 'Admin@12345');
}
const reports = await ok('GET', '/reports', { token: users.admin });
const rid = key => (reports.data ?? reports).find(r => r.key === key)?.id;
const dashList = await ok('GET', '/dashboards', { token: users.manager1 });
const dash = key => (dashList.data ?? dashList).find(d => d.layout?.builtin === key || d.key === key || d.builtin === key);

const cases = [
  // ---- indent, document-wise
  ['indent list first page (admin)', 'admin', 'GET', '/docs/indent?limit=50'],
  ['indent list status=approved', 'admin', 'GET', '/docs/indent?limit=50&status=approved'],
  ['indent list status=waiting_verify', 'admin', 'GET', '/docs/indent?limit=50&status=waiting_verify'],
  ['indent list search number (1 match)', 'admin', 'GET', `/docs/indent?limit=50&q=${encodeURIComponent(oldNumber)}`],
  ['indent list search text (common)', 'admin', 'GET', '/docs/indent?limit=50&q=shutdown'],
  ['indent list search text (no match)', 'admin', 'GET', '/docs/indent?limit=50&q=zzqx'],
  ['indent list location=plant (admin)', 'admin', 'GET', `/docs/indent?limit=50&location=${plant3}`],
  ['indent list scoped user (2 stores)', 'indenter1', 'GET', '/docs/indent?limit=50'],
  ['indent list deep cursor (30k)', 'admin', 'GET', `/docs/indent?limit=50&cursor=${curIndentDoc}`],
  ['indent list sort=number', 'admin', 'GET', '/docs/indent?limit=50&sort=number'],
  ['indent list item filter', 'admin', 'GET', `/docs/indent?limit=50&item=${popularItem}`],
  // ---- indent, item-wise
  ['indent items first page', 'admin', 'GET', '/docs/indent?view=item&limit=50'],
  ['indent items status=approved', 'admin', 'GET', '/docs/indent?view=item&limit=50&status=approved'],
  ['indent items search item name', 'admin', 'GET', '/docs/indent?view=item&limit=50&q=Bearing'],
  ['indent items search (no match)', 'admin', 'GET', '/docs/indent?view=item&limit=50&q=zzqx'],
  ['indent items scoped user', 'indenter1', 'GET', '/docs/indent?view=item&limit=50'],
  ['indent items location=store', 'admin', 'GET', `/docs/indent?view=item&limit=50&location=${store2}`],
  ['indent items deep cursor (300k)', 'admin', 'GET', `/docs/indent?view=item&limit=50&cursor=${curIndentLine}`],
  ['indent items item filter (rare)', 'admin', 'GET', `/docs/indent?view=item&limit=50&item=${rareItem}`],
  // ---- po
  ['po list first page', 'admin', 'GET', '/docs/po?limit=50'],
  ['po list status=partially_received', 'admin', 'GET', '/docs/po?limit=50&status=partially_received'],
  ['po list search number', 'admin', 'GET', `/docs/po?limit=50&q=${encodeURIComponent(oldPoNumber)}`],
  ['po list scoped buyer (plant)', 'buyer1', 'GET', '/docs/po?limit=50'],
  ['po list deep cursor (22k)', 'admin', 'GET', `/docs/po?limit=50&cursor=${curPoDoc}`],
  ['po items first page', 'admin', 'GET', '/docs/po?view=item&limit=50'],
  ['po items status=approved', 'admin', 'GET', '/docs/po?view=item&limit=50&status=approved'],
  ['po items search', 'admin', 'GET', '/docs/po?view=item&limit=50&q=Valve'],
  ['po items deep cursor (230k)', 'admin', 'GET', `/docs/po?view=item&limit=50&cursor=${curPoLine}`],
  // ---- counts
  ['indent counts (admin)', 'admin', 'GET', '/docs/indent/counts'],
  ['indent counts (scoped)', 'indenter1', 'GET', '/docs/indent/counts'],
  ['indent counts item-wise', 'admin', 'GET', '/docs/indent/counts?view=item'],
  ['po counts (admin)', 'admin', 'GET', '/docs/po/counts'],
  ['po counts search', 'admin', 'GET', '/docs/po/counts?q=PO%2F26'],
  // ---- inbox
  ['inbox busy approver (plant)', 'approver1', 'GET', '/approvals?limit=50'],
  ['inbox counts busy approver', 'approver1', 'GET', '/approvals/counts'],
  ['inbox overdue only', 'approver1', 'GET', '/approvals?limit=50&overdue=true'],
  ['inbox manager (all nodes)', 'manager1', 'GET', '/approvals?limit=50'],
  ['inbox counts manager', 'manager1', 'GET', '/approvals/counts'],
  // ---- detail
  ['PO detail 150 lines', 'admin', 'GET', `/docs/po/${big150}`],
  ['PO detail 150 lines (scoped buyer)', 'buyer1', 'GET', `/docs/po/${big150}`],
  ['PO timeline 150 lines', 'admin', 'GET', `/docs/po/${big150}/timeline`],
  ['PO taxes 150 lines', 'admin', 'GET', `/docs/po/${big150}/taxes`],
  // ---- pickers
  ['orderable lines (plant buyer)', 'buyer1', 'GET', '/procurement/orderable-lines?limit=100'],
  ['orderable lines (all-node buyer)', 'buyer_all1', 'GET', '/procurement/orderable-lines?limit=100'],
  ['orderable lines search', 'buyer_all1', 'GET', '/procurement/orderable-lines?limit=100&q=Valve'],
  ['receivable PO lines (keeper)', 'keeper1', 'GET', '/inventory/receivable-po-lines?limit=100'],
  ['receivable PO lines (admin)', 'admin', 'GET', '/inventory/receivable-po-lines?limit=100'],
  ['receivable PO lines vendor', 'admin', 'GET', `/inventory/receivable-po-lines?limit=100&q=${encodeURIComponent(vendorName)}`],
  ['issuable lines (keeper)', 'keeper1', 'GET', '/inventory/issuable-lines?limit=100'],
  // ---- stock
  ['stock balances first page', 'admin', 'GET', '/stock/balances?limit=50'],
  ['stock balances belowMin', 'admin', 'GET', '/stock/balances?limit=50&belowMin=true'],
  ['stock balances q', 'admin', 'GET', '/stock/balances?limit=50&q=Bearing'],
  ['stock balances (keeper scope)', 'keeper1', 'GET', '/stock/balances?limit=50'],
  ['stock ledger first page', 'admin', 'GET', '/stock/ledger?limit=100'],
  ['stock ledger item', 'admin', 'GET', `/stock/ledger?limit=100&item=${popularItem}`],
  ['stock ledger date range', 'admin', 'GET', '/stock/ledger?limit=100&from=2026-03-01&to=2026-03-31'],
  ['stock valuation', 'admin', 'GET', '/stock/valuation?limit=100'],
  ['stock valuation asOf', 'admin', 'GET', '/stock/valuation?limit=100&asOf=2026-06-30'],
  ['stock item summary', 'admin', 'GET', `/stock/items/${popularItem}/summary`],
  ['stock reorder', 'admin', 'GET', '/stock/reorder?limit=50'],
  // ---- reports (standard pack)
  ['report indent ageing', 'manager1', 'POST', () => `/reports/${rid('builtin_indent_ageing')}/run`, { params: {}, page: { limit: 200 } }],
  ['report PO pending delivery', 'manager1', 'POST', () => `/reports/${rid('builtin_po_pending_delivery')}/run`, { params: {}, page: { limit: 200 } }],
  ['report vendor performance', 'manager1', 'POST', () => `/reports/${rid('builtin_vendor_performance')}/run`, { params: {}, page: { limit: 200 } }],
  ['report stock summary', 'manager1', 'POST', () => `/reports/${rid('builtin_stock_summary')}/run`, { params: {}, page: { limit: 200 } }],
  ['report item movement (quarter)', 'manager1', 'POST', () => `/reports/${rid('builtin_item_movement_summary')}/run`, { params: { dateFrom: '2026-07-01', dateTo: '2026-09-30' }, page: { limit: 200 } }],
  ['report purchase value (this FY)', 'manager1', 'POST', () => `/reports/${rid('builtin_purchase_value')}/run`, { params: { datePreset: 'this_fy' }, page: { limit: 200 } }],
];

async function dashboardLoad(key, user) {
  const d = dash(key);
  if (!d) return null;
  const t0 = process.hrtime.bigint();
  const full = await ok('GET', `/dashboards/${d.id}`, { token: users[user] });
  const widgets = full.widgets ?? full.layout?.widgets ?? [];
  // the browser loads widgets with ~6 concurrent requests
  const queue = [...widgets];
  const errs = [];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      const r = await call('POST', `/dashboards/widgets/${w.id}/data`, { token: users[user], body: { dashboardId: d.id } });
      if (r.status >= 400) errs.push(`${w.id}:${r.status}`);
    }
  }));
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, errs, widgets: widgets.length };
}

const results = [];
const la0 = await loadAvg();
console.log(`label=${label} N=${N} load avg ${la0} (nodes ${nodeCount})`);
for (const [name, user, method, pathOrFn, body] of cases) {
  if (!re.test(name)) continue;
  const path = typeof pathOrFn === 'function' ? pathOrFn() : pathOrFn;
  const samples = [];
  let status = 0, bytes = 0, err = null;
  for (let i = 0; i < N + 3; i++) {
    const r = await call(method, path, { token: users[user], body });
    status = r.status; bytes = r.bytes;
    if (r.status >= 400) { err = JSON.stringify(r.body).slice(0, 200); break; }
    if (i >= 3) samples.push(r.ms);
  }
  const s = err ? { n: 0 } : stats(samples);
  results.push({ name, user, path, status, bytes, ...s, err });
  console.log(`${name.padEnd(40)} ${String(status).padEnd(4)} p50 ${String(s.p50).padStart(7)}  p95 ${String(s.p95).padStart(7)}  max ${String(s.max).padStart(7)}  ${bytes} B ${err ?? ''}`);
}
for (const [key, user] of [['procurement_overview', 'manager1'], ['store_overview', 'manager1'], ['my_work', 'approver1']]) {
  const name = `dashboard ${key} (${user})`;
  if (!re.test(name)) continue;
  const samples = [];
  let last = null;
  for (let i = 0; i < Math.min(N, 20) + 2; i++) {
    last = await dashboardLoad(key, user);
    if (!last) break;
    if (i >= 2) samples.push(last.ms);
  }
  if (!last) { console.log(`${name}: not found`); continue; }
  const s = stats(samples);
  results.push({ name, user, path: `dashboard:${key}`, status: last.errs.length ? 'errors' : 200, widgets: last.widgets, ...s, err: last.errs.join(',') || null });
  console.log(`${name.padEnd(40)} widgets ${last.widgets} p50 ${s.p50} p95 ${s.p95} max ${s.max} ${last.errs.join(',')}`);
}
const la1 = await loadAvg();
await mkdir(new URL('../results/phase-8/', import.meta.url), { recursive: true });
await writeFile(new URL(`../results/phase-8/${label}.json`, import.meta.url), JSON.stringify({ label, at: new Date().toISOString(), loadAvg: [la0, la1], N, results }, null, 2));
console.log(`load avg after: ${la1}`);
console.log('\n| Case | p50 ms | p95 ms | max ms |\n| --- | ---: | ---: | ---: |');
for (const r of results) console.log(`| ${r.name} | ${r.p50 ?? '—'} | ${r.p95 ?? '—'} | ${r.max ?? '—'} |`);

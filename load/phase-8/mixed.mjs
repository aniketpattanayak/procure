#!/usr/bin/env node
/**
 * Phase 8 concurrent throughput: V virtual users (default 20) in a CLOSED loop with no think time for D seconds
 * (default 180) against tenant `big` — a stress test of a 2-CPU box, not a model of human pacing. Mix per iteration:
 *   reads 75 %: indent/po lists (random status / item-wise / search), counts, inbox, document detail, pickers,
 *               stock balances / ledger, a report page
 *   writes 25 %: indent create + submit (10 lines), approve the top inbox indent (all lines), PO from 10 orderable
 *               lines + submit, store-issue create + submit (5 lines from stock)
 * Reports error rate, throughput and p50/p95 per operation and overall. Results: load/results/phase-8/<label>-mixed.json
 *
 *   API=… DATABASE_MIGRATOR_URL=… node load/phase-8/mixed.mjs <label> [V=20] [D=180]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { call, loadAvg, login, stats } from './lib.mjs';

const [label = 'run', vArg, dArg] = process.argv.slice(2);
const V = Number(vArg ?? 20), D = Number(dArg ?? 180) * 1000;
const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure_load' });
await db.connect();
const tid = (await db.query(`select id from platform.tenant where code = 'big'`)).rows[0].id;
const items = (await db.query(`select r.id, (r.data->>'uom') uom, r.data->>'std_rate' rate from app.master_record r join app.master_def m on m.id = r.master_id
  where r.tenant_id = $1 and m.key = 'item' order by r.code`, [tid])).rows;
const vendors = (await db.query(`select r.id from app.master_record r join app.master_def m on m.id = r.master_id where r.tenant_id = $1 and m.key = 'vendor'`, [tid])).rows.map(r => r.id);
const dept = (await db.query(`select r.id from app.master_record r join app.master_def m on m.id = r.master_id where r.tenant_id = $1 and m.key = 'department' limit 1`, [tid])).rows[0].id;
// stores: indenter / keeper index = store index (1..15) mod 12 / 15; approver = plant
const stores = (await db.query(`select n.id, n.code, split_part(n.code::text, '-', 1) plant, row_number() over (order by n.code)::int k from app.location_node n
  where n.tenant_id = $1 and n.depth = 2 order by n.code`, [tid])).rows;
const docIds = (await db.query(`select d.id, t.key from app.document d join app.doc_type t on t.id = d.doc_type_id where d.tenant_id = $1 and t.key in ('indent', 'po', 'grn')
  order by random() limit 2000`, [tid])).rows;
// stock on hand per store (for issues): item × node with qty ≥ 50
const stock = (await db.query(`select b.item_id, b.node_id, n.code, b.qty from app.stock_balance b join app.location_node n on n.id = b.node_id
  where b.tenant_id = $1 and b.qty >= 50 and n.depth = 2 order by random() limit 5000`, [tid])).rows;
await db.end();

const pick = a => a[Math.floor(Math.random() * a.length)];
const tok = {};
const token = async u => (tok[u] ??= await login('big', `${u}@big.test`, 'Admin@12345'));
const lat = new Map();
let errors = 0, total = 0;
const errorSamples = [];
async function op(name, method, path, t, body) {
  const r = await call(method, path, { token: t, body });
  total++;
  if (!lat.has(name)) lat.set(name, { ms: [], err: 0 });
  const e = lat.get(name);
  e.ms.push(r.ms);
  // 409 on a contended write (someone approved the same inbox item first, stock taken) is a business refusal, not a failure
  if (r.status >= 500 || (r.status >= 400 && r.status !== 409)) { errors++; e.err++; if (errorSamples.length < 20) errorSamples.push(`${name} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); }
  return r;
}

const reads = [
  async u => op('list indent', 'GET', `/docs/indent?limit=50${pick(['', '&status=approved', '&status=waiting_verify', '&status=rejected'])}`, await token(u)),
  async u => op('list po', 'GET', `/docs/po?limit=50${pick(['', '&status=received', '&status=partially_received', '&status=waiting_approve'])}`, await token(u)),
  async u => op('items indent', 'GET', `/docs/indent?view=item&limit=50${pick(['', '&status=approved'])}`, await token(u)),
  async u => op('search po', 'GET', `/docs/po?limit=50&q=${pick(['PO%2F26-27%2F001', 'PO%2F25-26%2F0', 'Valve'])}`, await token(u)),
  async u => op('counts', 'GET', `/docs/${pick(['indent', 'po', 'grn'])}/counts`, await token(u)),
  async () => op('inbox', 'GET', '/approvals?limit=50', await token(`approver${1 + Math.floor(Math.random() * 5)}`)),
  async () => op('inbox counts', 'GET', '/approvals/counts', await token(`approver${1 + Math.floor(Math.random() * 5)}`)),
  async () => { const d = pick(docIds); return op('detail', 'GET', `/docs/${d.key}/${d.id}`, await token('manager1')); },
  async () => op('orderable', 'GET', '/procurement/orderable-lines?limit=100', await token('buyer_all1')),
  async () => op('receivable', 'GET', '/inventory/receivable-po-lines?limit=100', await token(`keeper${1 + Math.floor(Math.random() * 15)}`)),
  async () => op('stock balances', 'GET', `/stock/balances?limit=50${pick(['', '&belowMin=true', '&q=Bolt'])}`, await token('manager1')),
  async () => op('stock ledger', 'GET', '/stock/ledger?limit=100', await token('manager1')),
];
const readUsers = ['admin', 'manager1', 'indenter1', 'buyer1', 'keeper1', 'buyer_all1'];

const writes = [
  // indent create + submit (10 lines) by the store's indenter
  async () => {
    const s = pick(stores.filter(x => x.k <= 12));
    const t = await token(`indenter${s.k}`);
    const lines = Array.from({ length: 10 }, () => { const it = pick(items); return { values: { item: it.id, uom: it.uom, qty: String(10 * (1 + Math.floor(Math.random() * 20))), required_date: '2026-12-15' } }; });
    const c = await op('indent create', 'POST', '/docs/indent', t, { values: { location: s.id, department: dept, priority: 'Normal', purpose: 'mixed load' }, lines });
    if (c.status < 300) await op('indent submit', 'POST', `/docs/indent/${c.body.id}/submit`, t, { version: c.body.version });
  },
  // approver approves the newest indent in their inbox
  async () => {
    const t = await token(`approver${1 + Math.floor(Math.random() * 5)}`);
    const ib = await op('inbox (write)', 'GET', '/approvals?limit=20&docType=indent', t);
    const item = ib.body?.data?.[Math.floor(Math.random() * Math.min(5, ib.body?.data?.length ?? 0))];
    if (!item) return;
    const doc = await op('detail (write)', 'GET', `/docs/indent/${item.documentId}`, t);
    if (doc.status >= 300) return;
    const decisions = doc.body.lines.filter(l => Number(l.qty?.pendingApproval ?? 0) > 0).map(l => ({ lineId: l.id, approve: l.qty.pendingApproval }));
    if (decisions.length) await op('indent decide', 'POST', `/docs/indent/${item.documentId}/actions`, t, { action: 'decide', stageKey: 'verify', decisions });
  },
  // buyer: PO from 10 orderable lines of one store + submit
  async () => {
    const t = await token('buyer_all1');
    const s = pick(stores);
    const r = await op('orderable (write)', 'GET', `/procurement/orderable-lines?limit=50&location=${s.id}`, t);
    const lines = (r.body?.data ?? []).sort(() => Math.random() - 0.5).slice(0, 10);
    if (lines.length < 3) return;
    const c = await op('po create', 'POST', '/procurement/po/from-lines', t, {
      picks: lines.map(l => ({ sourceLineId: l.sourceLineId, qty: l.pendingOrder, vendorId: pick(vendors), rate: items.find(i => i.id === l.item.id)?.rate ?? '10' })),
      values: { location: s.id },
    });
    if (c.status < 300) for (const po of c.body) await op('po submit', 'POST', `/docs/po/${po.id}/submit`, t, { version: po.version });
  },
  // keeper: store issue (5 lines from stock) create + submit
  async () => {
    const s = pick(stores);
    const t = await token(`keeper${s.k}`);
    const here = stock.filter(x => x.node_id === s.id);
    if (here.length < 5) return;
    const lines = here.sort(() => Math.random() - 0.5).slice(0, 5).map(x => ({ values: { item: x.item_id, qty: '1', location: s.id } }));
    const c = await op('issue create', 'POST', '/docs/store_issue', t, { values: { location: s.id, department: dept, issued_to: 'mixed load' }, lines });
    if (c.status < 300) await op('issue submit', 'POST', `/docs/store_issue/${c.body.id}/submit`, t, { version: c.body.version });
  },
];

for (const u of [...readUsers, 'approver1', 'approver2', 'approver3', 'approver4', 'approver5']) await token(u);
const la0 = await loadAvg();
const t0 = Date.now();
let iterations = 0;
const loadSamples = [];
const sampler = setInterval(async () => loadSamples.push(await loadAvg()), 15_000);
await Promise.all(Array.from({ length: V }, async (_, vu) => {
  const user = readUsers[vu % readUsers.length];
  while (Date.now() - t0 < D) {
    try {
      if (Math.random() < 0.25) await pick(writes)();
      else await pick(reads)(user);
    } catch (e) { errors++; total++; if (errorSamples.length < 20) errorSamples.push(String(e)); }
    iterations++;
  }
}));
clearInterval(sampler);
const secs = (Date.now() - t0) / 1000;
const la1 = await loadAvg();
const all = [...lat.values()].flatMap(v => v.ms);
const perOp = Object.fromEntries([...lat.entries()].sort().map(([k, v]) => [k, { ...stats(v.ms), errors: v.err }]));
const summary = { V, seconds: Math.round(secs), requests: total, rps: Math.round((total / secs) * 10) / 10, errors, errorRate: total ? errors / total : 0, overall: stats(all), loadAvg: [la0, ...loadSamples, la1] };
console.log(JSON.stringify({ summary, perOp, errorSamples }, null, 2));
await mkdir(new URL('../results/phase-8/', import.meta.url), { recursive: true });
await writeFile(new URL(`../results/phase-8/${label}-mixed.json`, import.meta.url), JSON.stringify({ label, at: new Date().toISOString(), summary, perOp, errorSamples }, null, 2));

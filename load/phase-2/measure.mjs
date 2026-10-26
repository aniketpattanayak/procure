#!/usr/bin/env node
/**
 * Phase 2 performance smoke against a running API (default http://localhost:4000) after seed-master-records.mjs.
 *
 *   node load/phase-2/measure.mjs [requests=50]
 *
 * For each scenario: 5 warm-up requests, then N sequential requests; reports p50 / p95 / max (ms, client-side, over
 * loopback). Then runs EXPLAIN (ANALYZE, BUFFERS) for the SQL each endpoint issues — as `app_user` with the tenant
 * context set, so RLS predicates are part of the plan exactly as in production — and writes the plans to
 * load/results/phase-2/. Flags any Seq Scan on master_record. Target: p95 < 300 ms.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const N = Number(process.argv[2] ?? 50);
const API = process.env.API_ORIGIN ?? 'http://localhost:4000';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../results/phase-2');
mkdirSync(OUT, { recursive: true });
const OWNER = process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure';
const APP = process.env.DATABASE_URL ?? 'postgres://app_user:app_pass@localhost:5432/procure';

async function json(path, init = {}) {
  const res = await fetch(`${API}/api/v1${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}
const login = await json('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantCode: 'acme', email: 'admin@acme.test', password: 'Admin@12345' }) });
const auth = { authorization: `Bearer ${login.accessToken}` };

const owner = new pg.Client({ connectionString: OWNER });
await owner.connect();
const row = async (q, p = []) => (await owner.query(q, p)).rows[0];
const t = await row(`select id from platform.tenant where code = 'acme'`);
const m = await row(`select id from app.master_def where tenant_id = $1 and key = 'item'`, [t.id]);
const catA = await row(`select r.id from app.master_record r join app.master_def d on d.id = r.master_id where r.tenant_id = $1 and d.key = 'item_category' and r.code = 'A'`, [t.id]);
const subD = await row(`select r.id from app.master_record r join app.master_def d on d.id = r.master_id where r.tenant_id = $1 and d.key = 'item_subcategory' and r.code = 'D'`, [t.id]);
const counts = await row(`select count(*)::int as total, count(*) filter (where data @> jsonb_build_object('category', $3::text))::int as cat_a
  from app.master_record where tenant_id = $1 and master_id = $2 and not is_deleted`, [t.id, m.id, catA.id]);
await owner.end();
if (counts.total < 1000) console.warn(`only ${counts.total} item records — run seed-master-records.mjs first`);

const scenarios = [
  { name: 'records-first-page', path: '/masters/item/records' },
  { name: 'records-q-search', path: '/masters/item/records?q=bolt' },
  { name: 'records-q-rare (worst case)', path: '/masters/item/records?q=PERF-049999' },
  { name: 'records-q-nomatch (worst case)', path: '/masters/item/records?q=zzzz' },
  { name: 'records-filter-category', path: `/masters/item/records?f.category=${catA.id}` },
  { name: 'options-q-cascade', path: `/masters/item/options?q=steel&filter=category:${catA.id}` },
  { name: 'options-q-cascade-sub', path: `/masters/item/options?q=st&filter=sub_category:${subD.id}` },
  { name: 'records-sort-std_rate-page2', path: '/masters/item/records?sort=-std_rate', page2: true },
];

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const results = [];
for (const s of scenarios) {
  let path = s.path;
  if (s.page2) {
    const first = await json(path, { headers: auth });
    path = `${path}&cursor=${encodeURIComponent(first.nextCursor)}`;
  }
  let rows = 0;
  for (let i = 0; i < 5; i++) await json(path, { headers: auth });
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const body = await json(path, { headers: auth });
    times.push(performance.now() - t0);
    rows = Array.isArray(body) ? body.length : body.data.length;
  }
  const r = { scenario: s.name, path: path.replace(/[0-9a-f-]{36}/g, '<id>'), n: N, rows, p50: +pct(times, 50).toFixed(1), p95: +pct(times, 95).toFixed(1), max: +Math.max(...times).toFixed(1) };
  results.push(r);
  console.log(`${r.scenario.padEnd(30)} p50 ${String(r.p50).padStart(6)} ms  p95 ${String(r.p95).padStart(6)} ms  max ${String(r.max).padStart(6)} ms  (${rows} rows)${r.p95 >= 300 ? '  ⚠ over 300 ms' : ''}`);
}

// ------------------------------------------------------------------ EXPLAIN (as app_user, RLS on)
const COLS = `r.id, r.master_id, r.code, r.name, r.is_active, r.data, r.form_version_id, r.created_at, r.updated_at, r.version`;
const base = `from app.master_record as r where r.tenant_id = $1 and r.master_id = $2 and r.is_deleted = false`;
const plans = [
  { name: 'records-first-page', sql: `select ${COLS}, (r.name)::text as sort_value ${base} and r.is_active = true order by r.name asc, r.id asc limit 51`, params: [t.id, m.id] },
  { name: 'records-q-search', sql: `select ${COLS}, (r.name)::text as sort_value ${base} and r.is_active = true and (r.search @@ to_tsquery('simple', $3) or lower(r.name) like $4) order by r.name asc, r.id asc limit 51`, params: [t.id, m.id, 'bolt:*', 'bolt%'] },
  { name: 'records-q-nomatch', sql: `select ${COLS}, (r.name)::text as sort_value ${base} and r.is_active = true and (r.search @@ to_tsquery('simple', $3) or lower(r.name) like $4) order by r.name asc, r.id asc limit 51`, params: [t.id, m.id, 'zzzz:*', 'zzzz%'] },
  { name: 'records-filter-category', sql: `select ${COLS}, (r.name)::text as sort_value ${base} and r.is_active = true and r.data @> $3::jsonb order by r.name asc, r.id asc limit 51`, params: [t.id, m.id, JSON.stringify({ category: catA.id })] },
  { name: 'options-q-cascade', sql: `select r.id, r.code, r.name, r.is_active, r.data ${base} and r.data @> $3::jsonb and r.is_active = true and (r.search @@ to_tsquery('simple', $4) or lower(r.name) like $5) order by r.name, r.id limit 30`, params: [t.id, m.id, JSON.stringify({ category: catA.id }), 'steel:*', 'steel%'] },
  { name: 'options-q-cascade-sub', sql: `select r.id, r.code, r.name, r.is_active, r.data ${base} and r.data @> $3::jsonb and r.is_active = true and (r.search @@ to_tsquery('simple', $4) or lower(r.name) like $5) order by r.name, r.id limit 30`, params: [t.id, m.id, JSON.stringify({ sub_category: subD.id }), 'st:*', 'st%'] },
  { name: 'records-sort-std_rate', sql: `select ${COLS}, (coalesce((r.data->>'std_rate')::numeric, 0))::text as sort_value ${base} and r.is_active = true order by coalesce((r.data->>'std_rate')::numeric, 0) desc, r.id desc limit 51`, params: [t.id, m.id] },
];
const app = new pg.Client({ connectionString: APP });
await app.connect();
const seqScans = [];
for (const p of plans) {
  await app.query('begin');
  await app.query(`select set_config('app.tenant_id', $1, true)`, [t.id]);
  const res = await app.query(`explain (analyze, buffers, verbose, format text) ${p.sql}`, p.params);
  await app.query('rollback');
  const text = res.rows.map(r => r['QUERY PLAN']).join('\n');
  writeFileSync(resolve(OUT, `explain-${p.name}.txt`), `-- ${p.name}\n-- ${p.sql}\n-- params: ${JSON.stringify(p.params)}\n\n${text}\n`);
  const seq = /Seq Scan on (app\.)?master_record/.test(text);
  if (seq) seqScans.push(p.name);
  const exec = /Execution Time: ([\d.]+) ms/.exec(text)?.[1];
  console.log(`EXPLAIN ${p.name.padEnd(26)} exec ${exec} ms${seq ? '  ⚠ Seq Scan on master_record' : ''}`);
}
await app.end();

writeFileSync(resolve(OUT, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), api: API, records: counts, results, seqScans }, null, 2));
console.log(`\nplans + summary written to ${OUT}`);

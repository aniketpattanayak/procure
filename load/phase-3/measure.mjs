#!/usr/bin/env node
/**
 * Phase 3 performance smoke against a running API whose database holds seed-documents.mjs data (≈ 200k lines).
 *
 *   API_ORIGIN=http://localhost:4391 DATABASE_MIGRATOR_URL=postgres://postgres@localhost:5432/procure_qa_load \
 *     node load/phase-3/measure.mjs [requests=50] [--explain]
 *
 * Each scenario: 5 warm-up requests, then N sequential requests; p50 / p95 / max (ms, client side, loopback).
 * Users: the acme admin (all statuses, all locations) and the seeded HOD approver (Pune scope, waiting_hod + outcome
 * views) for the inbox. Writes load/results/phase-3/summary.json. Target: p95 < 300 ms.
 *
 * --explain: sets auto_explain (log_analyze, buffers) for app_user IN THE LOAD DATABASE ONLY, replays every scenario
 * once on fresh connections (the API must be restarted in between: the script prints when), collects the plans of
 * the API's statements from the Postgres log and writes load/results/phase-3/explain-<scenario>.txt, then resets the
 * role settings. Flags Seq Scans on the big tables.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const N = Number(process.argv[2] ?? 50);
const EXPLAIN = process.argv.includes('--explain');
const API = process.env.API_ORIGIN ?? 'http://localhost:4391';
const OWNER = process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure_qa_load';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../results/phase-3');
mkdirSync(OUT, { recursive: true });

async function call(path, token, init = {}) {
  const res = await fetch(`${API}/api/v1${path}`, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
const login = (email, password) => call('/auth/login', null, { method: 'POST', body: JSON.stringify({ tenantCode: 'acme', email, password }) }).then(b => b.accessToken);
const admin = await login('admin@acme.test', 'Admin@12345');
const hod = await login('approver@acme.test', 'Approve@12345');

const owner = new pg.Client({ connectionString: OWNER });
await owner.connect();
const big = (await owner.query(`select id from app.document where number = 'PERF/BIG-100'`)).rows[0];
const stats = (await owner.query(`select (select count(*) from app.document_line)::int as lines, (select count(*) from app.document)::int as docs`)).rows[0];
if (!big || stats.lines < 100_000) console.warn(`only ${stats.lines} lines — run load/phase-3/seed-documents.mjs first`);
const page1 = await call('/docs/capex?limit=50', admin);
const itemPage1 = await call('/docs/capex?view=item&status=waiting_hod&limit=50', admin);

const scenarios = [
  { name: 'doc-list-first-page', path: '/docs/capex?limit=50', token: admin },
  { name: 'doc-list-page-2 (cursor)', path: `/docs/capex?limit=50&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`, token: admin },
  { name: 'doc-list-status-approved', path: '/docs/capex?status=approved&limit=50', token: admin },
  { name: 'doc-list-q-number', path: '/docs/capex?q=PERF/0123&limit=50', token: admin },
  { name: 'item-list-status-waiting_hod', path: '/docs/capex?view=item&status=waiting_hod&limit=50', token: admin },
  { name: 'item-list-status-page-2', path: `/docs/capex?view=item&status=waiting_hod&limit=50&cursor=${encodeURIComponent(itemPage1.nextCursor ?? '')}`, token: admin },
  { name: 'item-list-scoped-hod', path: '/docs/capex?view=item&status=waiting_hod&limit=50', token: hod },
  { name: 'counts-admin', path: '/docs/capex/counts', token: admin },
  { name: 'counts-hod (scoped)', path: '/docs/capex/counts', token: hod },
  { name: 'inbox-hod', path: '/approvals?limit=50', token: hod },
  { name: 'inbox-counts-hod', path: '/approvals/counts', token: hod },
  { name: 'inbox-admin', path: '/approvals?limit=50', token: admin },
  { name: 'detail-100-lines', path: `/docs/capex/${big.id}`, token: admin },
  { name: 'timeline-100-lines', path: `/docs/capex/${big.id}/timeline`, token: admin },
];

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

if (!EXPLAIN) {
  const results = [];
  for (const s of scenarios) {
    for (let i = 0; i < 5; i++) await call(s.path, s.token);
    const ms = [];
    let size = 0;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const b = await call(s.path, s.token);
      ms.push(performance.now() - t0);
      size = Array.isArray(b) ? b.length : Array.isArray(b?.data) ? b.data.length : Array.isArray(b?.lines) ? b.lines.length : Array.isArray(b?.byType) ? b.byType.length : 1;
    }
    const r = { scenario: s.name, n: N, rows: size, p50: +pct(ms, 50).toFixed(1), p95: +pct(ms, 95).toFixed(1), max: +Math.max(...ms).toFixed(1), ok: pct(ms, 95) < 300 };
    results.push(r);
    console.log(`${r.ok ? 'OK ' : 'SLOW'} ${s.name.padEnd(32)} rows=${String(r.rows).padStart(3)}  p50=${r.p50}ms  p95=${r.p95}ms  max=${r.max}ms`);
  }
  writeFileSync(resolve(OUT, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), api: API, data: stats, results }, null, 2));
} else {
  const log = process.env.PG_LOG ?? '/home/claude/.pgdata/log';
  const db = OWNER.split('/').pop();
  await owner.query(`alter role app_user in database ${db} set session_preload_libraries = 'auto_explain'`);
  for (const [k, v] of [['auto_explain.log_min_duration', '0'], ['auto_explain.log_analyze', 'on'], ['auto_explain.log_buffers', 'on'], ['auto_explain.log_nested_statements', 'on']]) {
    await owner.query(`alter role app_user in database ${db} set ${k} = '${v}'`);
  }
  console.log('auto_explain enabled for app_user in', db, '— restart the API now, then press Enter (or set EXPLAIN_NO_WAIT=1 when the API was started after this step)');
  if (!process.env.EXPLAIN_NO_WAIT) await new Promise(r => process.stdin.once('data', r));
  const flagged = [];
  for (const s of scenarios) {
    const start = statSync(log).size;
    appendFileSync('/dev/null', '');
    await call(s.path, s.token);
    await new Promise(r => setTimeout(r, 300));
    const text = readFileSync(log, 'utf8').slice(start);
    const plans = text.split(/\n(?=\S.*LOG: {2}duration: )/).filter(b => /Query Text:/.test(b) && !/Query Text: (select pg_advisory|select set_config|select 1\s*$)/m.test(b));
    writeFileSync(resolve(OUT, `explain-${s.name.replace(/[^\w-]+/g, '_')}.txt`), plans.join('\n'));
    const seq = plans.filter(p => /Seq Scan on (document|document_line|line_qty_summary|line_event|wf_line_state|wf_instance|wf_stage_state)\b/.test(p));
    if (seq.length) flagged.push({ scenario: s.name, seqScans: seq.map(p => (p.match(/Seq Scan on \w+/g) ?? []).join(', ')) });
  }
  await owner.query(`alter role app_user in database ${db} reset all`);
  writeFileSync(resolve(OUT, 'explain-flags.json'), JSON.stringify(flagged, null, 2));
  console.log('plans written; seq scans on big tables:', JSON.stringify(flagged));
}
await owner.end();

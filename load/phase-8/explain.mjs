#!/usr/bin/env node
/**
 * EXPLAIN (ANALYZE, BUFFERS) a SQL file as app_user under RLS for a tenant (the way the API runs it: one transaction,
 * app.tenant_id set locally). Parameters: positional $1.. values as extra args (JSON-ish strings).
 *   DATABASE_URL=postgres://app_user:app_pass@localhost:5432/procure_load node load/phase-8/explain.mjs big query.sql [param ...]
 * Env RUNS=n repeats n times and prints the last plan (warm) plus the execution times of all runs.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const [code, file, ...params] = process.argv.slice(2);
const owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure_load' });
await owner.connect();
const tid = (await owner.query(`select id from platform.tenant where code = $1`, [code])).rows[0]?.id;
await owner.end();
if (!tid) throw new Error(`no tenant ${code}`);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://app_user:app_pass@localhost:5432/procure_load' });
await c.connect();
const text = readFileSync(file, 'utf8').replaceAll(':tid', `'${tid}'`);
const runs = Number(process.env.RUNS ?? 3);
const times = [];
let plan = [];
for (let i = 0; i < runs; i++) {
  await c.query('begin');
  await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
  if (process.env.PRE) await c.query(process.env.PRE);
  const r = await c.query(`explain ${process.env.PLAN ? '' : `(analyze, buffers${process.env.VERBOSE ? ', verbose' : ''})`} ${text}`, params.map(p => (p === 'null' ? null : p)));
  await c.query('rollback');
  plan = r.rows.map(x => x['QUERY PLAN']);
  const ex = plan.find(l => l.startsWith('Execution Time'));
  times.push(ex ? Number(ex.match(/[\d.]+/)[0]) : NaN);
}
console.log(plan.join('\n'));
console.log(`exec times (ms): ${times.map(t => t.toFixed(1)).join(', ')}`);
await c.end();

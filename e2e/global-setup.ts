/**
 * Deterministic start for every E2E run.
 *
 * Two paths, because Playwright starts `webServer` BEFORE globalSetup and a running API crashes when
 * `db:reset` terminates its pooled connections (QA-BUG-001):
 *
 *  1. Playwright started the API itself → the api webServer command already ran `pnpm db:reset` + seed before
 *     booting (see playwright.config.ts) and wrote a marker; nothing to do here except flush Redis.
 *  2. Servers were reused (CI, or a dev's running stack) → "soft reset": TRUNCATE every app.* / platform.* table
 *     except the reference catalogs, then `pnpm db:seed`. Same end state as db:reset + seed, but without killing
 *     the reused API's connections.
 *
 * E2E_NO_RESET=1 skips both (e.g. against a shared environment).
 * E2E_STACK_DIR=<dir>: the reused servers run from another checkout/build (e.g. a snapshot of HEAD while other agents
 * rebuild this tree's apps/api/dist); migrations and the seed then run from that directory too.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { RESET_MARKER } from './support/env';
import { flushAppKeys } from './support/redis';

const root = resolve(__dirname, '..');
const stack = process.env.E2E_STACK_DIR ? resolve(process.env.E2E_STACK_DIR) : root;
const API = process.env.E2E_API_ORIGIN ?? 'http://localhost:4000';
const MIGRATOR = process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure';
// Reference catalogs seeded by migrations (truncating them would leave the DB unlike a fresh `db:reset`).
// 0004: feature/limit catalogs; 0005: the shipped permission registry (without it tenant admins hold no admin.* keys).
const KEEP = new Set(['platform.feature_catalog', 'platform.limit_catalog', 'platform.permission_def']);

function run(cmd: string, cwd = root) {
  execSync(cmd, { cwd, stdio: 'inherit', env: process.env });
}

async function healthy(timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${API}/health`)).ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function softReset() {
  run('node db/migrate.mjs', stack); // apply any new migrations (no drop)
  const c = new Client({ connectionString: MIGRATOR });
  await c.connect();
  try {
    const { rows } = await c.query<{ t: string }>(
      `select format('%I.%I', table_schema, table_name) as t from information_schema.tables
       where table_schema in ('app', 'platform') and table_type = 'BASE TABLE'`);
    const tables = rows.map(r => r.t).filter(t => !KEEP.has(t));
    if (tables.length) await c.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of KEEP) {
      const { rows: [r] } = await c.query<{ n: string }>(`select count(*)::text as n from ${t}`);
      if (Number(r?.n ?? 0) === 0) throw new Error(`[e2e] ${t} is empty (migration-seeded catalog lost); run pnpm db:reset && pnpm db:seed once`);
    }
  } finally {
    await c.end();
  }
}

export default async function globalSetup() {
  const marker = existsSync(RESET_MARKER) ? Number(readFileSync(RESET_MARKER, 'utf8')) : 0;
  const freshlyReset = Date.now() - marker < 10 * 60_000;
  rmSync(RESET_MARKER, { force: true });

  if (process.env.E2E_NO_RESET !== '1' && !freshlyReset) {
    console.log('[e2e] reusing running servers → soft reset (truncate + seed)');
    if (!existsSync(resolve(stack, 'apps/api/dist/seed/demo.js'))) run('pnpm --filter @procure/schema build && pnpm --filter @procure/api build', stack);
    await softReset();
    run('node --env-file-if-exists=../../.env dist/seed/demo.js', resolve(stack, 'apps/api'));
  }
  // Rate-limit counters, revocations and cached principals/entitlements must not leak between runs. BullMQ keys stay
  // (the running API registered its repeatable jobs there at boot).
  try { await flushAppKeys(); } catch (e) { console.warn(`[e2e] Redis not flushed: ${(e as Error).message}`); }

  if (!(await healthy(20_000))) throw new Error(`[e2e] API at ${API} is not healthy`);
}

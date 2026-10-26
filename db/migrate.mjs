#!/usr/bin/env node
// Minimal forward-only SQL migration runner (ADR-0003). Runs as the migrator (owner) role.
// Usage: node db/migrate.mjs [--reset]   (--reset drops and recreates the database; dev/test only)
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure';

async function ensureDatabase(reset) {
  const u = new URL(url);
  const dbName = u.pathname.slice(1);
  u.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: u.toString() });
  await admin.connect();
  if (reset) {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  }
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
}

export async function migrate({ reset = false, log = console.log } = {}) {
  await ensureDatabase(reset);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migration (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map((await client.query('SELECT name, checksum FROM public.schema_migration')).rows.map(r => [r.name, r.checksum]));
  const files = readdirSync(join(here, 'migrations')).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(here, 'migrations', f), 'utf8');
    const sum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(f)) {
      if (applied.get(f) !== sum) throw new Error(`Migration ${f} was edited after being applied. Add a new migration instead.`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.schema_migration (name, checksum) VALUES ($1, $2)', [f, sum]);
      await client.query('COMMIT');
      log(`applied ${f}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`${f}: ${e.message}`);
    }
  }
  await client.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate({ reset: process.argv.includes('--reset') }).catch(e => { console.error(e.message); process.exit(1); });
}

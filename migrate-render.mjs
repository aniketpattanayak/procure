#!/usr/bin/env node
/**
 * Render-compatible migration runner.
 * On Render free tier, there's only one user (procure_user) with no superuser.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_MIGRATOR_URL;
if (!url) { console.error('DATABASE_MIGRATOR_URL is required'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

function patchSql(sql, filename) {
  // Skip CREATE EXTENSION (needs superuser)
  sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS \w+(\s+WITH SCHEMA \w+)?;/g, '');
  // Skip DO $$ ... $$ blocks (CREATE ROLE / ALTER ROLE inside them)
  sql = sql.replace(/DO\s*\$\$[\s\S]*?\$\$\s*;/g, '');

  // Replace role names ONLY in GRANT/REVOKE/TO/AS contexts — NOT table/column names.
  // "app_user" and "migrator" only appear as role names, safe to global replace.
  sql = sql.replace(/\bapp_user\b/g, 'procure_user');
  sql = sql.replace(/\bmigrator\b/g, 'procure_user');
  // "platform_user" is BOTH a table name (platform.platform_user) AND a role name.
  // Only replace it when it appears after TO, FROM, AS, or standalone after whitespace
  // at the end of a GRANT/REVOKE line — never when preceded by a dot (table reference).
  sql = sql.replace(/(?<![\w.])\bplatform_user\b(?!\s*\()/g, (match, offset) => {
    // Check if preceded by a dot (it's a qualified name like platform.platform_user)
    const before = sql.slice(Math.max(0, offset - 1), offset);
    if (before === '.') return match;       // keep: it's a table/column reference
    return 'procure_user';                  // replace: it's a role reference
  });

  // Skip REVOKE (can fail without superuser)
  sql = sql.replace(/REVOKE\s+[^;]+;/gi, '');

  // ── ltree workaround for 0005 ────────────────────────────────────────────
  if (filename && filename.startsWith('0005')) {
    sql = sql.replace(/\bpath\s+ltree\b/g, 'path text');
    sql = sql.replace(/DECLARE\s+parent_path\s+ltree;/g, 'DECLARE parent_path text;');
    sql = sql.replace(/::ltree/g, '::text');
    sql = sql.replace(
      /CREATE INDEX location_node_path ON app\.location_node USING gist \(path\);/g,
      'CREATE INDEX location_node_path ON app.location_node (path text_pattern_ops);'
    );
    sql = sql.replace(
      /(\w+_path)\s*\|\|\s*(app\.location_label\([^)]+\))/g,
      "$1 || '.' || $2"
    );
    sql = sql.replace(/parent_path\s*<@\s*OLD\.path/g, "OLD.path LIKE parent_path || '%'");
    sql = sql.replace(/WHERE\s+path\s*<@\s*OLD\.path/g, "WHERE path LIKE OLD.path || '%'");
    sql = sql.replace(/nlevel\(([^)]+)\)/g, "(length($1) - length(replace($1, '.', '')) + 1)");
    sql = sql.replace(
      /SET path = NEW\.path \|\| subpath\(path, nlevel\(OLD\.path\)\),\s*\n\s*depth = nlevel\(NEW\.path\) \+ nlevel\(path\) - nlevel\(OLD\.path\)/g,
      `SET path = NEW.path || '.' || substring(path FROM length(OLD.path) + 2),
         depth = (length(NEW.path) - length(replace(NEW.path, '.', '')) + 1) + (length(path) - length(replace(path, '.', '')) + 1) - (length(OLD.path) - length(replace(OLD.path, '.', '')) + 1)`
    );
  }

  return sql;
}

async function query(sql, label) {
  try {
    await client.query(sql);
    if (label) console.log(`  ✓ ${label}`);
  } catch(e) {
    if (label) console.log(`  ✗ ${label}: ${e.message}`);
  }
}

async function main() {
  await client.connect();
  console.log('Connected to Render PostgreSQL\n');

  await query(`CREATE SCHEMA IF NOT EXISTS platform`, 'CREATE SCHEMA platform');
  await query(`CREATE SCHEMA IF NOT EXISTS app`, 'CREATE SCHEMA app');

  await query(`
    CREATE OR REPLACE FUNCTION app.uuid_v7() RETURNS uuid LANGUAGE sql AS $$
      SELECT encode(
        set_bit(set_bit(
          overlay(uuid_send(gen_random_uuid()) placing
            substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
            from 1 for 6),
          52, 1), 53, 1), 'hex')::uuid
    $$ SECURITY DEFINER
  `, 'CREATE FUNCTION app.uuid_v7()');

  await query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'citext') THEN
        CREATE DOMAIN citext AS text;
      END IF;
    END $$
  `, 'CREATE DOMAIN citext');

  await query(`
    CREATE TABLE IF NOT EXISTS public._migration (
      filename   text PRIMARY KEY,
      sha256     text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `, 'CREATE TABLE _migration');

  const migrationsDir = join(here, 'db/migrations');
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  console.log(`\nRunning ${files.length} migrations...\n`);

  for (const file of files) {
    const { rows } = await client.query('SELECT 1 FROM public._migration WHERE filename = $1', [file]);
    if (rows.length > 0) { console.log(`  skip  ${file}`); continue; }

    let sql = readFileSync(join(here, 'db/migrations', file), 'utf8');
    sql = patchSql(sql, file);
    const hash = createHash('sha256').update(sql).digest('hex');

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO public._migration(filename,sha256) VALUES($1,$2)', [file, hash]);
      await client.query('COMMIT');
      console.log(`  ✓ ${file}`);
    } catch(e) {
      await client.query('ROLLBACK').catch(()=>{});
      console.error(`  ✗ ${file}: ${e.message}`);
    }
  }

  await client.end();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Full Render setup:
 *  1. Runs DB migrations on Render (skips already-done ones)
 *  2. Seeds platform owner + starter plan
 *  3. Creates Jeevaka tenant record + subscription
 *  4. Copies ALL local Jeevaka app.* data to Render
 *
 * Run: node setup-render-full.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, 'apps/api/package.json'));
const { Client } = req('pg');
const { hash, Algorithm } = req('@node-rs/argon2');

const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const LOCAL_DB  = 'postgres://postgres:postgres@localhost:5434/procure';
const ARGON_OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

function makeClient(url, ssl = false) {
  return new Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : false });
}

function patchSql(sql, filename) {
  sql = sql.replace(/CREATE EXTENSION IF NOT EXISTS \w+(\s+WITH SCHEMA \w+)?;/g, '');
  sql = sql.replace(/DO\s*\$\$[\s\S]*?\$\$\s*;/g, '');
  sql = sql.replace(/\bapp_user\b/g, 'procure_user');
  sql = sql.replace(/\bmigrator\b/g, 'procure_user');
  sql = sql.replace(/(?<![\w.])\bplatform_user\b(?!\s*\()/g, (match, offset) => {
    return sql.slice(Math.max(0, offset - 1), offset) === '.' ? match : 'procure_user';
  });
  sql = sql.replace(/REVOKE\s+[^;]+;/gi, '');
  if (filename && filename.startsWith('0005')) {
    sql = sql.replace(/\bpath\s+ltree\b/g, 'path text');
    sql = sql.replace(/DECLARE\s+parent_path\s+ltree;/g, 'DECLARE parent_path text;');
    sql = sql.replace(/::ltree/g, '::text');
    sql = sql.replace(/CREATE INDEX location_node_path ON app\.location_node USING gist \(path\);/g,
      'CREATE INDEX location_node_path ON app.location_node (path text_pattern_ops);');
    sql = sql.replace(/(\w+_path)\s*\|\|\s*(app\.location_label\([^)]+\))/g, "$1 || '.' || $2");
    sql = sql.replace(/parent_path\s*<@\s*OLD\.path/g, "OLD.path LIKE parent_path || '%'");
    sql = sql.replace(/WHERE\s+path\s*<@\s*OLD\.path/g, "WHERE path LIKE OLD.path || '%'");
    sql = sql.replace(/nlevel\(([^)]+)\)/g, "(length($1) - length(replace($1, '.', '')) + 1)");
    sql = sql.replace(
      /SET path = NEW\.path \|\| subpath\(path, nlevel\(OLD\.path\)\),\s*\n\s*depth = nlevel\(NEW\.path\) \+ nlevel\(path\) - nlevel\(OLD\.path\)/g,
      `SET path = NEW.path || '.' || substring(path FROM length(OLD.path) + 2),\n         depth = (length(NEW.path) - length(replace(NEW.path, '.', '')) + 1) + (length(path) - length(replace(path, '.', '')) + 1) - (length(OLD.path) - length(replace(OLD.path, '.', '')) + 1)`
    );
  }
  return sql;
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════════════════╗');
console.log('║   Render Full Setup — Migrations + Seed + Data     ║');
console.log('╚══════════════════════════════════════════════════════╝\n');

const render = makeClient(RENDER_DB, true);
await render.connect();
console.log('✓ Connected to Render DB');

const local = makeClient(LOCAL_DB);
await local.connect();
console.log('✓ Connected to local DB\n');

// ── STEP 1: Migrations ────────────────────────────────────────────────
console.log('━━━ STEP 1: Migrations ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

for (const sql of [
  `CREATE SCHEMA IF NOT EXISTS platform`,
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE OR REPLACE FUNCTION app.uuid_v7() RETURNS uuid LANGUAGE sql AS $$ SELECT encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6),52, 1), 53, 1), 'hex')::uuid $$ SECURITY DEFINER`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'citext') THEN CREATE DOMAIN citext AS text; END IF; END $$`,
  `CREATE TABLE IF NOT EXISTS public._migration (filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`
]) { try { await render.query(sql); } catch(e) {} }

const migrationsDir = join(here, 'db/migrations');
const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
for (const file of files) {
  const { rows } = await render.query('SELECT 1 FROM public._migration WHERE filename = $1', [file]);
  if (rows.length > 0) { console.log(`  skip  ${file}`); continue; }
  let sql = readFileSync(join(migrationsDir, file), 'utf8');
  sql = patchSql(sql, file);
  const h = createHash('sha256').update(sql).digest('hex');
  try {
    await render.query('BEGIN');
    await render.query(sql);
    await render.query('INSERT INTO public._migration(filename,sha256) VALUES($1,$2)', [file, h]);
    await render.query('COMMIT');
    console.log(`  ✓ ${file}`);
  } catch(e) {
    await render.query('ROLLBACK').catch(()=>{});
    console.log(`  ✗ ${file}: ${e.message}`);
  }
}

// ── STEP 2: Seed platform owner + plan ───────────────────────────────
console.log('\n━━━ STEP 2: Platform Owner + Plan ━━━━━━━━━━━━━━━━━━━━━\n');

const ownerHash = await hash('Owner@12345', ARGON_OPTS);
const existingOwner = await render.query(`SELECT id FROM platform.platform_user WHERE email = 'owner@procure.local'`);
if (existingOwner.rows.length > 0) {
  await render.query(`UPDATE platform.platform_user SET password_hash=$1, is_active=true, must_change_password=false, failed_logins=0, locked_until=null, role='owner' WHERE email='owner@procure.local'`, [ownerHash]);
  console.log('✓ Platform owner updated');
} else {
  await render.query(`INSERT INTO platform.platform_user (email, name, role, password_hash, must_change_password) VALUES ('owner@procure.local','Platform Owner','owner',$1,false)`, [ownerHash]);
  console.log('✓ Platform owner created');
}

const STARTER_FEATURES = ['indent', 'purchase', 'grn', 'store', 'reports'];
let planId;
const existingPlan = await render.query(`SELECT id FROM platform.plan WHERE code = 'starter'`);
if (existingPlan.rows.length > 0) {
  planId = existingPlan.rows[0].id;
  console.log(`✓ Starter plan exists (${planId})`);
} else {
  const res = await render.query(`INSERT INTO platform.plan (code,name,description,price,currency,billing_cycle,trial_days,is_active) VALUES ('starter','Starter','Core procurement',4999,'INR','monthly',14,true) RETURNING id`);
  planId = res.rows[0].id;
  for (const fk of STARTER_FEATURES) {
    await render.query(`INSERT INTO platform.plan_feature (plan_id,feature_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [planId, fk]).catch(()=>{});
  }
  console.log(`✓ Starter plan created (${planId})`);
}

// ── STEP 3: Copy local Jeevaka data ───────────────────────────────────
console.log('\n━━━ STEP 3: Copying Jeevaka Data ━━━━━━━━━━━━━━━━━━━━━━\n');

// Get local Jeevaka tenant (table is platform.tenant, lookup by code)
const { rows: [localTenant] } = await local.query(`SELECT * FROM platform.tenant WHERE code = 'jeevaka'`);
if (!localTenant) {
  console.log('⚠ No jeevaka tenant in local DB. Nothing to copy.');
  await local.end(); await render.end();
  process.exit(0);
}
console.log(`Local Jeevaka: id=${localTenant.id}  name=${localTenant.name}`);

// Check/create Jeevaka on Render
let { rows: [renderTenant] } = await render.query(`SELECT * FROM platform.tenant WHERE code = 'jeevaka'`);
if (!renderTenant) {
  console.log('  Creating Jeevaka tenant on Render...');
  // Copy it directly from local (same id to keep FK integrity)
  const cols = Object.keys(localTenant);
  const vals = cols.map(c => localTenant[c]);
  const ph = vals.map((_,i) => `$${i+1}`).join(',');
  const cl = cols.map(c => `"${c}"`).join(',');
  try {
    await render.query(`INSERT INTO platform.tenant (${cl}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`, vals);
    renderTenant = localTenant;
    console.log('  ✓ Jeevaka tenant row created');
  } catch(e) {
    console.log('  ✗ Failed to insert tenant:', e.message);
  }
} else {
  console.log(`Render Jeevaka: id=${renderTenant.id}`);
}

const localId = localTenant.id;
const renderId = renderTenant?.id ?? localId;

// Copy platform.subscription for this tenant
try {
  const { rows: subs } = await local.query(`SELECT * FROM platform.subscription WHERE tenant_id = $1`, [localId]);
  for (const s of subs) {
    const cols = Object.keys(s);
    // map tenant_id if IDs differ, keep plan_id as-is (plan already exists on render with same id if we seeded it)
    const vals = cols.map(c => {
      if (c === 'tenant_id') return renderId;
      if (c === 'plan_id') return planId; // use the render plan id
      return s[c];
    });
    const ph = vals.map((_,i)=>`$${i+1}`).join(',');
    const cl = cols.map(c=>`"${c}"`).join(',');
    await render.query(`INSERT INTO platform.subscription (${cl}) VALUES (${ph}) ON CONFLICT DO NOTHING`, vals).catch(()=>{});
  }
  console.log(`✓ platform.subscription: ${subs.length} rows`);
} catch(e) { console.log(`✗ platform.subscription: ${e.message}`); }

// Copy platform.tenant_override
try {
  const { rows } = await local.query(`SELECT * FROM platform.tenant_override WHERE tenant_id = $1`, [localId]);
  for (const r of rows) {
    const cols = Object.keys(r); const vals = cols.map(c => c === 'tenant_id' ? renderId : r[c]);
    const ph = vals.map((_,i)=>`$${i+1}`).join(','); const cl = cols.map(c=>`"${c}"`).join(',');
    await render.query(`INSERT INTO platform.tenant_override (${cl}) VALUES (${ph}) ON CONFLICT DO NOTHING`, vals).catch(()=>{});
  }
  console.log(`✓ platform.tenant_override: ${rows.length} rows`);
} catch(e) { console.log(`✗ platform.tenant_override: ${e.message}`); }

// All app.* tables with tenant_id column
const APP_TABLES = [
  'role','permission_def','permission_grant','scope_grant','field_access',
  'tenant_user','user_role',
  'tenant_setting','numbering_series','numbering_counter',
  'location_node',
  'master_def','master_record',
  'form_def','form_version',
  'doc_type',
  'workflow_def','workflow_version','wf_instance','wf_stage_state','wf_line_state','wf_action','wf_assignment','trigger_rule',
  'document','document_line','document_revision','line_event','line_link','line_qty_summary','line_tax','record_ref',
  'file_object','attachment','generated_pdf',
  'stock_balance','stock_movement','stock_batch','item_avg_cost','valuation_layer','reorder_rule',
  'report_def','report_schedule','export_job','dashboard_def','saved_view',
  'comment','notification','outbound_message','outbox_event','message_template',
  'webhook_endpoint','webhook_delivery',
  'po_followup','vendor_quote',
  'audit_log',
];

console.log(`\nCopying ${APP_TABLES.length} app.* tables...\n`);
let total = 0;

for (const tbl of APP_TABLES) {
  try {
    // Check if table even exists locally
    const exists = await local.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='app' AND table_name=$1`, [tbl]);
    if (!exists.rows.length) { console.log(`   n/a   app.${tbl}`); continue; }

    // Check if it has a tenant_id column
    const hasTenantId = await local.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name=$1 AND column_name='tenant_id'`, [tbl]);
    
    let rows;
    if (hasTenantId.rows.length) {
      const r = await local.query(`SELECT * FROM app."${tbl}" WHERE tenant_id = $1`, [localId]);
      rows = r.rows;
    } else {
      // Tables without tenant_id (like permission_def which is global) — skip
      console.log(`   skip  app.${tbl} (no tenant_id)`);
      continue;
    }

    if (!rows.length) { console.log(`   empty app.${tbl}`); continue; }

    // Delete existing data on render for this tenant
    await render.query(`DELETE FROM app."${tbl}" WHERE tenant_id = $1`, [renderId]).catch(()=>{});

    const cols = Object.keys(rows[0]);
    let n = 0;
    for (const row of rows) {
      const vals = cols.map(c => (c === 'tenant_id') ? renderId : row[c]);
      const ph = vals.map((_,i)=>`$${i+1}`).join(',');
      const cl = cols.map(c=>`"${c}"`).join(',');
      try {
        await render.query(`INSERT INTO app."${tbl}" (${cl}) VALUES (${ph}) ON CONFLICT DO NOTHING`, vals);
        n++;
      } catch(e) { /* skip row */ }
    }
    total += n;
    console.log(`   ✓  app.${tbl}: ${n}/${rows.length} rows`);
  } catch(e) {
    console.log(`   ✗  app.${tbl}: ${e.message}`);
  }
}

await local.end();
await render.end();

console.log('\n╔══════════════════════════════════════════════════════╗');
console.log(`║  ✅  Done! ${total} rows copied to Render.`.padEnd(55) + '║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('\nLogin: https://procure-web-i1rq.onrender.com/jeevaka/login');
console.log('Email: admin@jeevaka.local');
console.log('(use the password from your local setup)\n');

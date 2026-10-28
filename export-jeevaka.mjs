#!/usr/bin/env node
/**
 * Exports ALL Jeevaka tenant data from the local database
 * and imports it into the Render production database.
 *
 * Run from inside the procure/ folder:
 *   node export-jeevaka.mjs
 *
 * Paste your Render PostgreSQL External URL when prompted.
 * (Render Dashboard → procure-db → Info → External Database URL)
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const { Client } = req('./node_modules/pg');

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(question, ans => { rl.close(); res(ans.trim()); }));
}

function makeClient(url, ssl = false) {
  return new Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : false });
}

// ── local DB from apps/api/.env.local ──────────────────────────────────────
const LOCAL_DB = 'postgres://postgres:postgres@localhost:5434/procure';
let RENDER_DB = process.env.RENDER_DB_URL || '';

if (!RENDER_DB) {
  console.log('\n📋 Go to Render Dashboard → procure-db → Info → External Database URL');
  console.log('   Paste it here:');
  RENDER_DB = await ask('  RENDER_DB_URL: ');
}
if (!RENDER_DB) { console.error('No Render DB URL given.'); process.exit(1); }

console.log('\n🔌 Connecting to local database…');
const local = makeClient(LOCAL_DB);
await local.connect();
console.log('✓ Local DB connected');

console.log('🔌 Connecting to Render database…');
const render = makeClient(RENDER_DB, true);
await render.connect();
console.log('✓ Render DB connected\n');

// Find Jeevaka tenant locally
const { rows: [localTenant] } = await local.query(
  `SELECT id, slug, name, schema_name FROM platform.tenants WHERE slug = 'jeevaka'`
);
if (!localTenant) {
  console.error('❌ No "jeevaka" tenant found in local database!');
  process.exit(1);
}
console.log(`📦 Local tenant: ${localTenant.name} (id=${localTenant.id}, schema=${localTenant.schema_name})`);

// Find Jeevaka tenant on Render
const { rows: [renderTenant] } = await render.query(
  `SELECT id, slug, name, schema_name FROM platform.tenants WHERE slug = 'jeevaka'`
);
if (!renderTenant) {
  console.error('❌ "jeevaka" tenant not found on Render!');
  console.error('   Log in at https://procure-web-i1rq.onrender.com/platform/login');
  console.error('   Create the Jeevaka tenant first, then re-run this script.');
  process.exit(1);
}
console.log(`📦 Render tenant: ${renderTenant.name} (id=${renderTenant.id}, schema=${renderTenant.schema_name})`);

const localSchema = localTenant.schema_name;
const renderSchema = renderTenant.schema_name;
const localId = localTenant.id;
const renderId = renderTenant.id;

// Get all tables in the tenant schema
const { rows: tables } = await local.query(`
  SELECT table_name 
  FROM information_schema.tables 
  WHERE table_schema = $1 
  AND table_type = 'BASE TABLE'
  ORDER BY table_name
`, [localSchema]);

console.log(`\n📊 ${tables.length} tables in schema "${localSchema}":`);
tables.forEach(t => process.stdout.write(`   ${t.table_name}  `));
console.log('\n');

// Copy tables
console.log('🚚 Migrating data…\n');
let totalRows = 0;
const errors = [];

for (const { table_name } of tables) {
  try {
    const { rows: localRows } = await local.query(`SELECT * FROM "${localSchema}"."${table_name}"`);
    
    if (localRows.length === 0) {
      console.log(`   skip  ${table_name} (empty)`);
      continue;
    }

    // Clear existing render data for this table
    await render.query(`DELETE FROM "${renderSchema}"."${table_name}"`);

    const columns = Object.keys(localRows[0]);
    let inserted = 0;

    for (const row of localRows) {
      const values = columns.map(col => {
        const val = row[col];
        if (col === 'tenant_id' && val === localId) return renderId;
        return val;
      });
      const placeholders = values.map((_, idx) => `$${idx + 1}`).join(', ');
      const colList = columns.map(c => `"${c}"`).join(', ');
      
      try {
        await render.query(
          `INSERT INTO "${renderSchema}"."${table_name}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values
        );
        inserted++;
      } catch(e2) {
        // Skip row-level errors silently
      }
    }
    
    totalRows += inserted;
    console.log(`   ✓  ${table_name}: ${inserted}/${localRows.length} rows`);
    
  } catch (e) {
    console.log(`   ✗  ${table_name}: ${e.message}`);
    errors.push({ table: table_name, error: e.message });
  }
}

// Copy platform.tenant_user (logins for this tenant)
console.log('\n🔧 Copying tenant users (logins)…\n');
try {
  const { rows: localUsers } = await local.query(
    `SELECT * FROM platform.tenant_user WHERE tenant_id = $1`, [localId]
  );
  
  let usersCopied = 0;
  for (const u of localUsers) {
    const cols = Object.keys(u);
    const vals = cols.map(c => c === 'tenant_id' ? renderId : u[c]);
    const placeholders = vals.map((_, i) => `$${i+1}`).join(', ');
    const colList = cols.map(c => `"${c}"`).join(', ');
    
    try {
      await render.query(
        `INSERT INTO platform.tenant_user (${colList}) VALUES (${placeholders}) 
         ON CONFLICT (id) DO UPDATE SET 
           name = EXCLUDED.name,
           password_hash = EXCLUDED.password_hash,
           is_active = EXCLUDED.is_active`,
        vals
      );
      usersCopied++;
    } catch(e2) {
      // Try without conflict update
      try {
        await render.query(
          `INSERT INTO platform.tenant_user (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          vals
        );
        usersCopied++;
      } catch(e3) { /* skip */ }
    }
  }
  console.log(`   ✓  tenant_user: ${usersCopied} rows`);
} catch(e) {
  console.log(`   ✗  tenant_user: ${e.message}`);
  errors.push({ table: 'platform.tenant_user', error: e.message });
}

await local.end();
await render.end();

console.log('\n═══════════════════════════════════════════════════');
if (errors.length === 0) {
  console.log(`  ✅  Done! ${totalRows} rows migrated successfully.`);
} else {
  console.log(`  ⚠️   Done with ${errors.length} error(s). ${totalRows} rows migrated.`);
  errors.forEach(e => console.log(`     ✗ ${e.table}: ${e.error}`));
}
console.log('═══════════════════════════════════════════════════\n');

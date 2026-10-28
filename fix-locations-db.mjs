/**
 * fix-locations-db.mjs
 *
 * Step 1: Installs the ltree extension on Render's PostgreSQL
 *         (ltree is a built-in Postgres module, just not enabled yet)
 * Step 2: Directly inserts the 5 location records into the DB
 *         using the tenant RLS context (SET LOCAL app.tenant_id = ...)
 *
 * Run this from your Mac terminal:
 *   node ~/Desktop/OMM_SYS/procure/fix-locations-db.mjs
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

// ─── locations to insert ─────────────────────────────────────────────────────
// We will insert in 2 passes:
//   Pass 1: root nodes (no parent) — SPD, SID, OFC-01
//   Pass 2: children of SPD — SPD-01 Furnace, SPD-02 RMD

const ROOT_LOCATIONS = [
  { code: 'SPD',    name: 'SPD Chegunta',    sort_order: 1 },
  { code: 'SID',    name: 'SID Nasthipur',   sort_order: 2 },
  { code: 'OFC-01', name: 'Office Balanagar', sort_order: 3 },
];

const SPD_CHILDREN = [
  { code: 'SPD-01', name: 'SPD Chegunta Furnace', sort_order: 1 },
  { code: 'SPD-02', name: 'SPD Chegunta RMD',     sort_order: 2 },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

async function installLtree(client) {
  console.log('\n═══ Step 1: Enable ltree extension ═══');
  try {
    // Check if already installed
    const { rows } = await client.query(`SELECT extname FROM pg_extension WHERE extname = 'ltree'`);
    if (rows.length > 0) {
      console.log('  ✓ ltree already installed');
      return true;
    }
    // Install it
    await client.query(`CREATE EXTENSION ltree`);
    console.log('  ✓ ltree installed successfully');
    return true;
  } catch (err) {
    console.error('  ✗ Could not install ltree:', err.message);
    console.error('');
    console.error('  If you see "permission denied", go to your Render dashboard:');
    console.error('  PostgreSQL → your DB → "Extensions" → enable "ltree"');
    console.error('  Then re-run this script.');
    return false;
  }
}

async function upsertLocation(client, { code, name, sort_order, parent_code }) {
  // ALL queries run inside a transaction with the tenant context set,
  // so RLS allows reads and writes for this tenant.
  await client.query('BEGIN');
  try {
    // SET LOCAL does not support parameterised values — safe to interpolate since TENANT_ID is a hardcoded UUID constant
    await client.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);

    // Check if already exists (inside the tenant context)
    const { rows: [existing] } = await client.query(
      `SELECT id FROM app.location_node WHERE tenant_id = $1 AND code = $2`,
      [TENANT_ID, code]
    );
    if (existing) {
      await client.query('COMMIT');
      console.log(`  ✓ Already exists: ${code} (${name})`);
      return existing.id;
    }

    // Look up parent_id if needed (also inside the tenant context)
    let parent_id = null;
    if (parent_code) {
      const { rows: [par] } = await client.query(
        `SELECT id FROM app.location_node WHERE tenant_id = $1 AND code = $2`,
        [TENANT_ID, parent_code]
      );
      if (!par) throw new Error(`Parent location "${parent_code}" not found`);
      parent_id = par.id;
    }

    // Insert — trigger computes path and depth automatically using ltree
    const { rows: [row] } = await client.query(
      `INSERT INTO app.location_node (tenant_id, parent_id, code, name, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [TENANT_ID, parent_id, code, name, sort_order]
    );
    await client.query('COMMIT');
    console.log(`  ✓ Created: ${code} → ${name}`);
    return row.id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

const client = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await client.connect();
console.log('✓ Connected to Render DB');

// Step 1: Install ltree
const ltreeOk = await installLtree(client);
if (!ltreeOk) {
  await client.end();
  process.exit(1);
}

// Step 2: Insert root locations
console.log('\n═══ Step 2: Insert root locations (SPD, SID, Office) ═══');
for (const loc of ROOT_LOCATIONS) {
  await upsertLocation(client, { ...loc, parent_code: null });
}

// Step 3: Insert SPD children
console.log('\n═══ Step 3: Insert SPD sub-locations (Furnace, RMD) ═══');
for (const loc of SPD_CHILDREN) {
  await upsertLocation(client, { ...loc, parent_code: 'SPD' });
}

// Step 4: Show final tree
console.log('\n═══ Final location tree ═══');
const { rows: all } = await client.query(
  `SELECT code, name, depth FROM app.location_node WHERE tenant_id = $1 ORDER BY depth, sort_order`,
  [TENANT_ID]
);
all.forEach(r => console.log(`${'  '.repeat(r.depth - 1)}${r.depth > 1 ? '└─ ' : ''}${r.code} → ${r.name}`));

await client.end();
console.log('\n✓ Done! All locations created.');
console.log('\nNow run: node ~/Desktop/OMM_SYS/procure/fix-masters-only.mjs');
console.log('to create departments, raw materials, consumables, and payment terms.');

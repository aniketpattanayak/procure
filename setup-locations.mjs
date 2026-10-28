#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

const client = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await client.connect();
console.log('✓ Connected to Render DB\n');

// Check if ltree extension exists
const { rows: exts } = await client.query(`SELECT extname FROM pg_extension WHERE extname = 'ltree'`);
console.log(`ltree extension: ${exts.length > 0 ? '✓ installed' : '✗ NOT installed'}`);

// Check existing locations
const { rows: existing } = await client.query(
  `SELECT code, name, depth FROM app.location_node WHERE tenant_id = $1 ORDER BY depth, sort_order`,
  [TENANT_ID]
);
if (existing.length > 0) {
  console.log('\nExisting locations:');
  existing.forEach(r => console.log(`  ${'  '.repeat(r.depth-1)}${r.code} → ${r.name}`));
}

async function upsertLocation(code, name, parentId, sortOrder) {
  const { rows: [ex] } = await client.query(
    `SELECT id FROM app.location_node WHERE tenant_id = $1 AND code = $2`, [TENANT_ID, code]
  );
  if (ex) {
    console.log(`  ✓ Already exists: ${code} (${name})`);
    return ex.id;
  }
  // Let the trigger compute path and depth automatically
  const depth = parentId ? 2 : 1;
  const { rows: [row] } = await client.query(
    `INSERT INTO app.location_node (tenant_id, parent_id, code, name, depth, sort_order, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
    [TENANT_ID, parentId || null, code, name, depth, sortOrder]
  );
  console.log(`  ✅ Created: ${code} → ${name}`);
  return row.id;
}

console.log('\n⏳ Setting up locations...\n');

// Level 1
const spdId = await upsertLocation('SPD',    'SPD',    null, 1);
const sidId = await upsertLocation('SID',    'SID',    null, 2);
const ofcId = await upsertLocation('OFFICE', 'Office', null, 3);

// Level 2: SPD subdivisions
await upsertLocation('SPD-FURNACE', 'SPD Furnace', spdId, 1);
await upsertLocation('SPD-RMD',     'SPD RMD',     spdId, 2);

// Final tree
const { rows: all } = await client.query(
  `SELECT code, name, depth FROM app.location_node WHERE tenant_id = $1 ORDER BY depth, sort_order`,
  [TENANT_ID]
);
console.log('\n✅ Final location tree:');
all.forEach(r => console.log(`  ${'  '.repeat(r.depth-1)}${r.depth > 1 ? '└─ ' : ''}${r.code} → ${r.name}`));

await client.end();
console.log('\nDone!\n');

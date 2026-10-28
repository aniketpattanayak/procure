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

// Check master_def for jeevaka
const { rows: defs } = await client.query(
  `SELECT id, key, name, is_system FROM app.master_def WHERE tenant_id = $1 ORDER BY key`,
  [TENANT_ID]
);
console.log('Master defs for Jeevaka:');
defs.forEach(d => console.log(`  ${d.key} (${d.id}) system=${d.is_system}`));

if (defs.length > 0) {
  // Check record counts
  console.log('\nRecord counts:');
  for (const d of defs) {
    const { rows: [cnt] } = await client.query(
      `SELECT COUNT(*) FROM app.master_record WHERE master_id = $1 AND tenant_id = $2 AND is_deleted = false`,
      [d.id, TENANT_ID]
    );
    console.log(`  ${d.key}: ${cnt.count} records`);
  }

  // Get vendor master_def and form_version_id sample
  const vendor = defs.find(d => d.key === 'vendor');
  if (vendor) {
    const { rows: [fv] } = await client.query(
      `SELECT fd.id as form_version_id FROM app.form_version fd
       JOIN app.form_def f ON f.id = fd.form_def_id
       JOIN app.master_def md ON md.form_id = f.id
       WHERE md.id = $1 ORDER BY fd.created_at DESC LIMIT 1`,
      [vendor.id]
    );
    console.log(`\nVendor form_version_id: ${fv?.form_version_id || 'NOT FOUND'}`);
  }
}

await client.end();

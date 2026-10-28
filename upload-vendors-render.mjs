#!/usr/bin/env node
/**
 * Upload all vendors (vr2-vr9 JSON) into Render DB for Jeevaka tenant.
 * Run: node ~/Desktop/OMM_SYS/procure/upload-vendors-render.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const TENANT_CODE = 'jeevaka';

const client = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await client.connect();
console.log('✓ Connected to Render DB\n');

// Get Jeevaka tenant ID
const { rows: [tenant] } = await client.query(`SELECT id FROM platform.tenant WHERE code = $1`, [TENANT_CODE]);
if (!tenant) { console.error('❌ Jeevaka tenant not found!'); process.exit(1); }
const TENANT_ID = tenant.id;
console.log(`✓ Jeevaka tenant ID: ${TENANT_ID}\n`);

// Get or create vendor master_def
let { rows: [md] } = await client.query(
  `SELECT id FROM app.master_def WHERE tenant_id = $1 AND key = 'vendor'`, [TENANT_ID]
);
if (!md) {
  console.log('⏳ Creating vendor master definition...');
  const res = await client.query(
    `INSERT INTO app.master_def (tenant_id, key, name, fields, is_active)
     VALUES ($1, 'vendor', 'Vendor', '[]'::jsonb, true) RETURNING id`,
    [TENANT_ID]
  );
  md = res.rows[0];
  console.log(`✓ Created master_def id: ${md.id}`);
} else {
  console.log(`✓ Vendor master_def id: ${md.id}`);
}
const MASTER_DEF_ID = md.id;

// Count existing
const { rows: [cnt] } = await client.query(
  `SELECT COUNT(*) FROM app.master_record WHERE master_def_id = $1 AND tenant_id = $2`,
  [MASTER_DEF_ID, TENANT_ID]
);
console.log(`  Existing vendors: ${cnt.count}\n`);

// Upload all vendor files
const files = ['vr2.json','vr3.json','vr4.json','vr5.json','vr6.json','vr7.json','vr8.json','vr9.json'];
let totalCreated = 0, totalSkipped = 0, totalErrors = 0;

for (const file of files) {
  const filePath = join(here, file);
  let vendors;
  try { vendors = JSON.parse(readFileSync(filePath, 'utf8')); }
  catch(e) { console.log(`Skipping ${file}: ${e.message}`); continue; }

  console.log(`⏳ ${file}: ${vendors.length} vendors (${vendors[0].code}–${vendors[vendors.length-1].code})`);
  let s = 0, sk = 0, e = 0;

  for (const v of vendors) {
    try {
      const res = await client.query(
        `INSERT INTO app.master_record (tenant_id, master_def_id, code, name, data, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (master_def_id, code) DO NOTHING`,
        [TENANT_ID, MASTER_DEF_ID, v.code, v.name, JSON.stringify(v.data)]
      );
      if (res.rowCount > 0) s++; else sk++;
    } catch(ex) {
      e++;
      if (e <= 3) console.log(`  Error on ${v.code}: ${ex.message}`);
    }
  }
  totalCreated += s; totalSkipped += sk; totalErrors += e;
  console.log(`  ✓ ${s} created, ${sk} already existed, ${e} errors`);
}

const { rows: [final] } = await client.query(
  `SELECT COUNT(*) FROM app.master_record WHERE master_def_id = $1 AND tenant_id = $2`,
  [MASTER_DEF_ID, TENANT_ID]
);

await client.end();
console.log(`\n${'═'.repeat(50)}`);
console.log(`  ✅  Done! ${totalCreated} created, ${totalSkipped} skipped, ${totalErrors} errors`);
console.log(`  Total vendors in Render DB: ${final.count}`);
console.log('═'.repeat(50));

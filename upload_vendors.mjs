#!/usr/bin/env node
/**
 * Upload remaining vendors (V452-V1541) directly into DB for Jeevaka tenant.
 * Run: cd ~/Desktop/OMM_SYS/procure && node upload_vendors.mjs
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = 'postgres://app_user:app_pass@localhost:5432/procure';
const TENANT_ID = '01a1791d-b610-77cd-8f72-4c1178153f96';
const MASTER_KEY = 'vendor';

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('Connected to DB');

  const mdRes = await client.query(
    'SELECT id FROM app.master_def WHERE tenant_id = $1 AND key = $2',
    [TENANT_ID, MASTER_KEY]
  );
  if (mdRes.rows.length === 0) { console.error('Vendor master not found!'); process.exit(1); }
  const masterDefId = mdRes.rows[0].id;
  console.log('Master def id:', masterDefId);

  const countRes = await client.query(
    'SELECT COUNT(*) FROM app.master_record WHERE master_def_id = $1 AND tenant_id = $2',
    [masterDefId, TENANT_ID]
  );
  console.log('Current vendor count:', countRes.rows[0].count);

  const chunks = ['vr2.json','vr3.json','vr4.json','vr5.json','vr6.json','vr7.json','vr8.json','vr9.json'];
  let totalCreated = 0, totalSkipped = 0, totalErrors = 0;

  for (const file of chunks) {
    const filePath = join(__dirname, file);
    let vendors;
    try {
      vendors = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (ex) { console.log('Skipping ' + file + ': ' + ex.message); continue; }
    console.log('\nUploading ' + file + ' (' + vendors.length + ' vendors, ' + vendors[0].code + '-' + vendors[vendors.length-1].code + ')...');
    let s = 0, sk = 0, e = 0;
    for (const v of vendors) {
      try {
        const res = await client.query(
          'INSERT INTO app.master_record (tenant_id, master_def_id, code, name, data, active) VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (master_def_id, code) DO NOTHING',
          [TENANT_ID, masterDefId, v.code, v.name, JSON.stringify(v.data)]
        );
        if (res.rowCount > 0) s++; else sk++;
      } catch (ex) { e++; console.log('  Error on ' + v.code + ': ' + ex.message); }
    }
    totalCreated += s; totalSkipped += sk; totalErrors += e;
    console.log('  Done: ' + s + ' created, ' + sk + ' already existed, ' + e + ' errors');
  }

  const finalRes = await client.query(
    'SELECT COUNT(*) FROM app.master_record WHERE master_def_id = $1 AND tenant_id = $2',
    [masterDefId, TENANT_ID]
  );
  console.log('\n=== COMPLETE ===');
  console.log('Total created: ' + totalCreated + ', skipped: ' + totalSkipped + ', errors: ' + totalErrors);
  console.log('Final vendor count in DB: ' + finalRes.rows[0].count);
  await client.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

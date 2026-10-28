import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

// Show what we're about to delete
console.log('Before fix:');
const { rows: before } = await db.query(`SELECT key, kind, label FROM platform.permission_def WHERE key IN ('indent','purchase','vendor_quotes','grn') AND kind = 'tab'`);
console.log('Found', before.length, 'bare-key tab entries to delete:', before.map(r => r.key));

if (before.length === 0) {
  console.log('Nothing to delete - already clean!');
} else {
  // Delete the bare-key entries
  const { rowCount } = await db.query(`DELETE FROM platform.permission_def WHERE key IN ('indent','purchase','vendor_quotes','grn') AND kind = 'tab'`);
  console.log('Deleted', rowCount, 'entries');
  
  // Verify
  const { rows: after } = await db.query(`SELECT key, kind, label FROM platform.permission_def WHERE key IN ('indent','purchase','vendor_quotes','grn') AND kind = 'tab'`);
  console.log('After fix - remaining bare-key tabs:', after.length === 0 ? 'NONE (clean!)' : after.map(r => r.key));
  
  // Show remaining doc.* tabs
  const { rows: docTabs } = await db.query(`SELECT key, kind, label FROM platform.permission_def WHERE key LIKE 'doc.%' AND kind = 'tab' ORDER BY key`);
  console.log('Remaining doc.* tabs (correct ones):', docTabs.map(r => r.key));
}

await db.end();
console.log('Done!');

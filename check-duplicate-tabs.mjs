/**
 * check-duplicate-tabs.mjs
 * Find why indent (and other tabs) appear TWICE in the Role Access section.
 *
 * The registry.service.ts loads:
 *   1. platform.permission_def (via app.platform_permission_defs())
 *   2. app.permission_def (tenant-level)
 *
 * If the same key exists in BOTH, the UI may show them twice.
 *
 * Run: node ~/Desktop/OMM_SYS/procure/check-duplicate-tabs.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

console.log('\n═══ 1. Keys in platform.permission_def (global) ═══');
const { rows: platRows } = await db.query(
  `SELECT key, kind, label FROM platform.permission_def WHERE kind = 'tab' ORDER BY key`
);
console.log('  Tab count:', platRows.length);
platRows.forEach(r => console.log(`  [platform] ${r.key} → "${r.label}"`));

console.log('\n═══ 2. Keys in app.permission_def (tenant-level for Jeevaka) ═══');
await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
const { rows: tenantRows } = await db.query(
  `SELECT key, kind, label, source FROM app.permission_def WHERE kind = 'tab' ORDER BY key`
);
await db.query('COMMIT');
console.log('  Tenant tab count:', tenantRows.length);
tenantRows.forEach(r => console.log(`  [tenant/${r.source}] ${r.key} → "${r.label}"`));

console.log('\n═══ 3. What app.platform_permission_defs() actually returns ═══');
await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
const { rows: funcRows } = await db.query(
  `SELECT key, kind, label FROM app.platform_permission_defs() WHERE kind = 'tab' ORDER BY key`
);
await db.query('COMMIT');
console.log('  Function tab count:', funcRows.length);
funcRows.forEach(r => console.log(`  [func] ${r.key} → "${r.label}"`));

console.log('\n═══ 4. DUPLICATES: keys in BOTH platform and tenant level ═══');
const platKeys = new Set(platRows.map(r => r.key));
const tenantKeys = new Set(tenantRows.map(r => r.key));
const dupes = [...platKeys].filter(k => tenantKeys.has(k));
if (dupes.length === 0) {
  console.log('  No duplicate tab keys found between platform and tenant level.');
} else {
  console.log('  DUPLICATE TABS:', dupes.join(', '));
  console.log('\n  FIX: Delete these from app.permission_def (tenant level)');
}

console.log('\n═══ 5. All tabs visible to Jeevaka (merged view) ═══');
await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
// This is what registry.service.ts does: tenant first, then platform overwrites
const tenantAll = await db.query(`SELECT key, kind, label, 'tenant' as src FROM app.permission_def WHERE kind='tab'`);
const platAll   = await db.query(`SELECT key, kind, label, 'platform' as src FROM app.platform_permission_defs() WHERE kind='tab'`);
await db.query('COMMIT');

const merged = new Map();
for (const r of tenantAll.rows) merged.set(r.key, r);
for (const r of platAll.rows) merged.set(r.key, r); // platform wins

console.log('  Merged tab count (no duplicates):', merged.size);
[...merged.values()].sort((a,b) => a.key.localeCompare(b.key))
  .forEach(r => console.log(`  [${r.src}] ${r.key} → "${r.label}"`));

console.log('\n═══ 6. Check if doc.indent and indent BOTH exist ═══');
await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
const { rows: indentRows } = await db.query(
  `SELECT key, kind, label, 'tenant' as src FROM app.permission_def WHERE key LIKE '%indent%'
   UNION ALL
   SELECT key, kind, label, 'platform' as src FROM app.platform_permission_defs() WHERE key LIKE '%indent%'
   ORDER BY key`
);
await db.query('COMMIT');
console.log('  All indent-related keys:');
indentRows.forEach(r => console.log(`  [${r.src}] ${r.key} kind=${r.kind} → "${r.label}"`));

await db.end();
console.log('\nDone.');

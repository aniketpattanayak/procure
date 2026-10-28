/**
 * check-sidebar2.mjs
 * Run: node ~/Desktop/OMM_SYS/procure/check-sidebar2.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const API = 'https://procure-api-2g2v.onrender.com/api/v1';
const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

// ─── Step 1: DB — check platform.tenant columns ───────────────────────────────
console.log('\n═══ Step 1: platform.tenant table columns ═══');
const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

const { rows: cols } = await db.query(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'platform' AND table_name = 'tenant'
  ORDER BY ordinal_position
`);
console.log('Columns:', cols.map(c => `${c.column_name}(${c.data_type})`).join(', '));

// ─── Step 2: Fetch the actual tenant row ─────────────────────────────────────
console.log('\n═══ Step 2: platform.tenant row for Jeevaka ═══');
const safeColNames = cols.map(c => `"${c.column_name}"`).join(', ');
const { rows: [tenant] } = await db.query(
  `SELECT ${safeColNames} FROM platform.tenant WHERE id = $1`, [TENANT_ID]
);
console.log(JSON.stringify(tenant, null, 2));

// ─── Step 3: Check platform.tenant_feature or similar tables ─────────────────
console.log('\n═══ Step 3: Platform tables with "feature" in name ═══');
const { rows: ftables } = await db.query(`
  SELECT table_schema, table_name FROM information_schema.tables
  WHERE table_name LIKE '%feature%' OR table_name LIKE '%setting%'
  ORDER BY table_schema, table_name
`);
console.log(ftables.map(t => `${t.table_schema}.${t.table_name}`).join(', '));

// ─── Step 4: Check the feature tables ────────────────────────────────────────
for (const t of ftables) {
  console.log(`\n═══ ${t.table_schema}.${t.table_name} ═══`);
  const { rows: tcols } = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position
  `, [t.table_schema, t.table_name]);
  console.log('  cols:', tcols.map(c => c.column_name).join(', '));
  try {
    const { rows: sample } = await db.query(
      `SELECT * FROM "${t.table_schema}"."${t.table_name}" WHERE tenant_id = $1 LIMIT 10`,
      [TENANT_ID]
    );
    if (sample.length) {
      console.log('  rows:', JSON.stringify(sample));
    } else {
      // try without tenant_id filter
      const { rows: all } = await db.query(
        `SELECT * FROM "${t.table_schema}"."${t.table_name}" LIMIT 5`
      );
      console.log('  rows (no tenant filter):', JSON.stringify(all));
    }
  } catch(e) { console.log('  error:', e.message); }
}

// ─── Step 5: Login with tenantCode ───────────────────────────────────────────
console.log('\n═══ Step 5: Try login with tenantCode ═══');
// Try different login body shapes
const loginBodies = [
  { email: 'owner@procure.local', password: 'Owner@12345', tenantCode: 'platform' },
  { email: 'owner@procure.local', password: 'Owner@12345', tenantCode: 'procure' },
  { email: 'admin@jeevaka.local', password: 'Jeevaka@2026', tenantCode: 'jeevaka' },
];
for (const body of loginBodies) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  const token = data.token ?? data.access_token ?? data.data?.token;
  console.log(`  ${body.email} / tenantCode=${body.tenantCode} → ${r.status} ${token ? '✓ GOT TOKEN' : data.errors?.[0]?.message ?? JSON.stringify(data).slice(0,100)}`);
  if (token) {
    // Try to get /auth/me
    const meR = await fetch(`${API}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const meData = await meR.json();
    console.log(`    /auth/me → ${meR.status}: ${JSON.stringify(meData).slice(0,300)}`);

    // Try permissions endpoint
    for (const path of ['/me/permissions', '/permissions', '/auth/permissions']) {
      const pr = await fetch(`${API}${path}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const pt = await pr.text();
      console.log(`    ${path} → ${pr.status}: ${pt.slice(0,200)}`);
    }
  }
}

await db.end();
console.log('\nDone.');

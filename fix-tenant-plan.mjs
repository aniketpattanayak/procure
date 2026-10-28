/**
 * fix-tenant-plan.mjs
 * Checks and fixes the tenant plan/feature assignment so all tabs show in sidebar.
 * Run: node ~/Desktop/OMM_SYS/procure/fix-tenant-plan.mjs
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

const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

// ─── Step 1: See all available features ──────────────────────────────────────
console.log('\n═══ Step 1: All features in platform.feature_catalog ═══');
const { rows: features } = await db.query(
  `SELECT key, name, kind FROM platform.feature_catalog ORDER BY sort_order`
);
features.forEach(f => console.log(`  ${f.key} [${f.kind}] — ${f.name}`));

// ─── Step 2: See all plans and what features they include ────────────────────
console.log('\n═══ Step 2: platform.plan table ═══');
const { rows: planCols } = await db.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'platform' AND table_name = 'plan' ORDER BY ordinal_position
`);
console.log('plan columns:', planCols.map(c => c.column_name).join(', '));

const { rows: plans } = await db.query(`SELECT * FROM platform.plan`);
console.log('Plans:', JSON.stringify(plans, null, 2));

// ─── Step 3: See plan_feature mapping ────────────────────────────────────────
console.log('\n═══ Step 3: platform.plan_feature ═══');
const { rows: planFeatures } = await db.query(`SELECT * FROM platform.plan_feature ORDER BY plan_id, feature_key`);
console.log(JSON.stringify(planFeatures, null, 2));

// ─── Step 4: Check if tenant has a plan assigned ─────────────────────────────
console.log('\n═══ Step 4: Tenant plan assignment ═══');
// Check if there's a plan_id column on tenant or a separate tenant_plan table
const { rows: tenantPlanTables } = await db.query(`
  SELECT table_schema, table_name FROM information_schema.tables
  WHERE table_name LIKE '%tenant%plan%' OR table_name LIKE '%plan%tenant%'
`);
console.log('tenant-plan tables:', tenantPlanTables.map(t => `${t.table_schema}.${t.table_name}`).join(', ') || 'none');

// Check platform.tenant_feature if exists
const { rows: tfTables } = await db.query(`
  SELECT table_schema, table_name FROM information_schema.tables
  WHERE (table_schema = 'platform' OR table_schema = 'app')
    AND (table_name LIKE '%feature%' OR table_name LIKE '%plan%')
  ORDER BY table_schema, table_name
`);
console.log('feature/plan tables:', tfTables.map(t => `${t.table_schema}.${t.table_name}`).join(', '));

for (const t of tfTables) {
  if (['feature_catalog', 'plan_feature'].includes(t.table_name)) continue; // already seen
  console.log(`\n  ${t.table_schema}.${t.table_name}:`);
  const { rows: cols } = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position
  `, [t.table_schema, t.table_name]);
  console.log('  cols:', cols.map(c => c.column_name).join(', '));
  const { rows: rows2 } = await db.query(
    `SELECT * FROM "${t.table_schema}"."${t.table_name}" LIMIT 10`
  );
  console.log('  rows:', JSON.stringify(rows2));
}

// ─── Step 5: Check what the API returns for this tenant's enabled features ────
console.log('\n═══ Step 5: Login and check /auth/me for features ═══');
const loginRes = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@jeevaka.local', password: 'Jeevaka@2026', tenantCode: 'jeevaka' })
});
const loginData = await loginRes.json();
const token = loginData.accessToken ?? loginData.token ?? loginData.access_token;
console.log('Login:', loginRes.status, token ? '✓ token' : 'FAIL');

if (token) {
  const meRes = await fetch(`${API}/auth/me`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const meData = await meRes.json();
  console.log('\n/auth/me response:');
  console.log(JSON.stringify(meData, null, 2).slice(0, 2000));

  // Try permissions endpoints
  for (const path of ['/me/permissions', '/permissions', '/auth/permissions', '/tenants/me', '/tenant']) {
    const r = await fetch(`${API}${path}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const text = await r.text();
    console.log(`\n${path} → ${r.status}: ${text.slice(0, 300)}`);
  }
}

await db.end();
console.log('\nDone.');

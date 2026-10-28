/**
 * check-sidebar.mjs
 * Checks what the API returns for the logged-in admin user's permissions
 * and what features/tabs the frontend would see.
 *
 * Run: node ~/Desktop/OMM_SYS/procure/check-sidebar.mjs
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
const TENANT_SLUG = 'jeevaka';

// ─── Step 1: Login as platform owner, get token ──────────────────────────────
console.log('\n═══ Step 1: Platform owner login ═══');
const ownerLogin = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@procure.local', password: 'Owner@12345' })
});
const ownerData = await ownerLogin.json();
const ownerToken = ownerData.token ?? ownerData.access_token ?? ownerData.data?.token;
console.log('Owner token:', ownerToken ? '✓ got token' : '✗ FAILED: ' + JSON.stringify(ownerData));

// ─── Step 2: Impersonate jeevaka tenant ──────────────────────────────────────
console.log('\n═══ Step 2: Impersonate jeevaka ═══');
const impRes = await fetch(`${API}/platform/tenants/${TENANT_ID}/impersonate`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }
});
const impData = await impRes.json();
const tenantToken = impData.token ?? impData.access_token ?? impData.data?.token;
console.log('Tenant token:', tenantToken ? '✓ got token' : '✗ FAILED: ' + JSON.stringify(impData).slice(0,200));

// ─── Step 3: Login directly as admin@jeevaka.local ───────────────────────────
console.log('\n═══ Step 3: Login as admin@jeevaka.local ═══');
const adminLogin = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-tenant-id': TENANT_ID },
  body: JSON.stringify({ email: 'admin@jeevaka.local', password: 'Jeevaka@2026', tenant: TENANT_SLUG })
});
const adminData = await adminLogin.json();
const adminToken = adminData.token ?? adminData.access_token ?? adminData.data?.token;
console.log('Admin login status:', adminLogin.status, adminToken ? '✓' : '✗');
console.log('Admin login response:', JSON.stringify(adminData).slice(0, 400));

const useToken = adminToken ?? tenantToken;

// ─── Step 4: Check what /me or /auth/me returns ──────────────────────────────
console.log('\n═══ Step 4: GET /auth/me ═══');
const meRes = await fetch(`${API}/auth/me`, {
  headers: { 'Authorization': `Bearer ${useToken}`, 'x-tenant-id': TENANT_ID }
});
const meData = await meRes.json();
console.log('Status:', meRes.status);
console.log('Response:', JSON.stringify(meData).slice(0, 800));

// ─── Step 5: Check tenant features from API ──────────────────────────────────
console.log('\n═══ Step 5: GET /platform/tenants/:id (features) ═══');
const featRes = await fetch(`${API}/platform/tenants/${TENANT_ID}`, {
  headers: { 'Authorization': `Bearer ${ownerToken}` }
});
const featData = await featRes.json();
console.log('Status:', featRes.status);
const features = featData.features ?? featData.data?.features ?? featData.tenant?.features;
console.log('Features:', JSON.stringify(features));

// ─── Step 6: Check DB directly — what does the tenant row look like? ─────────
console.log('\n═══ Step 6: DB check — platform.tenant row ═══');
const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

const { rows: [tenant] } = await db.query(
  `SELECT id, slug, name, plan, features, settings FROM platform.tenant WHERE id = $1`,
  [TENANT_ID]
);
console.log('slug:', tenant.slug);
console.log('plan:', tenant.plan);
console.log('features:', JSON.stringify(tenant.features));
console.log('settings:', JSON.stringify(tenant.settings));

// ─── Step 7: Check what keys admin's Manager role actually has ────────────────
console.log('\n═══ Step 7: Manager role permission_grant keys (first 20) ═══');
await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
const { rows: grants } = await db.query(`
  SELECT pg.perm_key
  FROM app.permission_grant pg
  JOIN app.user_role ur ON ur.role_id = pg.role_id AND ur.tenant_id = pg.tenant_id
  JOIN app.tenant_user u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id
  WHERE pg.tenant_id = $1
    AND u.email = 'admin@jeevaka.local'
    AND pg.perm_key LIKE 'indent%'
     OR pg.perm_key LIKE 'purchase%'
     OR pg.perm_key LIKE 'grn%'
  LIMIT 30
`, [TENANT_ID]);
await db.query('COMMIT');
console.log('Procurement grants for admin:', grants.map(g => g.perm_key).join(', ') || 'NONE FOUND');

// Also check all grants for admin
await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
const { rows: allGrants } = await db.query(`
  SELECT COUNT(*) as cnt
  FROM app.permission_grant pg
  JOIN app.user_role ur ON ur.role_id = pg.role_id AND ur.tenant_id = pg.tenant_id
  JOIN app.tenant_user u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id
  WHERE pg.tenant_id = $1 AND u.email = 'admin@jeevaka.local'
`, [TENANT_ID]);
await db.query('COMMIT');
console.log('Total grants admin can see via role:', allGrants[0].cnt);

// ─── Step 8: Check how frontend fetches permissions ──────────────────────────
console.log('\n═══ Step 8: Try /permissions or /me/permissions endpoints ═══');
for (const path of ['/permissions', '/me/permissions', '/auth/permissions', '/users/me/permissions']) {
  const r = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${useToken}`, 'x-tenant-id': TENANT_ID }
  });
  const text = await r.text();
  console.log(`${path} → ${r.status}: ${text.slice(0, 150)}`);
}

await db.end();
console.log('\nDone.');

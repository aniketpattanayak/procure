/**
 * check-super-admin.mjs
 * Diagnoses the platform owner (super admin) account status in the Render DB.
 * 
 * Key table: platform.platform_user  (NOT platform.user)
 * Auth endpoint: POST /api/v1/auth/platform/login
 * Web URL: https://procure-web-i1rq.onrender.com/platform/login
 * 
 * Run: node check-super-admin.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const db = new Client({ 
  connectionString: 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9',
  ssl: { rejectUnauthorized: false } 
});
await db.connect();
console.log('Connected to DB\n');

// 1. List all schemas
const { rows: schemas } = await db.query(`
  SELECT schema_name FROM information_schema.schemata 
  WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') 
  ORDER BY schema_name
`);
console.log('=== SCHEMAS ===');
console.log(schemas.map(r => r.schema_name).join(', '));

// 2. List tables in each non-system schema
for (const { schema_name } of schemas) {
  const { rows: tables } = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schema_name]
  );
  if (tables.length > 0) {
    console.log(`\n=== TABLES in "${schema_name}" ===`);
    console.log(tables.map(r => r.table_name).join(', '));
  }
}

// 3. Platform users - the key table for the super admin
console.log('\n=== platform.platform_user (ALL ROWS) ===');
try {
  const { rows } = await db.query(`SELECT id, email, name, role, is_active, must_change_password, failed_logins, locked_until, last_login_at, created_at FROM platform.platform_user ORDER BY created_at`);
  if (rows.length === 0) {
    console.log('!!! EMPTY - No platform users exist! The seed has not been run. !!!');
  } else {
    console.log(`${rows.length} row(s):`);
    for (const r of rows) {
      console.log(JSON.stringify(r, null, 2));
    }
  }
} catch(e) {
  console.log(`ERROR: ${e.message}`);
}

// 4. Check specifically for owner@procure.local
console.log('\n=== owner@procure.local LOOKUP ===');
try {
  const { rows } = await db.query(`SELECT * FROM platform.platform_user WHERE email = 'owner@procure.local'`);
  if (rows.length === 0) {
    console.log('NOT FOUND: owner@procure.local does not exist in platform.platform_user');
    console.log('  → The seed (pnpm --filter @procure/api db:seed) needs to be run against the Render DB');
  } else {
    const u = rows[0];
    console.log('FOUND:', JSON.stringify(u, null, 2));
    console.log('\nDiagnosis:');
    if (!u.is_active) console.log('  !! PROBLEM: is_active = false → account is deactivated');
    if (u.locked_until && new Date(u.locked_until) > new Date()) console.log(`  !! PROBLEM: locked_until = ${u.locked_until} → account is locked (too many failed logins)`);
    if (u.failed_logins > 0) console.log(`  !! WARNING: failed_logins = ${u.failed_logins}`);
    if (u.must_change_password) console.log('  !! NOTE: must_change_password = true → will be redirected to change-password page on login');
    if (u.is_active && (!u.locked_until || new Date(u.locked_until) <= new Date())) console.log('  OK: Account appears healthy');
  }
} catch(e) {
  console.log(`ERROR: ${e.message}`);
}

// 5. Platform tenants
console.log('\n=== platform.tenant (ALL ROWS) ===');
try {
  const { rows } = await db.query(`SELECT id, code, name, status, created_at FROM platform.tenant ORDER BY created_at`);
  if (rows.length === 0) {
    console.log('NO TENANTS - platform.tenant is empty');
  } else {
    console.log(`${rows.length} tenant(s):`);
    for (const r of rows) console.log(JSON.stringify(r));
  }
} catch(e) {
  console.log(`ERROR: ${e.message}`);
}

// 6. Check Jeevaka tenant specifically
console.log('\n=== Jeevaka Tenant Check ===');
const JEEVAKA_TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';
try {
  const { rows } = await db.query(`SELECT * FROM platform.tenant WHERE id = $1`, [JEEVAKA_TENANT_ID]);
  if (rows.length === 0) {
    console.log(`Jeevaka tenant (${JEEVAKA_TENANT_ID}) NOT FOUND`);
  } else {
    console.log('Jeevaka tenant:', JSON.stringify(rows[0], null, 2));
  }
} catch(e) {
  console.log(`ERROR: ${e.message}`);
}

// 7. Platform plans
console.log('\n=== platform.plan ===');
try {
  const { rows } = await db.query(`SELECT id, code, name, price, is_active FROM platform.plan ORDER BY created_at`);
  console.log(`${rows.length} plan(s):`);
  for (const r of rows) console.log(JSON.stringify(r));
} catch(e) {
  console.log(`ERROR: ${e.message} (table may not exist)`);
}

// 8. Auth sessions for platform user  
console.log('\n=== Recent auth sessions for platform users ===');
try {
  const { rows } = await db.query(`
    SELECT s.id, s.subject_type, s.subject_id, s.tenant_id, s.created_at, s.last_used_at, s.expires_at, s.revoked_at, s.revoked_reason
    FROM platform.auth_session s
    WHERE s.subject_type = 'platform'
    ORDER BY s.created_at DESC LIMIT 10
  `);
  console.log(`${rows.length} recent platform session(s):`);
  for (const r of rows) console.log(JSON.stringify(r));
} catch(e) {
  // auth_session might be in app schema
  try {
    const { rows } = await db.query(`
      SELECT id, subject_type, subject_id, created_at, last_used_at, expires_at, revoked_at
      FROM app.auth_session WHERE subject_type = 'platform' ORDER BY created_at DESC LIMIT 10
    `);
    console.log(`${rows.length} recent platform session(s) (in app schema):`);
    for (const r of rows) console.log(JSON.stringify(r));
  } catch(e2) {
    console.log(`ERROR: ${e2.message}`);
  }
}

// 9. Migrations run
console.log('\n=== Migrations applied (_migration table) ===');
try {
  const { rows } = await db.query(`SELECT filename FROM public._migration ORDER BY filename`);
  console.log(`${rows.length} migration(s) applied:`);
  rows.forEach(r => console.log(`  ${r.filename}`));
} catch(e) {
  console.log(`ERROR: ${e.message}`);
}

// 10. Permission definitions (to check platform schema is seeded)
console.log('\n=== platform.permission_def count ===');
try {
  const { rows } = await db.query(`SELECT COUNT(*) as count FROM platform.permission_def`);
  console.log(`permission_def rows: ${rows[0].count}`);
} catch(e) {
  console.log(`ERROR: ${e.message}`);
}

await db.end();
console.log('\n=== DONE ===');

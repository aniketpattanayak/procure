#!/usr/bin/env node
/**
 * Adds admin user to the existing Jeevaka tenant.
 * Run: DATABASE_MIGRATOR_URL="..." node add-jeevaka-admin.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, 'apps/api/src/index.ts'));
const { hash, Algorithm } = req('@node-rs/argon2');
const pg = req('pg');

const url = process.env.DATABASE_MIGRATOR_URL;
if (!url) { console.error('DATABASE_MIGRATOR_URL is required'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const ARGON_OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

function genPassword(length = 12) {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digit = '23456789';
  const sym = '@#$%&*!?';
  const all = lower + upper + digit + sym;
  let pw = lower[Math.floor(Math.random()*lower.length)]
         + upper[Math.floor(Math.random()*upper.length)]
         + digit[Math.floor(Math.random()*digit.length)]
         + sym[Math.floor(Math.random()*sym.length)];
  for (let i = 4; i < length; i++) pw += all[Math.floor(Math.random()*all.length)];
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

async function main() {
  await client.connect();
  console.log('Connected to Render PostgreSQL\n');

  // Find the jeevaka tenant
  const tenantRes = await client.query(`SELECT id FROM platform.tenant WHERE code = 'jeevaka'`);
  if (tenantRes.rows.length === 0) {
    console.error('❌ Tenant "jeevaka" not found — run seed-render.mjs first');
    process.exit(1);
  }
  const tenantId = tenantRes.rows[0].id;
  console.log(`✓ Found tenant jeevaka (${tenantId})`);

  // Check if admin user already exists
  const ADMIN_EMAIL = 'admin@jeevaka.local';
  const existingUser = await client.query(
    `SELECT id FROM app.tenant_user WHERE tenant_id = $1 AND email = $2`,
    [tenantId, ADMIN_EMAIL]
  );

  // RLS requires tenant context — must be inside a transaction with SET LOCAL
  await client.query('BEGIN');
  await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);

  if (existingUser.rows.length > 0) {
    // Reset the password
    const newPw = genPassword(12);
    const newHash = await hash(newPw, ARGON_OPTS);
    await client.query(
      `UPDATE app.tenant_user SET password_hash=$1, must_change_password=true, is_active=true,
       failed_logins=0, locked_until=null WHERE id=$2`,
      [newHash, existingUser.rows[0].id]
    );
    await client.query('COMMIT');
    console.log(`✓ Admin user already existed — password reset\n`);
    printCredentials(newPw);
  } else {
    // Create admin user
    const ADMIN_PASSWORD = genPassword(12);
    const adminHash = await hash(ADMIN_PASSWORD, ARGON_OPTS);
    const userRes = await client.query(
      `INSERT INTO app.tenant_user (tenant_id, email, name, is_tenant_admin, password_hash, must_change_password, is_active)
       VALUES ($1,$2,'Jeevaka Admin',true,$3,true,true)
       RETURNING id`,
      [tenantId, ADMIN_EMAIL, adminHash]
    );
    await client.query('COMMIT');
    console.log(`✓ Admin user created (${userRes.rows[0].id})\n`);
    printCredentials(ADMIN_PASSWORD);
  }

  await client.end();
}

function printCredentials(password) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  ✅  Jeevaka is ready on Render!');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('  URL      :  https://procure-web.onrender.com');
  console.log('  Company  :  jeevaka');
  console.log('  Email    :  admin@jeevaka.local');
  console.log('  Password :  ' + password + '  ← save this!');
  console.log('  (You will be asked to change it on first login)\n');
}

main().catch(e => { console.error(e); process.exit(1); });

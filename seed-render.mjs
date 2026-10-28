#!/usr/bin/env node
/**
 * Seeds the Render PostgreSQL database.
 * Run: DATABASE_MIGRATOR_URL="..." node seed-render.mjs
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

  // ── 1. Platform owner ──────────────────────────────────────────────────────
  const OWNER_EMAIL = 'owner@procure.local';
  const ownerHash = await hash('Owner@12345', ARGON_OPTS);

  const existingOwner = await client.query(
    `SELECT id FROM platform.platform_user WHERE email = $1`, [OWNER_EMAIL]
  );
  if (existingOwner.rows.length > 0) {
    await client.query(
      `UPDATE platform.platform_user SET password_hash=$1, is_active=true, must_change_password=false,
       failed_logins=0, locked_until=null, role='owner' WHERE email=$2`,
      [ownerHash, OWNER_EMAIL]
    );
    console.log('✓ Platform owner updated');
  } else {
    await client.query(
      `INSERT INTO platform.platform_user (email, name, role, password_hash, must_change_password)
       VALUES ($1, 'Platform Owner', 'owner', $2, false)`,
      [OWNER_EMAIL, ownerHash]
    );
    console.log('✓ Platform owner created');
  }

  // ── 2. Starter plan ────────────────────────────────────────────────────────
  // Only use feature keys that exist in platform.feature_catalog (from 0004_catalog_seed.sql)
  const STARTER_FEATURES = ['indent', 'purchase', 'grn', 'store', 'reports'];
  const STARTER_LIMITS = { max_users: 10, max_locations: 5, whatsapp_per_month: 0, storage_gb: 2 };

  let planId;
  const existingPlan = await client.query(`SELECT id FROM platform.plan WHERE code = 'starter'`);
  if (existingPlan.rows.length > 0) {
    planId = existingPlan.rows[0].id;
    console.log(`✓ Starter plan already exists (${planId})`);
  } else {
    const res = await client.query(
      `INSERT INTO platform.plan (code, name, description, price, currency, billing_cycle, trial_days, is_active)
       VALUES ('starter','Starter','Core procurement and stores for small teams',4999,'INR','monthly',14,true)
       RETURNING id`
    );
    planId = res.rows[0].id;
    for (const fk of STARTER_FEATURES) {
      await client.query(
        `INSERT INTO platform.plan_feature (plan_id, feature_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [planId, fk]
      );
    }
    for (const [lk, val] of Object.entries(STARTER_LIMITS)) {
      await client.query(
        `INSERT INTO platform.plan_limit (plan_id, limit_key, value) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [planId, lk, val]
      );
    }
    console.log(`✓ Starter plan created (${planId})`);
  }

  // ── 3. Jeevaka tenant ─────────────────────────────────────────────────────
  const TODAY = new Date().toISOString().slice(0, 10);
  const RENEWAL = new Date(Date.now() + 365*24*60*60*1000).toISOString().slice(0, 10);
  const ADMIN_EMAIL = 'admin@jeevaka.local';
  const ADMIN_PASSWORD = genPassword(12);

  const existingTenant = await client.query(`SELECT id FROM platform.tenant WHERE code = 'jeevaka'`);

  if (existingTenant.rows.length > 0) {
    console.log('✓ Tenant "jeevaka" already exists — skipping\n');
    console.log('  Login at https://procure-web.onrender.com with the password from first creation.');
  } else {
    const tenantRes = await client.query(
      `INSERT INTO platform.tenant (code, name, legal_name, timezone, currency, fy_start_month, tax_ids, address, status)
       VALUES ('jeevaka','Jeevaka','Jeevaka ERP Pvt Ltd','Asia/Kolkata','INR',4,'{}','{"country":"IN"}','active')
       RETURNING id`
    );
    const tenantId = tenantRes.rows[0].id;

    await client.query(
      `INSERT INTO platform.subscription (tenant_id, plan_id, status, start_date, renewal_date, effective_from)
       VALUES ($1,$2,'active',$3,$4,now())`,
      [tenantId, planId, TODAY, RENEWAL]
    );

    const adminHash = await hash(ADMIN_PASSWORD, ARGON_OPTS);
    const userRes = await client.query(
      `INSERT INTO app.tenant_user (tenant_id, email, name, is_tenant_admin, password_hash, must_change_password, is_active)
       VALUES ($1,$2,'Jeevaka Admin',true,$3,true,true)
       RETURNING id`,
      [tenantId, ADMIN_EMAIL, adminHash]
    );

    console.log(`✓ Tenant "jeevaka" created (${tenantId})`);
    console.log(`✓ Admin user created (${userRes.rows[0].id})\n`);
    console.log('═══════════════════════════════════════════════════════');
    console.log('  ✅  Jeevaka is ready on Render!');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('  URL      :  https://procure-web.onrender.com');
    console.log('  Company  :  jeevaka');
    console.log('  Email    :  ' + ADMIN_EMAIL);
    console.log('  Password :  ' + ADMIN_PASSWORD + '  ← save this!');
    console.log('  (You will be asked to change it on first login)\n');
  }

  await client.end();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Phase 8 step 1: creates the load tenants THROUGH THE PLATFORM API (so provisioning installs the real system types,
 * workflows, numbering series, templates and roles): tenant `big` plus `s001` … `s<N>` small tenants, all on the
 * `growth` plan; `big` gets limit overrides (users/locations). Admin passwords are then set to `Admin@12345`
 * (hash copied from the demo seed's acme admin) so the measuring scripts can log in. Idempotent: existing tenants
 * are skipped.
 *
 *   API=http://localhost:4121/api/v1 DATABASE_MIGRATOR_URL=postgres://postgres@localhost:5432/procure_load \
 *     node load/phase-8/bootstrap-tenants.mjs [smallTenants=200]
 */
import pg from 'pg';
import { ok, platformLogin } from './lib.mjs';

const SMALL = Number(process.argv[2] ?? 200);
const db = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure_load' });
await db.connect();
const token = await platformLogin();
const plans = await ok('GET', '/platform/plans', { token });
const growth = (plans.data ?? plans).find(p => p.code === 'growth');
if (!growth) throw new Error('growth plan not found (run the demo seed first)');
const existing = new Set((await db.query(`select code from platform.tenant`)).rows.map(r => r.code));

async function create(code, name) {
  if (existing.has(code)) return false;
  await ok('POST', '/platform/tenants', {
    token,
    body: {
      code, name, planId: growth.id, templateBundle: 'standard',
      subscription: { status: 'active', startDate: '2025-10-01' },
      admin: { name: `${name} Admin`, email: `admin@${code}.test` },
    },
  });
  return true;
}

const t0 = Date.now();
if (await create('big', 'Big Manufacturing Ltd')) console.log('created big');
const big = (await db.query(`select id from platform.tenant where code = 'big'`)).rows[0];
for (const [key, value] of [['max_users', 500], ['max_locations', 200], ['custom_forms', 50]]) {
  await ok('PUT', `/platform/tenants/${big.id}/overrides`, { token, body: { kind: 'limit', key, value, reason: 'Phase 8 load tenant' } });
}
let made = 0;
for (let i = 1; i <= SMALL; i++) {
  const code = `s${String(i).padStart(3, '0')}`;
  if (await create(code, `Small Co ${i}`)) made++;
  if (i % 25 === 0) console.log(`  small tenants: ${i}/${SMALL} (${made} new, ${Math.round((Date.now() - t0) / 1000)} s)`);
}
// Known admin password for every load tenant (demo hash of Admin@12345); no forced change.
await db.query(`update app.tenant_user u set password_hash = (select password_hash from app.tenant_user a join platform.tenant t on t.id = a.tenant_id
    where t.code = 'acme' and a.email = 'admin@acme.test'), must_change_password = false
  where u.is_tenant_admin and u.tenant_id in (select id from platform.tenant where code = 'big' or code ~ '^s[0-9]{3}$')`);
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
await db.end();

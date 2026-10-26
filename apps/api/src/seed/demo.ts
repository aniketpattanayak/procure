/**
 * Idempotent demo seed. Run after build:  pnpm --filter @procure/api db:seed
 * Creates the platform owner, two plans, and two demo tenants (acme with overrides, globex without).
 * Re-running updates passwords/plan contents to the documented values and never duplicates rows.
 */
import 'reflect-metadata';
import { Kysely, PostgresDialect, sql, Transaction } from 'kysely';
import { Pool } from 'pg';
import { AUDIT_HASH_ALG, chainHash } from '../core/audit.service';
import type { DB } from '../core/db-types';
import { hashPassword } from '../modules/identity/passwords';
import { APPROVER, seedDocumentSamplesDemo, seedDocumentTypesDemo } from './documents-demo';
import { seedFormsAndMasters } from './forms-demo';
import { seedProcurementDemoA } from './procurement-demo-a';
import { seedProcurementDemoB } from './procurement-demo-b';
import { seedWorkflowDemo } from './workflow-demo';
import { seedNotifyDemo } from './notify-demo';
import { seedReportsDemo } from './reports-demo';
import { seedTemplatesDemo } from './templates-demo';
import { seedGrnDemo } from './grn-demo';
import { seedStockDemo } from './stock-demo';

type Tx = Transaction<DB>;

const url = process.env.DATABASE_PLATFORM_URL;
if (!url) {
  console.error('DATABASE_PLATFORM_URL is not set (run with --env-file=../../.env)');
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 2 });
// A dropped idle connection must not crash the seed (QA-BUG-001); pg replaces it on next use.
pool.on('error', err => console.warn(`seed pool: idle connection lost (${err.message})`));
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

const OWNER = { email: 'owner@procure.local', name: 'Platform Owner', password: 'Owner@12345' };
const TENANT_ADMIN_PASSWORD = 'Admin@12345';

const STARTER_FEATURES = ['indent', 'purchase', 'grn', 'store', 'reports'];
const PLANS = [
  {
    code: 'starter', name: 'Starter', description: 'Core procurement and stores for small teams', price: 4999,
    features: STARTER_FEATURES,
    limits: { max_users: 10, max_locations: 5, whatsapp_per_month: 0, storage_gb: 2 } as Record<string, number | null>,
  },
  {
    code: 'growth', name: 'Growth', description: 'Adds messaging, builders and vendor quotes', price: 14999,
    features: [...STARTER_FEATURES, 'whatsapp', 'email', 'form_builder', 'workflow_designer', 'report_builder', 'vendor_quotes', 'pdf_templates'],
    limits: { max_users: 50, max_locations: 25, whatsapp_per_month: 1000, storage_gb: 20, custom_forms: 25, email_per_month: 5000 } as Record<string, number | null>,
  },
];

const TENANTS = [
  {
    code: 'acme', name: 'Acme Industries', plan: 'starter', admin: { email: 'admin@acme.test', name: 'Acme Admin' },
    overrides: [
      { kind: 'limit' as const, key: 'max_users', value: 25, reason: 'Pilot customer' },
      { kind: 'feature' as const, key: 'whatsapp', value: true, reason: 'Pilot customer' },
      // The demo location tree (seedAcmeLocationsAndIndenter) has 6 nodes; starter allows 5.
      { kind: 'limit' as const, key: 'max_locations', value: 25, reason: 'Pilot customer' },
      // Phase 2 demo (seedFormsAndMasters): form builder on, room for the demo custom masters.
      { kind: 'feature' as const, key: 'form_builder', value: true, reason: 'Pilot customer' },
      { kind: 'limit' as const, key: 'custom_forms', value: 10, reason: 'Pilot customer' },
      // Phase 3 demo: acme designs its own approval workflows.
      { kind: 'feature' as const, key: 'workflow_designer', value: true, reason: 'Pilot customer' },
      // Phase 7 demo: acme builds its own reports.
      { kind: 'feature' as const, key: 'report_builder', value: true, reason: 'Pilot customer' },
      // Phase 4 demo (procurement): indent, vendor quotes/selection and purchase orders on.
      { kind: 'feature' as const, key: 'indent', value: true, reason: 'Pilot customer' },
      { kind: 'feature' as const, key: 'vendor_quotes', value: true, reason: 'Pilot customer' },
      { kind: 'feature' as const, key: 'purchase', value: true, reason: 'Pilot customer' },
      // Phase 5 demo (stock agent): GRN chain and stores on.
      { kind: 'feature' as const, key: 'grn', value: true, reason: 'Pilot customer' },
      { kind: 'feature' as const, key: 'store', value: true, reason: 'Pilot customer' },
    ],
  },
  { code: 'globex', name: 'Globex Corporation', plan: 'starter', admin: { email: 'admin@globex.test', name: 'Globex Admin' }, overrides: [] },
];

async function auditPlatform(tx: Tx, action: string, entity: string, entityId: string, tenantId: string | null, after: unknown) {
  await sql`select pg_advisory_xact_lock(hashtextextended('audit:platform', 0))`.execute(tx);
  const prev = await tx.selectFrom('platform.audit_log').select('hash').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const row = {
    actor_id: null, action, entity, entity_id: entityId, tenant_id: tenantId, before: null,
    after: JSON.stringify(after), ip: null, user_agent: 'seed', at: new Date().toISOString(),
  };
  await tx.insertInto('platform.audit_log').values({ ...row, prev_hash: prev?.hash ?? null, hash: chainHash(prev?.hash ?? null, row), hash_alg: AUDIT_HASH_ALG }).execute();
}

async function auditTenant(tx: Tx, action: string, entity: string, entityId: string, after: unknown) {
  await sql`select pg_advisory_xact_lock(hashtextextended('audit:' || app.current_tenant_id()::text, 0))`.execute(tx);
  // platform_user bypasses RLS: filter the chain by tenant explicitly.
  const prev = await tx.selectFrom('app.audit_log').select('hash').where('tenant_id', '=', sql<string>`app.current_tenant_id()`).orderBy('id', 'desc').limit(1).executeTakeFirst();
  const row = {
    actor_id: null, impersonated_by: null, action, entity, entity_id: entityId, before: null,
    after: JSON.stringify(after), ip: null, user_agent: 'seed', at: new Date().toISOString(),
  };
  await tx.insertInto('app.audit_log').values({ ...row, prev_hash: prev?.hash ?? null, hash: chainHash(prev?.hash ?? null, row), hash_alg: AUDIT_HASH_ALG }).execute();
}

// ===================================================================================== Permissions agent (Phase 2)
// Location levels + demo tree + a restricted "indent clerk" user for acme. Idempotent: looks rows up by code/key/email.
const INDENTER = { email: 'indenter@acme.test', name: 'Indent Clerk', password: 'Indent@12345' };
const ACME_TREE: { code: string; name: string; parent: string | null }[] = [
  { code: 'PUNE', name: 'Pune Plant', parent: null },
  { code: 'PUNE-MAIN', name: 'Main Store', parent: 'PUNE' },
  { code: 'PUNE-MAIN-A1', name: 'Bin A1', parent: 'PUNE-MAIN' },
  { code: 'PUNE-MAIN-A2', name: 'Bin A2', parent: 'PUNE-MAIN' },
  { code: 'CHENNAI', name: 'Chennai Plant', parent: null },
  { code: 'CHENNAI-RM', name: 'Raw Material Store', parent: 'CHENNAI' },
];

async function seedAcmeLocationsAndIndenter() {
  const indenterHash = await hashPassword(INDENTER.password);
  await db.transaction().execute(async tx => {
    const tenant = await tx.selectFrom('platform.tenant').select('id').where('code', '=', 'acme').executeTakeFirst();
    if (!tenant) return;
    const tenantId = tenant.id;
    await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
    // platform_user bypasses RLS: every app.* query filters by tenant explicitly.

    const levels = JSON.stringify(['Plant', 'Store', 'Bin']);
    await tx.insertInto('app.tenant_setting').values({ tenant_id: tenantId, key: 'labels.location_levels', value: levels })
      .onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: levels, updated_at: new Date() })).execute();

    const ids = new Map<string, string>();
    for (const n of ACME_TREE) {
      const parentId = n.parent ? ids.get(n.parent)! : null;
      const existing = await tx.selectFrom('app.location_node').select(['id', 'parent_id', 'name', 'is_active'])
        .where('tenant_id', '=', tenantId).where('code', '=', n.code).executeTakeFirst();
      if (existing) {
        if (existing.parent_id !== parentId || existing.name !== n.name || !existing.is_active) {
          await tx.updateTable('app.location_node').set({ parent_id: parentId, name: n.name, is_active: true }).where('id', '=', existing.id).execute();
        }
        ids.set(n.code, existing.id);
      } else {
        const row = await tx.insertInto('app.location_node').values({ tenant_id: tenantId, parent_id: parentId, code: n.code, name: n.name })
          .returning('id').executeTakeFirstOrThrow();
        await auditTenant(tx, 'create', 'location', row.id, { code: n.code, name: n.name, source: 'seed' });
        ids.set(n.code, row.id);
      }
    }

    let role = await tx.selectFrom('app.role').select('id').where('tenant_id', '=', tenantId).where('key', '=', 'indent_clerk').executeTakeFirst();
    if (!role) {
      role = await tx.insertInto('app.role').values({ tenant_id: tenantId, key: 'indent_clerk', name: 'Indent clerk', description: 'Raises indents for Pune Plant' })
        .returning('id').executeTakeFirstOrThrow();
      await auditTenant(tx, 'create', 'role', role.id, { key: 'indent_clerk', source: 'seed' });
    } else {
      await tx.updateTable('app.role').set({ name: 'Indent clerk', is_deleted: false }).where('id', '=', role.id).execute();
    }
    // Exactly these grants (Phase 4 adds indent keys) and scope = Pune Plant incl. descendants.
    await tx.deleteFrom('app.permission_grant').where('tenant_id', '=', tenantId).where('role_id', '=', role.id).execute();
    await tx.insertInto('app.permission_grant').values([
      { tenant_id: tenantId, role_id: role.id, perm_key: 'admin.locations:action.view', effect: 'allow' },
      { tenant_id: tenantId, role_id: role.id, perm_key: 'admin.locations:view.active', effect: 'allow' },
    ]).execute();
    await tx.deleteFrom('app.scope_grant').where('tenant_id', '=', tenantId).where('role_id', '=', role.id).execute();
    await tx.insertInto('app.scope_grant').values({ tenant_id: tenantId, role_id: role.id, node_id: ids.get('PUNE')!, all_nodes: false, include_descendants: true }).execute();

    let user = await tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', tenantId).where('email', '=', INDENTER.email).executeTakeFirst();
    if (user) {
      await tx.updateTable('app.tenant_user')
        .set({ password_hash: indenterHash, must_change_password: false, is_active: true, is_deleted: false, is_tenant_admin: false, failed_logins: 0, locked_until: null })
        .where('id', '=', user.id).execute();
    } else {
      user = await tx.insertInto('app.tenant_user')
        .values({ tenant_id: tenantId, email: INDENTER.email, name: INDENTER.name, password_hash: indenterHash, is_tenant_admin: false, must_change_password: false })
        .returning('id').executeTakeFirstOrThrow();
      await auditTenant(tx, 'create', 'user', user.id, { email: INDENTER.email, source: 'seed' });
    }
    await tx.deleteFrom('app.user_role').where('tenant_id', '=', tenantId).where('user_id', '=', user.id).execute();
    await tx.insertInto('app.user_role').values({ tenant_id: tenantId, user_id: user.id, role_id: role.id }).execute();
  });
}
// ===================================================================================== end Permissions agent

async function main() {
  const ownerHash = await hashPassword(OWNER.password);
  const adminHash = await hashPassword(TENANT_ADMIN_PASSWORD);

  // ---- platform owner
  await db.transaction().execute(async tx => {
    const existing = await tx.selectFrom('platform.platform_user').select('id').where('email', '=', OWNER.email).executeTakeFirst();
    if (existing) {
      await tx.updateTable('platform.platform_user')
        .set({ password_hash: ownerHash, is_active: true, must_change_password: false, failed_logins: 0, locked_until: null, role: 'owner' })
        .where('id', '=', existing.id).execute();
    } else {
      const u = await tx.insertInto('platform.platform_user')
        .values({ email: OWNER.email, name: OWNER.name, role: 'owner', password_hash: ownerHash, must_change_password: false })
        .returning('id').executeTakeFirstOrThrow();
      await auditPlatform(tx, 'create', 'platform_user', u.id, null, { email: OWNER.email, role: 'owner', source: 'seed' });
    }
  });

  // ---- plans (contents reset to the documented values)
  const planIds = new Map<string, string>();
  for (const p of PLANS) {
    await db.transaction().execute(async tx => {
      const existing = await tx.selectFrom('platform.plan').select('id').where('code', '=', p.code).executeTakeFirst();
      let id: string;
      if (existing) {
        id = existing.id;
        await tx.updateTable('platform.plan').set({ name: p.name, description: p.description, price: p.price, is_active: true }).where('id', '=', id).execute();
        await tx.deleteFrom('platform.plan_feature').where('plan_id', '=', id).execute();
        await tx.deleteFrom('platform.plan_limit').where('plan_id', '=', id).execute();
      } else {
        id = (await tx.insertInto('platform.plan')
          .values({ code: p.code, name: p.name, description: p.description, price: p.price, currency: 'INR', billing_cycle: 'monthly', trial_days: 14 })
          .returning('id').executeTakeFirstOrThrow()).id;
        await auditPlatform(tx, 'create', 'plan', id, null, { code: p.code, source: 'seed' });
      }
      await tx.insertInto('platform.plan_feature').values(p.features.map(feature_key => ({ plan_id: id, feature_key }))).execute();
      await tx.insertInto('platform.plan_limit').values(Object.entries(p.limits).map(([limit_key, value]) => ({ plan_id: id, limit_key, value }))).execute();
      planIds.set(p.code, id);
    });
  }

  // ---- tenants
  for (const t of TENANTS) {
    await db.transaction().execute(async tx => {
      let tenant = await tx.selectFrom('platform.tenant').select(['id']).where('code', '=', t.code).executeTakeFirst();
      const created = !tenant;
      if (!tenant) {
        tenant = await tx.insertInto('platform.tenant').values({ code: t.code, name: t.name, tax_ids: '{}', address: '{}' })
          .returning('id').executeTakeFirstOrThrow();
      } else {
        await tx.updateTable('platform.tenant').set({ status: 'active', status_reason: null }).where('id', '=', tenant.id).execute();
      }
      const tenantId = tenant.id;
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);

      // Subscription: one open row on the documented plan.
      const planId = planIds.get(t.plan)!;
      const open = await tx.selectFrom('platform.subscription').select(['id', 'plan_id', 'status']).where('tenant_id', '=', tenantId).where('effective_to', 'is', null).executeTakeFirst();
      if (!open || open.plan_id !== planId || open.status !== 'active') {
        if (open) await tx.updateTable('platform.subscription').set({ effective_to: new Date() }).where('id', '=', open.id).execute();
        await tx.insertInto('platform.subscription').values({
          tenant_id: tenantId, plan_id: planId, status: 'active', start_date: new Date().toISOString().slice(0, 10),
          effective_from: new Date(), change_reason: 'Demo seed',
        }).execute();
      }

      // Overrides: exactly the documented set.
      const wanted = new Map(t.overrides.map(o => [`${o.kind}:${o.key}`, o]));
      const current = await tx.selectFrom('platform.tenant_override').select(['kind', 'key', 'value']).where('tenant_id', '=', tenantId).execute();
      for (const c of current) {
        const k = `${c.kind}:${c.key}`;
        const w = wanted.get(k);
        if (!w) {
          await tx.deleteFrom('platform.tenant_override').where('tenant_id', '=', tenantId).where('kind', '=', c.kind).where('key', '=', c.key).execute();
          await tx.insertInto('platform.tenant_override_history').values({ tenant_id: tenantId, kind: c.kind, key: c.key, old_value: JSON.stringify(c.value), new_value: null, reason: 'Demo seed reset' }).execute();
        }
      }
      for (const o of t.overrides) {
        const c = current.find(x => x.kind === o.kind && x.key === o.key);
        if (c && JSON.stringify(c.value) === JSON.stringify(o.value)) continue;
        await tx.insertInto('platform.tenant_override')
          .values({ tenant_id: tenantId, kind: o.kind, key: o.key, value: JSON.stringify(o.value), reason: o.reason })
          .onConflict(oc => oc.columns(['tenant_id', 'kind', 'key']).doUpdateSet({ value: JSON.stringify(o.value), reason: o.reason, set_at: new Date() }))
          .execute();
        await tx.insertInto('platform.tenant_override_history').values({
          tenant_id: tenantId, kind: o.kind, key: o.key, old_value: c ? JSON.stringify(c.value) : null, new_value: JSON.stringify(o.value), reason: o.reason,
        }).execute();
      }

      // System role + admin user
      // platform_user bypasses RLS, so every app.* lookup filters by tenant explicitly.
      let role = await tx.selectFrom('app.role').select('id').where('tenant_id', '=', tenantId).where('key', '=', 'tenant_admin').executeTakeFirst();
      role ??= await tx.insertInto('app.role')
        .values({ key: 'tenant_admin', name: 'Company administrator', description: 'Full access to everything in the plan', is_system: true })
        .returning('id').executeTakeFirstOrThrow();
      let admin = await tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', tenantId).where('email', '=', t.admin.email).executeTakeFirst();
      if (admin) {
        await tx.updateTable('app.tenant_user')
          .set({ password_hash: adminHash, must_change_password: false, is_active: true, is_deleted: false, is_tenant_admin: true, failed_logins: 0, locked_until: null })
          .where('id', '=', admin.id).execute();
      } else {
        admin = await tx.insertInto('app.tenant_user')
          .values({ email: t.admin.email, name: t.admin.name, password_hash: adminHash, is_tenant_admin: true, must_change_password: false })
          .returning('id').executeTakeFirstOrThrow();
      }
      await tx.insertInto('app.user_role').values({ user_id: admin.id, role_id: role.id }).onConflict(oc => oc.doNothing()).execute();

      if (created) {
        await auditPlatform(tx, 'create', 'tenant', tenantId, tenantId, { code: t.code, plan: t.plan, source: 'seed' });
        await auditTenant(tx, 'create', 'tenant', tenantId, { code: t.code, adminUserId: admin.id, source: 'seed' });
      }
    });
  }

  await seedAcmeLocationsAndIndenter();
  // ---- Phase 2 (Form & master engine): system forms/masters + standard bundle for both tenants, acme sample data.
  await seedFormsAndMasters(db, TENANTS.map(t => t.code));
  // ---- Phase 3 (Documents agent): Capex Request type + numbering + doc.capex grants (before the workflow seed) …
  await seedDocumentTypesDemo(db);
  // ---- Phase 3 (Workflow agent): Capex workflow + stage-key grants. Keep AFTER the doc-type seed and BEFORE sample
  // documents are submitted (so they run on this workflow).
  await seedWorkflowDemo(db);
  // … and two sample Capex documents (one draft, one submitted onto the published workflow).
  await seedDocumentSamplesDemo(db);
  // ---- Phase 4 (Procurement agent A): procurement types, vendors, approved indent, quotes, split selection.
  await seedProcurementDemoA(db);
  // ---- Phase 4 (Procurement agent B): selection approved, one PO per vendor, Maharashtra PO approved + follow-up.
  await seedProcurementDemoB(db);
  // ---- Phase 5 (Stock agent): store types, stock grants, opening balances at Main Store, re-order rules, transfer.
  await seedStockDemo(db);
  // ---- Phase 5 (GRN agent): two partial GRNs through the chain (QA reject → blocked → RTV), issue request + partial
  // issue + partial return. Keep AFTER the stock seed.
  await seedGrnDemo(db);
  // ---- Phase 6 (Templates agent): starter templates + print keys for every tenant, acme letterhead/logo.
  await seedTemplatesDemo(db, TENANTS.map(t => t.code));

  // ---- Phase 6 (Notify agent): log providers, WhatsApp templates for acme, acme limits + trigger rules. Keep LAST
  // (after templates/procurement) so the starter templates and PO type exist.
  await seedNotifyDemo(db);
  // ---- Phase 7 (Reports agent): built-in reports + "My work" for every tenant; acme Capex report + Approver dashboard.
  await seedReportsDemo(db, TENANTS.map(t => t.code));

  // Seeded data bypasses the API, so drop any cached entitlements/principals/permissions.
  try {
    const { default: Redis } = await import('ioredis');
    const r = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, lazyConnect: true });
    await r.connect();
    for (const pattern of ['tenant-state:*', 'principal:*', 'perm:*']) {
      const keys = await r.keys(pattern);
      if (keys.length) await r.del(...keys);
    }
    r.disconnect();
  } catch {
    console.warn('(could not reach Redis to clear caches; they expire within 5 minutes)');
  }

  console.log('\nSeed complete. Demo credentials:\n');
  console.log(`  Super Admin   ${OWNER.email.padEnd(20)} ${OWNER.password}   (POST /api/v1/auth/platform/login)`);
  for (const t of TENANTS) {
    console.log(`  ${t.code.padEnd(13)} ${t.admin.email.padEnd(20)} ${TENANT_ADMIN_PASSWORD}   (POST /api/v1/auth/login, tenantCode "${t.code}")`);
  }
  console.log(`  ${'acme'.padEnd(13)} ${INDENTER.email.padEnd(20)} ${INDENTER.password}  (restricted: role "Indent clerk", scope Pune Plant + below)`);
  console.log(`  ${'acme'.padEnd(13)} ${APPROVER.email.padEnd(20)} ${APPROVER.password} (restricted: role "Approver" — Capex HOD stage, scope Pune Plant + below)`);
  console.log('\n  acme: plan starter + overrides max_users=25, max_locations=25, whatsapp=on ("Pilot customer"); globex: plan starter, no overrides.');
  console.log('  acme + globex: system masters (Items, Vendors, UoM, Terms, Payment Terms) + standard bundle (roles, UoMs).');
  console.log('  acme masters: Item Categories A/B/C, Item Sub-categories D/E/F (A), H (B); 5 items with std pack value formula.');
  console.log('  acme locations: Pune Plant → Main Store → Bin A1, Bin A2; Chennai Plant → Raw Material Store (levels Plant/Store/Bin).\n');
}

/** Runs the whole demo seed in-process (integration tests: `test/report-pack*.test.ts`) and closes its pool. */
export async function runDemoSeed(): Promise<void> {
  try {
    await main();
  } finally {
    await db.destroy();
  }
}

// CLI entry (`pnpm db:seed`); under vitest the module is imported for runDemoSeed instead.
if (!process.env.VITEST) {
  main()
    .then(() => db.destroy())
    .catch(async e => {
      console.error(e);
      await db.destroy();
      process.exit(1);
    });
}

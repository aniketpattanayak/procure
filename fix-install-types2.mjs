/**
 * fix-install-types.mjs
 *
 * ROOT CAUSE
 * ----------
 * Indent / PO / GRN are not hardcoded menu items. Each is a row in app.doc_type,
 * created by the app's ProcurementInstaller ("system types"). That installer runs from:
 *   1. tenants.service.ts at tenant creation  — wrapped in try/catch, failure is only logged
 *   2. provisioning-boot.ts on API startup    — enqueued to the BullMQ "provisioning" queue
 *
 * On Render, render.yaml sets RUN_WORKERS=off and deploys no worker service, so the
 * boot job is enqueued and never consumed. Locally you run workers inline, so it worked.
 * Result: app.doc_type is empty -> no Indent/PO/GRN tabs, and nothing ever reported an error.
 *
 * THIS SCRIPT
 * -----------
 * Boots the API's own compiled code against the Render DB and runs the installer directly,
 * then sets the flow settings that gate the tabs and grants the new doc.* keys to the roles.
 *
 * Run:  node ~/Desktop/OMM_SYS/procure/fix-install-types.mjs
 */

// ─── Point the app at the Render database ────────────────────────────────────
const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9?sslmode=require';
const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

process.env.NODE_ENV              = 'development';          // avoids prod-only secret requirements
process.env.DATABASE_URL          = RENDER_DB;
process.env.DATABASE_PLATFORM_URL = RENDER_DB;
process.env.DATABASE_MIGRATOR_URL = RENDER_DB;
process.env.JWT_SECRET            = 'local-fix-script-jwt-secret-0123456789abcdef';
process.env.RUN_WORKERS           = 'off';                  // do not start BullMQ workers
process.env.REDIS_URL             = 'rediss://default:gQAAAAAAA6jZAAIgcDFhMjNlYTRmODcyMTc0ZjRjOWFjODUzZWM4ZjIyYjllYQ@sharing-flounder-239833.upstash.io:6379';
process.env.STORAGE_DRIVER        = 'local';
process.env.DB_POOL_SIZE          = '4';

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here   = dirname(fileURLToPath(import.meta.url));
const DIST   = join(here, 'apps/api/dist');
const req    = createRequire(join(here, 'node_modules/pg/package.json'));
// The API's deps live under apps/api (pnpm), so resolve Nest + dist from there.
const apiReq = createRequire(join(here, 'apps/api/package.json'));
const { Client } = req('pg');

const log  = (...a) => console.log(...a);
const step = s => log(`\n═══ ${s} ═══`);

// ─── Raw DB client for the bits the services do not expose ───────────────────
const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();
const tenantTx = async fn => {
  await db.query('BEGIN');
  await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
  try { const r = await fn(); await db.query('COMMIT'); return r; }
  catch (e) { await db.query('ROLLBACK'); throw e; }
};

// ─── 1. Turn on the vendor_quotes feature (indent -> selection -> PO chain) ───
step('1. Feature overrides');
const { rows: overrides } = await db.query(
  `SELECT kind, key, value FROM platform.tenant_override WHERE tenant_id = $1`, [TENANT_ID]
);
log('  existing overrides:', overrides.length ? JSON.stringify(overrides) : '(none)');

// Mirror the shape of an existing feature override; fall back to JSON true.
const sample = overrides.find(o => o.kind === 'feature');
const onValue = sample ? sample.value : true;
for (const key of ['indent', 'vendor_quotes', 'purchase', 'grn', 'store', 'reports', 'form_builder']) {
  await db.query(
    `INSERT INTO platform.tenant_override (tenant_id, kind, key, value)
     VALUES ($1, 'feature', $2, $3)
     ON CONFLICT (tenant_id, kind, key) DO UPDATE SET value = EXCLUDED.value`,
    [TENANT_ID, key, JSON.stringify(onValue)]
  ).catch(e => log(`  ! ${key}: ${e.message}`));
}
const { rows: afterOv } = await db.query(
  `SELECT key, value FROM platform.tenant_override WHERE tenant_id = $1 AND kind = 'feature' ORDER BY key`, [TENANT_ID]
);
log('  features now overridden on:', afterOv.map(o => o.key).join(', '));

// ─── 2. Flow settings that gate the Indent / Vendor Selection tabs ────────────
// permissions/compiler.ts:87 -> `if (e.requiresSetting && settings[e.requiresSetting] !== true) return 'setting'`
// i.e. the tab is hidden unless the setting is exactly true. app.tenant_setting was EMPTY.
step('2. Flow settings (tab gating)');
const SETTINGS = {
  'flow.indent.enabled': true,
  'flow.vendor_selection.enabled': true,
  'flow.po.direct_allowed': false,
  'flow.issue.without_indent': true,
  'grn.over_receipt_pct': 5,
  'grn.multi_po': false,
};
await tenantTx(async () => {
  for (const [key, value] of Object.entries(SETTINGS)) {
    await db.query(
      `INSERT INTO app.tenant_setting (tenant_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [TENANT_ID, key, JSON.stringify(value)]
    );
    log(`  ${key} = ${JSON.stringify(value)}`);
  }
});

// ─── 3. Boot the API's own code and run the installer ────────────────────────
step('3. Boot API application context');
const { NestFactory }          = apiReq('@nestjs/core');
const { AppModule }            = apiReq(join(DIST, 'app.module.js'));
const { DbService }            = apiReq(join(DIST, 'core/db.service.js'));
const { EntitlementsService }  = apiReq(join(DIST, 'core/entitlements.service.js'));
const { ProcurementInstaller } = apiReq(join(DIST, 'modules/procurement/index.js'));
const { TemplateInstaller, MastersService, RecordsService } = apiReq(join(DIST, 'modules/forms/index.js'));
const { sql: ksql } = apiReq('kysely');

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ['error', 'warn'],
  abortOnError: false,
});
log('  ✓ app context booted');

const dbSvc     = app.get(DbService);
const ent       = app.get(EntitlementsService);
const installer = app.get(ProcurementInstaller);
const templates = app.get(TemplateInstaller);
const masters   = app.get(MastersService);
const records   = app.get(RecordsService);

log('  install steps registered:', installer.ordered().map(s => `${s.order}:${s.key}`).join(', '));

// Refresh entitlements so the installer sees the features we just switched on.
await ent.invalidate(TENANT_ID);
const state = await ent.state(TENANT_ID);
const features = state?.features ?? [];
log('  tenant features:', features.join(', ') || '(none)');

// Who to attribute created rows to.
const { rows: [admin] } = await tenantTx(() => db.query(
  `SELECT id, email FROM app.tenant_user WHERE tenant_id = $1 AND email = 'admin@jeevaka.local'`, [TENANT_ID]
));
log('  actor:', admin?.email ?? '(system)');

// ─── 3b. System masters (uom, item, vendor, payment_terms, terms) ────────────
// Phase 2 step from tenants.service.ts:132 — also never ran for this tenant, which is
// why the indent form failed to publish: its line fields look up masters "item" and "uom".
step('3b. Install system masters (TemplateInstaller.installSystem)');
const beforeMasters = await tenantTx(() => db.query(
  `SELECT key FROM app.master_def WHERE tenant_id = $1 ORDER BY key`, [TENANT_ID]
));
log('  before:', beforeMasters.rows.map(r => r.key).join(', ') || '(none)');

await dbSvc.tenantTx(TENANT_ID, tx => templates.installSystem(tx));

const afterMasters = await tenantTx(() => db.query(
  `SELECT key FROM app.master_def WHERE tenant_id = $1 ORDER BY key`, [TENANT_ID]
));
log('  after: ', afterMasters.rows.map(r => r.key).join(', '));

// ─── 3c. A few Units of Measure so items can actually be created ─────────────
step('3c. Seed Unit of Measure records');
const UOMS = [
  { code: 'NOS', name: 'Numbers',   data: { decimals: 0 } },
  { code: 'KG',  name: 'Kilogram',  data: { decimals: 3 } },
  { code: 'MT',  name: 'Metric Ton',data: { decimals: 3 } },
  { code: 'LTR', name: 'Litre',     data: { decimals: 2 } },
  { code: 'MTR', name: 'Metre',     data: { decimals: 2 } },
  { code: 'SET', name: 'Set',       data: { decimals: 0 } },
];
await dbSvc.tenantTx(TENANT_ID, async tx => {
  const uom = await masters.find(tx, TENANT_ID, 'uom');
  if (!uom) { log('  ! uom master not found, skipping'); return; }
  const actor = { tenantId: TENANT_ID, userId: admin?.id ?? null, perms: null };
  for (const row of UOMS) {
    const exists = await tx.selectFrom('app.master_record').select('id')
      .where('tenant_id', '=', TENANT_ID).where('master_id', '=', uom.id)
      .where('is_deleted', '=', false)
      .where(ksql`code = ${row.code}::citext`).executeTakeFirst();
    if (exists) { log(`  = ${row.code} (already there)`); continue; }
    await records.save(tx, actor, uom, { code: row.code, name: row.name, data: row.data }, null);
    log(`  + ${row.code} ${row.name}`);
  }
});

step('4. Run ProcurementInstaller.ensure');
await dbSvc.tenantTx(TENANT_ID, tx =>
  installer.ensure(tx, TENANT_ID, { features, actorId: admin?.id ?? null })
);
log('  ✓ installer finished');

// ─── 5. What got created ─────────────────────────────────────────────────────
step('5. Document types now present');
const { rows: types } = await tenantTx(() => db.query(
  `SELECT key, name, kind, module_key, is_active FROM app.doc_type WHERE tenant_id = $1 ORDER BY key`, [TENANT_ID]
));
if (!types.length) log('  *** still none — see errors above ***');
types.forEach(t => log(`  ${t.key.padEnd(18)} ${t.name.padEnd(22)} module=${t.module_key ?? '-'} active=${t.is_active}`));

// ─── 6. Grant the new doc.* permission keys to the roles ─────────────────────
step('6. Grant doc.* keys to roles');
const { rows: defs } = await tenantTx(() => db.query(
  `SELECT key, tab_key FROM app.permission_def WHERE tenant_id = $1 AND key LIKE 'doc.%' ORDER BY key`, [TENANT_ID]
));
log(`  ${defs.length} tenant doc.* permission keys found`);
const DOC_KEYS = defs.map(d => d.key);

const forTypes = (...typeKeys) =>
  DOC_KEYS.filter(k => typeKeys.some(t => k === `doc.${t}` || k.startsWith(`doc.${t}:`)));
const viewOf = (...typeKeys) =>
  DOC_KEYS.filter(k => typeKeys.some(t =>
    k === `doc.${t}` || k === `doc.${t}:action.view` || k.startsWith(`doc.${t}:view.`)));

const PROC  = ['indent', 'vendor_selection', 'po'];
const STORE = ['grn', 'rtv', 'issue_request', 'store_issue', 'store_return',
               'stock_transfer', 'stock_adjustment', 'stock_count'];

const ROLE_DOC_KEYS = {
  Manager:  DOC_KEYS,
  Purchase: [...forTypes(...PROC), ...viewOf(...STORE)],
  Store:    [...forTypes(...STORE), ...viewOf(...PROC)],
  Indenter: [...forTypes('indent'), ...viewOf('vendor_selection', 'po')],
  Accounts: [...viewOf(...PROC, ...STORE)],
  Gate:     [...forTypes('grn', 'rtv'), ...viewOf('po', 'indent')],
  Weigh:    [...forTypes('grn'), ...viewOf('po', 'indent')],
  Lab:      [...viewOf('grn', 'indent')],
  Viewer:   [...viewOf(...PROC, ...STORE)],
};

const { rows: roles } = await tenantTx(() => db.query(
  `SELECT id, name FROM app.role WHERE tenant_id = $1 AND is_deleted = false ORDER BY name`, [TENANT_ID]
));

for (const role of roles) {
  const keys = [...new Set(ROLE_DOC_KEYS[role.name] ?? DOC_KEYS)];
  if (!keys.length) { log(`  ${role.name}: 0 doc keys (skipped)`); continue; }
  await tenantTx(async () => {
    // Remove only the doc.* grants, leave the platform-tab grants alone.
    await db.query(
      `DELETE FROM app.permission_grant WHERE tenant_id = $1 AND role_id = $2 AND perm_key LIKE 'doc.%'`,
      [TENANT_ID, role.id]
    );
    const values = [];
    const params = [TENANT_ID, role.id];
    let i = 3;
    for (const k of keys) { values.push(`(app.uuid_v7(), $1, $2, NULL, $${i}, 'allow')`); params.push(k); i++; }
    await db.query(
      `INSERT INTO app.permission_grant (id, tenant_id, role_id, user_id, perm_key, effect)
       VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`, params
    );
  });
  log(`  ${role.name.padEnd(10)} +${keys.length} doc keys`);
}

// ─── 7. Bump the permission version so clients refetch ───────────────────────
step('7. Invalidate caches');
await ent.bumpPermissions(TENANT_ID);
await ent.invalidate(TENANT_ID);
log('  ✓ permission version bumped, entitlements invalidated');

// ─── 8. Verify ───────────────────────────────────────────────────────────────
step('8. Verification');
const { rows: tabs } = await tenantTx(() => db.query(
  `SELECT key, requires_feature, requires_setting FROM app.permission_def
   WHERE tenant_id = $1 AND kind = 'tab' ORDER BY sort_order NULLS LAST, key`, [TENANT_ID]
));
log('  Tenant tabs:');
tabs.forEach(t => log(`    ${t.key.padEnd(28)} feature=${t.requires_feature ?? '-'} setting=${t.requires_setting ?? '-'}`));

const { rows: gcount } = await tenantTx(() => db.query(
  `SELECT r.name, COUNT(*) FILTER (WHERE pg.perm_key LIKE 'doc.%') AS doc_grants, COUNT(*) AS total
   FROM app.role r LEFT JOIN app.permission_grant pg ON pg.role_id = r.id AND pg.tenant_id = r.tenant_id
   WHERE r.tenant_id = $1 AND r.is_deleted = false GROUP BY r.name ORDER BY r.name`, [TENANT_ID]
));
log('\n  Grants per role:');
gcount.forEach(g => log(`    ${g.name.padEnd(10)} ${String(g.doc_grants).padStart(3)} doc + ${g.total} total`));

await app.close();
await db.end();

log('\n✓ Done.');
log('  Sign OUT of the web app, then sign back in:');
log('    company code: jeevaka');
log('    email:        admin@jeevaka.local');
log('    password:     Jeevaka@2026');
log('  Indent, Vendor Selection, Purchase Orders and Goods Receipt should now be in the sidebar.');

/**
 * fix-role-permissions4.mjs
 * Inserts rows directly into app.permission_grant and app.scope_grant
 * for all 9 Jeevaka roles.
 *
 * Run: node ~/Desktop/OMM_SYS/procure/fix-role-permissions4.mjs
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

// ─── Step 1: Load all platform permission keys ────────────────────────────────
console.log('\n═══ Step 1: Load all permission keys ═══');
const { rows: permDefs } = await db.query(
  `SELECT key FROM platform.permission_def ORDER BY sort_order, key`
);
const ALL_KEYS = permDefs.map(p => p.key);
console.log(`  ${ALL_KEYS.length} platform permission keys loaded`);

// ─── Step 2: Load roles ───────────────────────────────────────────────────────
console.log('\n═══ Step 2: Load roles ═══');
await db.query(`BEGIN`);
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
const { rows: roles } = await db.query(
  `SELECT id, name FROM app.role WHERE tenant_id = $1 AND is_deleted = false ORDER BY name`,
  [TENANT_ID]
);
await db.query(`COMMIT`);
console.log('  Roles:', roles.map(r => r.name).join(', '));

// ─── Step 3: Define permission sets per role ──────────────────────────────────
// Key groups:
//   admin.*      = admin.users, admin.roles, admin.locations, admin.settings, admin.usage, admin.audit
//   config.*     = config.forms, config.masters, config.doc_types, config.numbering, config.workflows, config.templates, config.triggers, config.webhooks
//   indent       = indent tab + all its actions/views
//   purchase     = purchase orders tab
//   approvals    = approvals tab
//   grn          = goods receipt tab (key from DB: "grn")
//   stock        = store & inventory tab (key from DB: "stock")
//   reports      = reports tab
//   dashboards   = dashboard tab
//   messages     = messages/notifications tab
//   master.*     = auto-created master tabs (department, raw_material etc) — none yet since app.permission_def is empty

function keys(...prefixes) {
  return ALL_KEYS.filter(k => prefixes.some(p => k === p || k.startsWith(p + ':')));
}
function viewOnly(...prefixes) {
  return ALL_KEYS.filter(k => prefixes.some(p =>
    k === p || k === `${p}:action.view` || k.startsWith(`${p}:view.`)
  ));
}

const ROLE_PERMS = {
  // Manager: everything
  'Manager': ALL_KEYS,

  // Purchase team: indents, POs, GRN, reports + config view + admin view
  'Purchase': [
    ...keys('indent', 'purchase', 'grn', 'approvals', 'reports', 'dashboards', 'messages'),
    ...viewOnly('stock'),
    ...viewOnly('admin.locations', 'admin.settings', 'admin.usage'),
    ...viewOnly('config.masters', 'config.doc_types', 'config.numbering', 'config.templates'),
  ],

  // Store: GRN, stock, can view indents
  'Store': [
    ...keys('grn', 'stock', 'approvals', 'reports', 'dashboards', 'messages'),
    ...viewOnly('indent', 'purchase'),
    ...viewOnly('admin.locations'),
    ...viewOnly('config.masters', 'config.doc_types', 'config.numbering'),
  ],

  // Indenter: create and track their own indents
  'Indenter': [
    ...keys('indent', 'approvals', 'messages', 'dashboards'),
    ...viewOnly('purchase', 'reports'),
    ...viewOnly('config.masters'),
  ],

  // Accounts: view POs, GRN for payment processing
  'Accounts': [
    ...viewOnly('indent', 'purchase', 'grn', 'stock', 'reports', 'dashboards'),
    ...keys('approvals', 'messages'),
    ...viewOnly('config.masters'),
  ],

  // Gate: receive goods (GRN), view stock
  'Gate': [
    ...keys('grn', 'messages', 'dashboards'),
    ...viewOnly('indent', 'stock'),
    ...viewOnly('config.masters'),
  ],

  // Lab: view indents and GRNs for quality checks
  'Lab': [
    ...viewOnly('indent', 'grn', 'stock', 'reports', 'dashboards'),
    ...keys('messages'),
    ...viewOnly('config.masters'),
  ],

  // Weigh: record weights (GRN), view stock
  'Weigh': [
    ...keys('grn', 'messages', 'dashboards'),
    ...viewOnly('indent', 'stock'),
    ...viewOnly('config.masters'),
  ],

  // Viewer: read-only access to everything
  'Viewer': [
    ...viewOnly('indent', 'purchase', 'grn', 'stock', 'approvals', 'reports', 'dashboards'),
    ...viewOnly('admin.locations', 'admin.usage'),
    ...viewOnly('config.masters'),
    ...keys('messages'),
  ],
};

// ─── Step 4: Insert permission grants ────────────────────────────────────────
console.log('\n═══ Step 3: Insert permission grants ═══');

for (const role of roles) {
  const permKeys = [...new Set(ROLE_PERMS[role.name] ?? ALL_KEYS)];
  console.log(`\n  ${role.name}: ${permKeys.length} keys`);

  await db.query('BEGIN');
  await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);

  // Delete existing grants for this role first (clean slate)
  const { rowCount: deleted } = await db.query(
    `DELETE FROM app.permission_grant WHERE tenant_id = $1 AND role_id = $2`,
    [TENANT_ID, role.id]
  );
  if (deleted > 0) console.log(`    Removed ${deleted} old grants`);

  // Insert new grants — batch insert
  if (permKeys.length > 0) {
    // Build VALUES clause: ($1,$2,$3,$4,$5), ($1,$2,$6,$4,$5), ...
    const values = [];
    const params = [TENANT_ID, role.id];
    let i = 3;
    for (const key of permKeys) {
      values.push(`(app.uuid_v7(), $1, $2, NULL, $${i}, 'allow')`);
      params.push(key);
      i++;
    }
    await db.query(
      `INSERT INTO app.permission_grant (id, tenant_id, role_id, user_id, perm_key, effect)
       VALUES ${values.join(', ')}
       ON CONFLICT DO NOTHING`,
      params
    );
  }

  await db.query('COMMIT');
  console.log(`    ✓ ${permKeys.length} grants inserted`);
}

// ─── Step 5: Give all roles scope = all locations ─────────────────────────────
console.log('\n═══ Step 4: Assign location scope (all nodes) to all roles ═══');

await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);

// Remove old scope grants
await db.query(`DELETE FROM app.scope_grant WHERE tenant_id = $1`, [TENANT_ID]);

for (const role of roles) {
  await db.query(
    `INSERT INTO app.scope_grant (id, tenant_id, role_id, user_id, tab_key, all_nodes, node_id, include_descendants)
     VALUES (app.uuid_v7(), $1, $2, NULL, NULL, true, NULL, true)`,
    [TENANT_ID, role.id]
  );
  console.log(`  ✓ ${role.name}: scope = all locations`);
}

await db.query('COMMIT');

// ─── Step 6: Verify ───────────────────────────────────────────────────────────
console.log('\n═══ Step 5: Verify ═══');
await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
const { rows: counts } = await db.query(
  `SELECT r.name, COUNT(pg.id) as grant_count
   FROM app.role r
   LEFT JOIN app.permission_grant pg ON pg.role_id = r.id AND pg.tenant_id = r.tenant_id
   WHERE r.tenant_id = $1 AND r.is_deleted = false
   GROUP BY r.name ORDER BY r.name`,
  [TENANT_ID]
);
await db.query('COMMIT');
counts.forEach(c => console.log(`  ${c.name}: ${c.grant_count} grants`));

await db.end();
console.log('\n✓ Done! Refresh https://procure-web-i1rq.onrender.com');
console.log('  The sidebar should now show all tabs appropriate to each role.');

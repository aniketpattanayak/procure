/**
 * seed-procurement-perms.mjs
 *
 * Seeds the missing procurement permission definitions into platform.permission_def,
 * then re-runs grant assignment for all roles.
 *
 * Run: node ~/Desktop/OMM_SYS/procure/seed-procurement-perms.mjs
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

// ─── Step 1: Seed missing procurement permission defs ─────────────────────────
console.log('\n═══ Step 1: Seed procurement permission keys into platform.permission_def ═══');

// These follow the exact same pattern as existing entries in the DB.
// key, kind, tab_key, label, group_label, requires_feature, requires_setting, sort_order
const procurementDefs = [
  // ── INDENT tab ──────────────────────────────────────────────────────────────
  ['indent',                          'tab',    'indent',           'Indents',                  'Procurement', 'indent',        null, 200],
  ['indent:action.view',              'action', 'indent',           'View indents',             null,          null,            null, 1],
  ['indent:action.create',            'action', 'indent',           'Create indent',            null,          null,            null, 2],
  ['indent:action.edit',              'action', 'indent',           'Edit indent',              null,          null,            null, 3],
  ['indent:action.delete',            'action', 'indent',           'Delete indent',            null,          null,            null, 4],
  ['indent:action.submit',            'action', 'indent',           'Submit indent for approval', null,        null,            null, 5],
  ['indent:action.approve',           'action', 'indent',           'Approve indent',           null,          null,            null, 6],
  ['indent:action.reject',            'action', 'indent',           'Reject indent',            null,          null,            null, 7],
  ['indent:action.close',             'action', 'indent',           'Close indent',             null,          null,            null, 8],
  ['indent:view.list',                'view',   'indent',           'Indent list view',         null,          null,            null, 10],
  ['indent:view.detail',              'view',   'indent',           'Indent detail view',       null,          null,            null, 11],

  // ── PURCHASE (Purchase Orders) tab ──────────────────────────────────────────
  ['purchase',                        'tab',    'purchase',         'Purchase Orders',          'Procurement', 'purchase',      null, 300],
  ['purchase:action.view',            'action', 'purchase',         'View purchase orders',     null,          null,            null, 1],
  ['purchase:action.create',          'action', 'purchase',         'Create purchase order',    null,          null,            null, 2],
  ['purchase:action.edit',            'action', 'purchase',         'Edit purchase order',      null,          null,            null, 3],
  ['purchase:action.delete',          'action', 'purchase',         'Delete purchase order',    null,          null,            null, 4],
  ['purchase:action.submit',          'action', 'purchase',         'Submit PO for approval',   null,          null,            null, 5],
  ['purchase:action.approve',         'action', 'purchase',         'Approve purchase order',   null,          null,            null, 6],
  ['purchase:action.reject',          'action', 'purchase',         'Reject purchase order',    null,          null,            null, 7],
  ['purchase:action.amend',           'action', 'purchase',         'Amend purchase order',     null,          null,            null, 8],
  ['purchase:action.close',           'action', 'purchase',         'Close purchase order',     null,          null,            null, 9],
  ['purchase:action.send_to_vendor',  'action', 'purchase',         'Send PO to vendor',        null,          null,            null, 10],
  ['purchase:view.list',              'view',   'purchase',         'PO list view',             null,          null,            null, 20],
  ['purchase:view.detail',            'view',   'purchase',         'PO detail view',           null,          null,            null, 21],

  // ── VENDOR QUOTES tab ────────────────────────────────────────────────────────
  ['vendor_quotes',                   'tab',    'vendor_quotes',    'Vendor Quotes',            'Procurement', 'vendor_quotes', null, 250],
  ['vendor_quotes:action.view',       'action', 'vendor_quotes',    'View vendor quotes',       null,          null,            null, 1],
  ['vendor_quotes:action.create',     'action', 'vendor_quotes',    'Add vendor quote',         null,          null,            null, 2],
  ['vendor_quotes:action.edit',       'action', 'vendor_quotes',    'Edit vendor quote',        null,          null,            null, 3],
  ['vendor_quotes:action.delete',     'action', 'vendor_quotes',    'Delete vendor quote',      null,          null,            null, 4],
  ['vendor_quotes:action.compare',    'action', 'vendor_quotes',    'Compare vendor quotes',    null,          null,            null, 5],
  ['vendor_quotes:view.list',         'view',   'vendor_quotes',    'Quote comparison view',    null,          null,            null, 10],

  // ── GRN (Goods Receipt Note) tab ────────────────────────────────────────────
  ['grn',                             'tab',    'grn',              'Goods Receipt',            'Store',       'grn',           null, 400],
  ['grn:action.view',                 'action', 'grn',              'View GRNs',                null,          null,            null, 1],
  ['grn:action.create',               'action', 'grn',              'Create GRN',               null,          null,            null, 2],
  ['grn:action.edit',                 'action', 'grn',              'Edit GRN',                 null,          null,            null, 3],
  ['grn:action.delete',               'action', 'grn',              'Delete GRN',               null,          null,            null, 4],
  ['grn:action.submit',               'action', 'grn',              'Submit GRN for approval',  null,          null,            null, 5],
  ['grn:action.approve',              'action', 'grn',              'Approve GRN',              null,          null,            null, 6],
  ['grn:action.reject',               'action', 'grn',              'Reject GRN',               null,          null,            null, 7],
  ['grn:action.close',                'action', 'grn',              'Close GRN',                null,          null,            null, 8],
  ['grn:view.list',                   'view',   'grn',              'GRN list view',            null,          null,            null, 10],
  ['grn:view.detail',                 'view',   'grn',              'GRN detail view',          null,          null,            null, 11],
];

// Insert only the ones that don't exist yet
let inserted = 0;
let skipped  = 0;
for (const [key, kind, tab_key, label, group_label, requires_feature, requires_setting, sort_order] of procurementDefs) {
  const { rows: existing } = await db.query(
    `SELECT 1 FROM platform.permission_def WHERE key = $1`, [key]
  );
  if (existing.length > 0) {
    skipped++;
    continue;
  }
  await db.query(
    `INSERT INTO platform.permission_def
       (key, kind, tab_key, label, group_label, requires_feature, requires_setting, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [key, kind, tab_key, label, group_label, requires_feature, requires_setting, sort_order]
  );
  inserted++;
}
console.log(`  Inserted ${inserted} new permission keys, skipped ${skipped} existing`);

// Verify
const { rows: allTabs } = await db.query(
  `SELECT key, requires_feature FROM platform.permission_def WHERE kind = 'tab' ORDER BY sort_order`
);
console.log('\n  All tabs now in platform.permission_def:');
allTabs.forEach(t => console.log(`    ${t.key} [${t.requires_feature ?? 'always'}]`));

// ─── Step 2: Re-run grant assignment for all roles ────────────────────────────
console.log('\n═══ Step 2: Re-assign grants to all roles with new keys ═══');

// Load ALL permission keys (now includes the new ones)
const { rows: permDefs } = await db.query(
  `SELECT key FROM platform.permission_def ORDER BY sort_order, key`
);
const ALL_KEYS = permDefs.map(p => p.key);
console.log(`  Total permission keys: ${ALL_KEYS.length}`);

// Load roles
await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
const { rows: roles } = await db.query(
  `SELECT id, name FROM app.role WHERE tenant_id = $1 AND is_deleted = false ORDER BY name`,
  [TENANT_ID]
);
await db.query('COMMIT');
console.log('  Roles:', roles.map(r => r.name).join(', '));

function keys(...prefixes) {
  return ALL_KEYS.filter(k => prefixes.some(p => k === p || k.startsWith(p + ':')));
}
function viewOnly(...prefixes) {
  return ALL_KEYS.filter(k => prefixes.some(p =>
    k === p || k === `${p}:action.view` || k.startsWith(`${p}:view.`)
  ));
}

const ROLE_PERMS = {
  'Manager':  ALL_KEYS,

  'Purchase': [
    ...keys('indent', 'purchase', 'vendor_quotes', 'grn', 'approvals', 'reports', 'dashboards', 'messages'),
    ...viewOnly('stock'),
    ...viewOnly('admin.locations', 'admin.settings', 'admin.usage'),
    ...viewOnly('config.masters', 'config.doc_types', 'config.numbering', 'config.templates'),
  ],

  'Store': [
    ...keys('grn', 'stock', 'approvals', 'reports', 'dashboards', 'messages'),
    ...viewOnly('indent', 'purchase', 'vendor_quotes'),
    ...viewOnly('admin.locations'),
    ...viewOnly('config.masters', 'config.doc_types', 'config.numbering'),
  ],

  'Indenter': [
    ...keys('indent', 'approvals', 'messages', 'dashboards'),
    ...viewOnly('purchase', 'vendor_quotes', 'reports'),
    ...viewOnly('config.masters'),
  ],

  'Accounts': [
    ...viewOnly('indent', 'purchase', 'vendor_quotes', 'grn', 'stock', 'reports', 'dashboards'),
    ...keys('approvals', 'messages'),
    ...viewOnly('config.masters'),
  ],

  'Gate': [
    ...keys('grn', 'messages', 'dashboards'),
    ...viewOnly('indent', 'stock'),
    ...viewOnly('config.masters'),
  ],

  'Lab': [
    ...viewOnly('indent', 'grn', 'stock', 'reports', 'dashboards'),
    ...keys('messages'),
    ...viewOnly('config.masters'),
  ],

  'Weigh': [
    ...keys('grn', 'messages', 'dashboards'),
    ...viewOnly('indent', 'stock'),
    ...viewOnly('config.masters'),
  ],

  'Viewer': [
    ...viewOnly('indent', 'purchase', 'vendor_quotes', 'grn', 'stock', 'approvals', 'reports', 'dashboards'),
    ...viewOnly('admin.locations', 'admin.usage'),
    ...viewOnly('config.masters'),
    ...keys('messages'),
  ],
};

for (const role of roles) {
  const permKeys = [...new Set(ROLE_PERMS[role.name] ?? ALL_KEYS)];
  process.stdout.write(`  ${role.name}: ${permKeys.length} keys ... `);

  await db.query('BEGIN');
  await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);

  // Delete existing
  await db.query(
    `DELETE FROM app.permission_grant WHERE tenant_id = $1 AND role_id = $2`,
    [TENANT_ID, role.id]
  );

  // Batch insert
  if (permKeys.length > 0) {
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
       VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
      params
    );
  }

  await db.query('COMMIT');
  console.log('✓');
}

// ─── Step 3: Scope grants (all nodes) for all roles ──────────────────────────
console.log('\n═══ Step 3: Refresh scope grants ═══');
await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
await db.query(`DELETE FROM app.scope_grant WHERE tenant_id = $1`, [TENANT_ID]);
for (const role of roles) {
  await db.query(
    `INSERT INTO app.scope_grant (id, tenant_id, role_id, user_id, tab_key, all_nodes, node_id, include_descendants)
     VALUES (app.uuid_v7(), $1, $2, NULL, NULL, true, NULL, true)`,
    [TENANT_ID, role.id]
  );
}
await db.query('COMMIT');
console.log(`  ✓ Scope grants refreshed for ${roles.length} roles`);

// ─── Step 4: Verify final counts ─────────────────────────────────────────────
console.log('\n═══ Step 4: Final verification ═══');
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

// Also verify admin user still has Manager role
await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
const { rows: userRoles } = await db.query(
  `SELECT u.email, r.name as role_name
   FROM app.user_role ur
   JOIN app.tenant_user u ON u.id = ur.user_id
   JOIN app.role r ON r.id = ur.role_id
   WHERE ur.tenant_id = $1`,
  [TENANT_ID]
);
await db.query('COMMIT');
console.log('\n  User → Role assignments:');
userRoles.forEach(u => console.log(`  ${u.email} → ${u.role_name}`));

await db.end();
console.log('\n✓ All done! Now:');
console.log('  1. Refresh https://procure-web-i1rq.onrender.com');
console.log('  2. Log in as admin@jeevaka.local / Jeevaka@2026');
console.log('  3. You should see Indent, Purchase Orders, Goods Receipt, Stock in the sidebar');

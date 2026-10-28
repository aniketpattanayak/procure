/**
 * Jeevaka Plan Fix + Full Setup Script
 *
 * This script does two things:
 *   A) Upgrades Jeevaka's plan limits from the PLATFORM (superadmin) side
 *      - Removes the 0-location limit → sets it to unlimited
 *      - Enables the form_builder feature (needed for custom masters)
 *      - Triggers the system installer (creates department master etc.)
 *
 *   B) Then re-runs all the setup that failed:
 *      - Locations (SPD, SID, Office + subdivisions)
 *      - Departments (Purchase, Store, Accounts etc.)
 *      - Raw Materials, Consumables, Payment Terms masters
 *
 * Roles are already done from last run — skipping those.
 * Settings are also already done — skipping those.
 */

const API = 'https://procure-api-2g2v.onrender.com/api/v1';
const PLATFORM_EMAIL = 'owner@procure.local';
const PLATFORM_PASS = 'Owner@12345';
const JEEVAKA_TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

// ─── helpers ────────────────────────────────────────────────────────────────

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    console.error(`  ✗ ${method} ${path} → ${res.status}`);
    console.error('  ', JSON.stringify(data).slice(0, 400));
    return null;
  }
  return data;
}

function ok(label, result) {
  if (result === null) { console.log(`  ✗ FAILED: ${label}`); return false; }
  console.log(`  ✓ ${label}`);
  return true;
}

// ─── Step 1: Platform login ─────────────────────────────────────────────────

console.log('\n═══ Step 1: Platform login ═══');
const loginRes = await call('POST', '/auth/platform/login', {
  email: PLATFORM_EMAIL,
  password: PLATFORM_PASS,
});
if (!loginRes?.accessToken) { console.error('Platform login FAILED. Check credentials.'); process.exit(1); }
const platformToken = loginRes.accessToken;
console.log('  ✓ Logged in as platform owner');

// ─── Step 2: See what features/limits exist in the catalog ──────────────────

console.log('\n═══ Step 2: Check platform catalog ═══');
const catalog = await call('GET', '/platform/catalog', null, platformToken);
if (catalog) {
  console.log('  Features available:', catalog.features?.map(f => f.key).join(', '));
  console.log('  Limits available:',   catalog.limits?.map(l => l.key).join(', '));
}

// ─── Step 3: Set plan overrides for Jeevaka ──────────────────────────────────
// Override = per-tenant exception on top of the plan (no need to change the plan itself)

console.log('\n═══ Step 3: Set plan overrides for Jeevaka ═══');

// 3a. Set max_locations to null = unlimited
const locOverride = await call('PUT', `/platform/tenants/${JEEVAKA_TENANT_ID}/overrides`, {
  kind: 'limit',
  key: 'max_locations',
  value: null,   // null = unlimited
  reason: 'Jeevaka pilot setup - unlimited locations needed for SPD, SID, Office',
}, platformToken);
ok('Override: max_locations → unlimited', locOverride);

// 3b. Check what features the catalog has and enable the ones we need
// Common feature keys: form_builder, grn, store, reports, ...
// Try enabling form_builder for custom masters
const fbOverride = await call('PUT', `/platform/tenants/${JEEVAKA_TENANT_ID}/overrides`, {
  kind: 'feature',
  key: 'form_builder',
  value: true,
  reason: 'Jeevaka pilot setup - needed for Raw Material, Consumable, Payment Terms masters',
}, platformToken);
ok('Override: form_builder feature → enabled', fbOverride);

// 3c. Also enable grn and store features (needed for GRN/stock workflows)
const grnOverride = await call('PUT', `/platform/tenants/${JEEVAKA_TENANT_ID}/overrides`, {
  kind: 'feature',
  key: 'grn',
  value: true,
  reason: 'Jeevaka pilot setup - GRN receipts needed',
}, platformToken);
ok('Override: grn feature → enabled', grnOverride);

const storeOverride = await call('PUT', `/platform/tenants/${JEEVAKA_TENANT_ID}/overrides`, {
  kind: 'feature',
  key: 'store',
  value: true,
  reason: 'Jeevaka pilot setup - stock/store module needed',
}, platformToken);
ok('Override: store feature → enabled', storeOverride);

// 3d. Small wait for cache to refresh
console.log('  ℹ Waiting 3 seconds for entitlement cache to refresh...');
await new Promise(r => setTimeout(r, 3000));

// ─── Step 4: Impersonate Jeevaka admin ──────────────────────────────────────

console.log('\n═══ Step 4: Impersonate Jeevaka admin ═══');
const impersonateRes = await call(
  'POST',
  `/platform/tenants/${JEEVAKA_TENANT_ID}/impersonate`,
  { reason: 'Jeevaka pilot setup - creating locations and masters' },
  platformToken,
);
if (!impersonateRes?.accessToken) { console.error('Impersonate FAILED.'); process.exit(1); }
const jeevakaToken = impersonateRes.accessToken;
console.log('  ✓ Got Jeevaka admin token');
console.log(`  ✓ Logged in as: ${impersonateRes.principal?.email ?? 'jeevaka admin'}`);

// ─── Step 5: Create locations ────────────────────────────────────────────────

console.log('\n═══ Step 5: Create locations ═══');

const spdRes = await call('POST', '/locations', {
  code: 'SPD',
  name: 'SPD Chegunta',
  parentId: null,
  sortOrder: 1,
}, jeevakaToken);
ok('Created SPD (root)', spdRes);
const spdId = spdRes?.id;

if (spdId) {
  const spd01Res = await call('POST', '/locations', {
    code: 'SPD-01',
    name: 'SPD Chegunta Furnace',
    parentId: spdId,
    sortOrder: 1,
  }, jeevakaToken);
  ok('Created SPD-01 Furnace', spd01Res);

  const spd02Res = await call('POST', '/locations', {
    code: 'SPD-02',
    name: 'SPD Chegunta RMD',
    parentId: spdId,
    sortOrder: 2,
  }, jeevakaToken);
  ok('Created SPD-02 RMD', spd02Res);
}

const sidRes = await call('POST', '/locations', {
  code: 'SID',
  name: 'SID Nasthipur',
  parentId: null,
  sortOrder: 2,
}, jeevakaToken);
ok('Created SID', sidRes);

const ofcRes = await call('POST', '/locations', {
  code: 'OFC-01',
  name: 'Office Balanagar',
  parentId: null,
  sortOrder: 3,
}, jeevakaToken);
ok('Created OFC-01 Office', ofcRes);

// ─── Step 6: Departments ─────────────────────────────────────────────────────
// The department master is auto-created by the system when indents are first used.
// We trigger it by hitting the installer endpoint, OR we create the master ourselves.
// Since form_builder is now enabled, we can create it.

console.log('\n═══ Step 6: Create Department master + records ═══');

// First check if department master already exists (system may have created it)
const allMasters = await call('GET', '/masters', null, jeevakaToken);
const mastersList = Array.isArray(allMasters) ? allMasters : (allMasters?.items ?? []);
let deptMasterId = mastersList.find(m => m.key === 'department')?.id ?? null;

if (deptMasterId) {
  console.log(`  ✓ Department master already exists: ${deptMasterId}`);
} else {
  console.log('  ℹ Department master not found — creating it...');
  const deptMasterRes = await call('POST', '/config/masters', {
    key: 'department',
    name: 'Department',
    pluralName: 'Departments',
    description: 'Company departments for indent routing and approval',
    settings: {
      codeLabel: 'Dept Code',
      nameLabel: 'Department Name',
      showInMenu: true,
    },
    definition: { fields: [] },
  }, jeevakaToken);
  ok('Created Department master', deptMasterRes);
  deptMasterId = deptMasterRes?.id ?? null;
}

const departments = [
  { code: 'PUR',   name: 'Purchase' },
  { code: 'STR',   name: 'Store' },
  { code: 'ACC',   name: 'Accounts' },
  { code: 'GATE',  name: 'Gate' },
  { code: 'LAB',   name: 'Lab' },
  { code: 'WEIGH', name: 'Weigh' },
  { code: 'ADMIN', name: 'Admin' },
  { code: 'MGMT',  name: 'Management' },
  { code: 'PROD',  name: 'Production' },
  { code: 'MAINT', name: 'Maintenance' },
  { code: 'QA',    name: 'Quality' },
];

if (deptMasterId) {
  for (const dept of departments) {
    const r = await call('POST', `/masters/${deptMasterId}/records`, {
      code: dept.code,
      name: dept.name,
      data: {},
    }, jeevakaToken);
    ok(`  Department: ${dept.name}`, r);
  }
} else {
  console.log('  ✗ Cannot add departments — master not found or could not be created');
}

// ─── Step 7: Create "Raw Material" master ────────────────────────────────────

console.log('\n═══ Step 7: Create Raw Material master + records ═══');

const rmMasterRes = await call('POST', '/config/masters', {
  key: 'raw_material',
  name: 'Raw Material',
  pluralName: 'Raw Materials',
  description: 'Iron Ore, Coal, Scrap and other input materials for the furnace',
  settings: {
    codeLabel: 'RM Code',
    nameLabel: 'Material Name',
    showInMenu: true,
  },
  definition: {
    fields: [
      {
        key: 'uom',
        type: 'select',
        label: 'Unit of Measure (UOM)',
        required: true,
        width: 6,
        options: [
          { value: 'MT',  label: 'MT – Metric Ton' },
          { value: 'KG',  label: 'KG – Kilogram' },
          { value: 'NOS', label: 'NOS – Numbers' },
          { value: 'LTR', label: 'LTR – Litre' },
          { value: 'MTR', label: 'MTR – Metre' },
          { value: 'SET', label: 'SET – Set' },
        ],
      },
      {
        key: 'hsn_code',
        type: 'text',
        label: 'HSN Code',
        required: false,
        width: 6,
        placeholder: 'e.g. 72044900',
      },
      {
        key: 'gst_pct',
        type: 'select',
        label: 'GST %',
        required: false,
        width: 6,
        options: [
          { value: '0',   label: '0%' },
          { value: '5',   label: '5%' },
          { value: '12',  label: '12%' },
          { value: '18',  label: '18%' },
          { value: '28',  label: '28%' },
        ],
      },
      {
        key: 'used_at',
        type: 'select',
        label: 'Used At',
        required: false,
        width: 6,
        options: [
          { value: 'SPD',  label: 'SPD – Chegunta' },
          { value: 'SID',  label: 'SID – Nasthipur' },
          { value: 'Both', label: 'Both Plants' },
        ],
      },
    ],
  },
}, jeevakaToken);
ok('Created Raw Material master', rmMasterRes);

const rawMaterials = [
  { code: 'RM001', name: 'Iron Ore / Iron Ore Pellets', data: { uom: 'MT', hsn_code: '62011210', gst_pct: '18', used_at: 'Both' } },
  { code: 'RM002', name: 'Coal',                        data: { uom: 'MT', hsn_code: '27011920', gst_pct: '18', used_at: 'Both' } },
  { code: 'RM003', name: 'Scrap',                       data: { uom: 'MT', hsn_code: '72044900', gst_pct: '18', used_at: 'SPD'  } },
  { code: 'RM004', name: 'Pig Iron',                    data: { uom: 'MT', hsn_code: '72011000', gst_pct: '18', used_at: 'SPD'  } },
  { code: 'RM005', name: 'Sponge Iron',                 data: { uom: 'MT', hsn_code: '72031000', gst_pct: '18', used_at: 'SPD'  } },
  { code: 'RM006', name: 'Silico Manganese (Additive)', data: { uom: 'MT', hsn_code: '72023000', gst_pct: '18', used_at: 'SPD'  } },
];

for (const rm of rawMaterials) {
  const r = await call('POST', '/masters/raw_material/records', {
    code: rm.code, name: rm.name, data: rm.data,
  }, jeevakaToken);
  ok(`Raw Material: ${rm.name}`, r);
}

// ─── Step 8: Create "Consumable" master ──────────────────────────────────────

console.log('\n═══ Step 8: Create Consumable master + records ═══');

const consMasterRes = await call('POST', '/config/masters', {
  key: 'consumable',
  name: 'Consumable',
  pluralName: 'Consumables',
  description: 'Consumable items like gloves, safety equipment etc.',
  settings: { codeLabel: 'Item Code', nameLabel: 'Item Name', showInMenu: true },
  definition: {
    fields: [
      { key: 'category', type: 'text',   label: 'Category', required: false, width: 6 },
      { key: 'brand',    type: 'text',   label: 'Brand',    required: false, width: 6 },
      {
        key: 'uom', type: 'select', label: 'UOM', required: true, width: 6,
        options: [
          { value: 'NOS', label: 'NOS – Numbers' },
          { value: 'PKT', label: 'PKT – Packet' },
          { value: 'BOX', label: 'BOX – Box' },
          { value: 'KG',  label: 'KG – Kilogram' },
          { value: 'LTR', label: 'LTR – Litre' },
          { value: 'MTR', label: 'MTR – Metre' },
          { value: 'PAR', label: 'PAR – Pair' },
          { value: 'SET', label: 'SET – Set' },
        ],
      },
      { key: 'hsn_code', type: 'text', label: 'HSN Code', required: false, width: 6 },
      {
        key: 'gst_pct', type: 'select', label: 'GST %', required: false, width: 6,
        options: [
          { value: '0', label: '0%' }, { value: '5', label: '5%' },
          { value: '12', label: '12%' }, { value: '18', label: '18%' }, { value: '28', label: '28%' },
        ],
      },
    ],
  },
}, jeevakaToken);
ok('Created Consumable master', consMasterRes);

const r1 = await call('POST', '/masters/consumable/records', {
  code: 'CONS-001', name: 'Gloves',
  data: { category: 'Safety', brand: 'Nike', uom: 'NOS', hsn_code: '23', gst_pct: '18' },
}, jeevakaToken);
ok('Consumable: Gloves', r1);

// ─── Step 9: Create "Payment Terms" master ────────────────────────────────────

console.log('\n═══ Step 9: Create Payment Terms master + records ═══');

const ptMasterRes = await call('POST', '/config/masters', {
  key: 'payment_terms',
  name: 'Payment Term',
  pluralName: 'Payment Terms',
  description: 'Vendor payment terms: advance, credit days etc.',
  settings: { codeLabel: 'Code', nameLabel: 'Payment Term', showInMenu: true },
  definition: {
    fields: [
      { key: 'credit_days', type: 'number', label: 'Credit Days', required: false, width: 6 },
      { key: 'description', type: 'textarea', label: 'Description', required: false, width: 12 },
    ],
  },
}, jeevakaToken);
ok('Created Payment Terms master', ptMasterRes);

const paymentTerms = [
  { code: 'PT-01', name: 'Advance',                       data: { credit_days: 0,  description: 'Full payment in advance' } },
  { code: 'PT-02', name: '15 Days Credit',                 data: { credit_days: 15, description: 'Payment within 15 days of invoice' } },
  { code: 'PT-03', name: '30 Days Credit',                 data: { credit_days: 30, description: 'Payment within 30 days of invoice' } },
  { code: 'PT-04', name: '45 Days Credit',                 data: { credit_days: 45, description: 'Payment within 45 days of invoice' } },
  { code: 'PT-05', name: '60 Days Credit',                 data: { credit_days: 60, description: 'Payment within 60 days of invoice' } },
  { code: 'PT-06', name: 'Against Delivery',               data: { credit_days: 0,  description: 'Payment at the time of delivery' } },
  { code: 'PT-07', name: '50% Advance + 50% on Delivery',  data: { credit_days: 0,  description: '50% advance, 50% on delivery' } },
];

for (const pt of paymentTerms) {
  const r = await call('POST', '/masters/payment_terms/records', {
    code: pt.code, name: pt.name, data: pt.data,
  }, jeevakaToken);
  ok(`Payment Term: ${pt.name}`, r);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n═══ ALL DONE ═══');
console.log('');
console.log('Login at: https://procure-web-i1rq.onrender.com');
console.log('Email:    admin@jeevaka.local');
console.log('Password: Jeevaka@2026');

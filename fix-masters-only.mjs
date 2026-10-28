/**
 * fix-masters-only.mjs
 *
 * After fix-locations-db.mjs has run and locations are created,
 * this script:
 *   1. Logs in as platform owner
 *   2. Sets override: custom_forms → unlimited (was 0, blocking all master creation)
 *   3. Impersonates Jeevaka admin
 *   4. Creates Department master (with 1 dummy field so validation passes) + 11 dept records
 *   5. Creates Raw Material master + 6 records
 *   6. Creates Consumable master + 1 record
 *   7. Creates Payment Terms master + 7 records
 *
 * Run: node ~/Desktop/OMM_SYS/procure/fix-masters-only.mjs
 */

const API = 'https://procure-api-2g2v.onrender.com/api/v1';
const PLATFORM_EMAIL = 'owner@procure.local';
const PLATFORM_PASS  = 'Owner@12345';
const JEEVAKA_TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

// ─── helpers ─────────────────────────────────────────────────────────────────

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
    console.error('  ', JSON.stringify(data).slice(0, 500));
    return null;
  }
  return data;
}

function ok(label, result) {
  if (result === null) { console.log(`  ✗ FAILED: ${label}`); return false; }
  console.log(`  ✓ ${label}`);
  return true;
}

// ─── Step 1: Platform login ───────────────────────────────────────────────────

console.log('\n═══ Step 1: Platform login ═══');
const loginRes = await call('POST', '/auth/platform/login', {
  email: PLATFORM_EMAIL,
  password: PLATFORM_PASS,
});
if (!loginRes?.accessToken) { console.error('Platform login FAILED.'); process.exit(1); }
const platformToken = loginRes.accessToken;
console.log('  ✓ Logged in as platform owner');

// ─── Step 2: Override custom_forms limit → unlimited ─────────────────────────
// This was the missing piece — form_builder was enabled but the LIMIT custom_forms was still 0.
// Need both: feature enabled AND limit raised.

console.log('\n═══ Step 2: Set custom_forms limit → unlimited ═══');
const cfOverride = await call('PUT', `/platform/tenants/${JEEVAKA_TENANT_ID}/overrides`, {
  kind: 'limit',
  key: 'custom_forms',
  value: null,   // null = unlimited
  reason: 'Jeevaka pilot setup - need custom masters for Raw Material, Consumable, Payment Terms, Department',
}, platformToken);
ok('Override: custom_forms → unlimited', cfOverride);

// Small wait for cache
console.log('  ℹ Waiting 3 seconds for cache...');
await new Promise(r => setTimeout(r, 3000));

// ─── Step 3: Impersonate Jeevaka ─────────────────────────────────────────────

console.log('\n═══ Step 3: Impersonate Jeevaka admin ═══');
const impRes = await call('POST', `/platform/tenants/${JEEVAKA_TENANT_ID}/impersonate`, {
  reason: 'Jeevaka pilot setup - creating masters',
}, platformToken);
if (!impRes?.accessToken) { console.error('Impersonate FAILED.'); process.exit(1); }
const jeevakaToken = impRes.accessToken;
console.log(`  ✓ Impersonating: ${impRes.principal?.email ?? 'admin@jeevaka.local'}`);

// ─── Step 4: Department master ────────────────────────────────────────────────
// NOTE: The validation requires at least 1 field in definition.fields.
// We add a simple "notes" text field so the validation passes.

console.log('\n═══ Step 4: Department master + 11 departments ═══');

// First check if it already exists
const allMasters = await call('GET', '/masters', null, jeevakaToken);
const masterList = Array.isArray(allMasters) ? allMasters : (allMasters?.items ?? []);
const existingDept = masterList.find(m => m.key === 'department');

let deptKey = 'department';
if (existingDept) {
  console.log('  ✓ Department master already exists');
} else {
  const deptMasterRes = await call('POST', '/config/masters', {
    key: 'department',
    name: 'Department',
    pluralName: 'Departments',
    description: 'Company departments for routing and approval',
    settings: {
      codeLabel: 'Dept Code',
      nameLabel: 'Department Name',
      showInMenu: true,
    },
    definition: {
      fields: [
        // At least 1 field is required by API validation
        {
          key: 'head',
          type: 'text',
          label: 'Department Head',
          required: false,
          width: 6,
          placeholder: 'Name of the HOD',
        },
      ],
    },
  }, jeevakaToken);
  ok('Created Department master', deptMasterRes);
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

for (const dept of departments) {
  const r = await call('POST', `/masters/${deptKey}/records`, {
    code: dept.code,
    name: dept.name,
    data: { head: '' },
  }, jeevakaToken);
  ok(`Department: ${dept.name}`, r);
}

// ─── Step 5: Raw Material master ─────────────────────────────────────────────

console.log('\n═══ Step 5: Raw Material master + 6 records ═══');

const rmRes = await call('POST', '/config/masters', {
  key: 'raw_material',
  name: 'Raw Material',
  pluralName: 'Raw Materials',
  description: 'Iron ore, coal, scrap and other furnace input materials',
  settings: { codeLabel: 'RM Code', nameLabel: 'Material Name', showInMenu: true },
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
      { key: 'hsn_code', type: 'text', label: 'HSN Code', required: false, width: 6, placeholder: 'e.g. 72044900' },
      {
        key: 'gst_pct',
        type: 'select',
        label: 'GST %',
        required: false,
        width: 6,
        options: [
          { value: '0', label: '0%' }, { value: '5', label: '5%' },
          { value: '12', label: '12%' }, { value: '18', label: '18%' }, { value: '28', label: '28%' },
        ],
      },
      {
        key: 'used_at',
        type: 'select',
        label: 'Used At',
        required: false,
        width: 6,
        options: [
          { value: 'SPD', label: 'SPD – Chegunta' },
          { value: 'SID', label: 'SID – Nasthipur' },
          { value: 'Both', label: 'Both Plants' },
        ],
      },
    ],
  },
}, jeevakaToken);
ok('Created Raw Material master', rmRes);

const rawMaterials = [
  { code: 'RM001', name: 'Iron Ore / Iron Ore Pellets', data: { uom: 'MT', hsn_code: '62011210', gst_pct: '18', used_at: 'Both' } },
  { code: 'RM002', name: 'Coal',                        data: { uom: 'MT', hsn_code: '27011920', gst_pct: '18', used_at: 'Both' } },
  { code: 'RM003', name: 'Scrap',                       data: { uom: 'MT', hsn_code: '72044900', gst_pct: '18', used_at: 'SPD'  } },
  { code: 'RM004', name: 'Pig Iron',                    data: { uom: 'MT', hsn_code: '72011000', gst_pct: '18', used_at: 'SPD'  } },
  { code: 'RM005', name: 'Sponge Iron',                 data: { uom: 'MT', hsn_code: '72031000', gst_pct: '18', used_at: 'SPD'  } },
  { code: 'RM006', name: 'Silico Manganese (Additive)', data: { uom: 'MT', hsn_code: '72023000', gst_pct: '18', used_at: 'SPD'  } },
];
for (const rm of rawMaterials) {
  const r = await call('POST', '/masters/raw_material/records', { code: rm.code, name: rm.name, data: rm.data }, jeevakaToken);
  ok(`  Raw Material: ${rm.name}`, r);
}

// ─── Step 6: Consumable master ───────────────────────────────────────────────

console.log('\n═══ Step 6: Consumable master + 1 record ═══');

const consRes = await call('POST', '/config/masters', {
  key: 'consumable',
  name: 'Consumable',
  pluralName: 'Consumables',
  description: 'Consumable items like gloves, safety equipment etc.',
  settings: { codeLabel: 'Item Code', nameLabel: 'Item Name', showInMenu: true },
  definition: {
    fields: [
      { key: 'category', type: 'text', label: 'Category', required: false, width: 6 },
      { key: 'brand',    type: 'text', label: 'Brand',    required: false, width: 6 },
      {
        key: 'uom', type: 'select', label: 'UOM', required: true, width: 6,
        options: [
          { value: 'NOS', label: 'NOS – Numbers' }, { value: 'PKT', label: 'PKT – Packet' },
          { value: 'BOX', label: 'BOX – Box' }, { value: 'KG',  label: 'KG – Kilogram' },
          { value: 'LTR', label: 'LTR – Litre' }, { value: 'MTR', label: 'MTR – Metre' },
          { value: 'PAR', label: 'PAR – Pair' }, { value: 'SET', label: 'SET – Set' },
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
ok('Created Consumable master', consRes);

const r1 = await call('POST', '/masters/consumable/records', {
  code: 'CONS-001', name: 'Gloves',
  data: { category: 'Safety', brand: 'Nike', uom: 'NOS', hsn_code: '23', gst_pct: '18' },
}, jeevakaToken);
ok('Consumable: Gloves', r1);

// ─── Step 7: Payment Terms master ─────────────────────────────────────────────

console.log('\n═══ Step 7: Payment Terms master + 7 records ═══');

const ptRes = await call('POST', '/config/masters', {
  key: 'payment_terms',
  name: 'Payment Term',
  pluralName: 'Payment Terms',
  description: 'Vendor payment terms: advance, credit days etc.',
  settings: { codeLabel: 'Code', nameLabel: 'Payment Term', showInMenu: true },
  definition: {
    fields: [
      { key: 'credit_days', type: 'number',   label: 'Credit Days', required: false, width: 6 },
      { key: 'description', type: 'textarea', label: 'Description', required: false, width: 12 },
    ],
  },
}, jeevakaToken);
ok('Created Payment Terms master', ptRes);

const paymentTerms = [
  { code: 'PT-01', name: 'Advance',                      data: { credit_days: 0,  description: 'Full payment in advance' } },
  { code: 'PT-02', name: '15 Days Credit',                data: { credit_days: 15, description: 'Payment within 15 days of invoice' } },
  { code: 'PT-03', name: '30 Days Credit',                data: { credit_days: 30, description: 'Payment within 30 days of invoice' } },
  { code: 'PT-04', name: '45 Days Credit',                data: { credit_days: 45, description: 'Payment within 45 days of invoice' } },
  { code: 'PT-05', name: '60 Days Credit',                data: { credit_days: 60, description: 'Payment within 60 days of invoice' } },
  { code: 'PT-06', name: 'Against Delivery',              data: { credit_days: 0,  description: 'Payment at the time of delivery' } },
  { code: 'PT-07', name: '50% Advance + 50% on Delivery', data: { credit_days: 0,  description: '50% advance, 50% on delivery' } },
];
for (const pt of paymentTerms) {
  const r = await call('POST', '/masters/payment_terms/records', { code: pt.code, name: pt.name, data: pt.data }, jeevakaToken);
  ok(`Payment Term: ${pt.name}`, r);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n═══ ALL DONE ═══');
console.log('Login at: https://procure-web-i1rq.onrender.com');
console.log('Email:    admin@jeevaka.local');
console.log('Password: Jeevaka@2026');

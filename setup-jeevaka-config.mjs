/**
 * Jeevaka Configuration Script
 * Sets up all CONFIGURATIONS for Jeevaka tenant via the platform API.
 *
 * What this does (step by step):
 * 1. Logs in as platform superadmin (owner@procure.local)
 * 2. Impersonates Jeevaka's admin (get a Jeevaka admin token)
 * 3. Configures settings (numbering, workflows, stock etc.)
 * 4. Creates locations (SPD, SID, Office + subdivisions)
 * 5. Creates departments
 * 6. Creates roles (Purchaser, Store, Accounts, Gate, Manager, etc.)
 * 7. Creates "Raw Material" master + adds 6 raw materials
 * 8. Creates "Consumable" master + adds 1 consumable
 * 9. Creates "Payment Terms" master + adds 7 payment terms
 *
 * YOU WILL ADD vendors and other data later via the UI.
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
    console.error('  ', JSON.stringify(data).slice(0, 300));
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

// ─── Step 2: Impersonate Jeevaka admin ──────────────────────────────────────

console.log('\n═══ Step 2: Impersonate Jeevaka admin ═══');
const impersonateRes = await call(
  'POST',
  `/platform/tenants/${JEEVAKA_TENANT_ID}/impersonate`,
  { reason: 'Setting up Jeevaka initial configuration via admin script' },
  platformToken,
);
if (!impersonateRes?.accessToken) { console.error('Impersonate FAILED.'); process.exit(1); }
const jeevakaToken = impersonateRes.accessToken;
console.log('  ✓ Got Jeevaka admin token (impersonation)');
console.log(`  ✓ Logged in as: ${impersonateRes.principal?.email ?? 'jeevaka admin'}`);

// ─── Step 3: Configure settings ─────────────────────────────────────────────

console.log('\n═══ Step 3: Configure tenant settings ═══');
const settingsRes = await call('PUT', '/config/settings', {
  // Location level names (3 levels: Location > Sub-location > Division)
  'labels.location_levels': ['Location', 'Sub-location', 'Division'],

  // Procurement workflow settings
  'flow.indent.enabled': true,
  'flow.vendor_selection.enabled': true,
  'flow.po.direct_allowed': false,       // PO always needs indent
  'flow.issue.without_indent': true,     // Stock issue can be without requisition

  // Stock settings
  'stock.valuation': 'wac',             // Weighted average cost
  'stock.allow_negative': false,        // Don't allow negative stock
  'stock.cost_includes_tax': false,     // Stock cost excludes GST

  // GRN settings
  'grn.over_receipt_pct': 5,            // Allow up to 5% over-receipt
  'grn.multi_po': false,

  // Quote / selection settings
  'selection.max_over_approval_pct': 0, // Don't allow selecting more than approved qty
  'procurement.quote_validity_days': 30,

  // Workflow self-approval block (best practice)
  'workflow.block_self_approval': true,

  // Security settings
  'security.password_min_length': 10,
  'security.max_failed_logins': 5,
  'security.lockout_minutes': 15,
  'security.session_days': 30,
}, jeevakaToken);
ok('Settings configured', settingsRes);

// ─── Step 4: Create locations ────────────────────────────────────────────────
// Structure:
//   SPD (SPD Chegunta)
//   ├── SPD-01 Furnace
//   └── SPD-02 RMD
//   SID (SID Nasthipur)
//   OFC-01 (Office Balanagar)

console.log('\n═══ Step 4: Create locations ═══');

// SPD – root location
const spdRes = await call('POST', '/locations', {
  code: 'SPD',
  name: 'SPD Chegunta',
  parentId: null,
  sortOrder: 1,
}, jeevakaToken);
ok('Created SPD (root)', spdRes);
const spdId = spdRes?.id;

// SPD-01 Furnace – child of SPD
if (spdId) {
  const spd01Res = await call('POST', '/locations', {
    code: 'SPD-01',
    name: 'SPD Chegunta Furnace',
    parentId: spdId,
    sortOrder: 1,
  }, jeevakaToken);
  ok('Created SPD-01 Furnace', spd01Res);
}

// SPD-02 RMD – child of SPD
if (spdId) {
  const spd02Res = await call('POST', '/locations', {
    code: 'SPD-02',
    name: 'SPD Chegunta RMD',
    parentId: spdId,
    sortOrder: 2,
  }, jeevakaToken);
  ok('Created SPD-02 RMD', spd02Res);
}

// SID – root location
const sidRes = await call('POST', '/locations', {
  code: 'SID',
  name: 'SID Nasthipur',
  parentId: null,
  sortOrder: 2,
}, jeevakaToken);
ok('Created SID (root)', sidRes);

// OFC-01 – Office Balanagar
const ofcRes = await call('POST', '/locations', {
  code: 'OFC-01',
  name: 'Office Balanagar',
  parentId: null,
  sortOrder: 3,
}, jeevakaToken);
ok('Created OFC-01 Office', ofcRes);

// ─── Step 5: Create departments ──────────────────────────────────────────────

console.log('\n═══ Step 5: Create departments ═══');

const mastersRes = await call('GET', '/masters', null, jeevakaToken);
let deptMasterId = null;
if (mastersRes) {
  const list = Array.isArray(mastersRes) ? mastersRes : (mastersRes.items ?? []);
  const deptMaster = list.find(m => m.key === 'department');
  if (deptMaster) {
    deptMasterId = deptMaster.id;
    console.log(`  ✓ Department master found: ${deptMasterId}`);
  }
}

if (!deptMasterId) {
  const deptCheck = await call('GET', '/masters/department/records', null, jeevakaToken);
  // try the list endpoint to find the id
  const allMasters = await call('GET', '/masters', null, jeevakaToken);
  if (allMasters) {
    const list = Array.isArray(allMasters) ? allMasters : (allMasters.items ?? []);
    const d = list.find(m => m.key === 'department');
    if (d) deptMasterId = d.id;
  }
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
    const deptRes = await call('POST', `/masters/${deptMasterId}/records`, {
      code: dept.code,
      name: dept.name,
      data: {},
    }, jeevakaToken);
    ok(`Department: ${dept.name}`, deptRes);
  }
} else {
  console.log('  ⚠ Could not find department master key.');
  console.log('  ℹ Trying by key directly...');
  for (const dept of departments) {
    const deptRes = await call('POST', `/masters/department/records`, {
      code: dept.code,
      name: dept.name,
      data: {},
    }, jeevakaToken);
    ok(`Department: ${dept.name}`, deptRes);
  }
}

// ─── Step 6: Create roles ─────────────────────────────────────────────────────

console.log('\n═══ Step 6: Create roles ═══');

const roles = [
  { key: 'manager',   name: 'Manager',   description: 'Approves indents, POs and other documents' },
  { key: 'purchase',  name: 'Purchase',  description: 'Creates and manages purchase orders and vendor quotes' },
  { key: 'accounts',  name: 'Accounts',  description: 'Manages payments and GRN verification' },
  { key: 'store',     name: 'Store',     description: 'Manages stock, GRN and material issues' },
  { key: 'gate',      name: 'Gate',      description: 'Records inward/outward material at gate' },
  { key: 'lab',       name: 'Lab',       description: 'Quality checking and test reports' },
  { key: 'weigh',     name: 'Weigh',     description: 'Weighment of materials' },
  { key: 'indenter',  name: 'Indenter',  description: 'Raises material requisitions (indents)' },
  { key: 'viewer',    name: 'Viewer',    description: 'Read-only access to view documents and reports' },
];

for (const role of roles) {
  const roleRes = await call('POST', '/roles', {
    key: role.key,
    name: role.name,
    description: role.description,
  }, jeevakaToken);
  ok(`Role: ${role.name}`, roleRes);
}

// ─── Step 7: Create "Raw Material" master ────────────────────────────────────
// This creates the master catalog (like a category) AND adds 6 raw materials as records.
// Fields: code, name (built-in) + UOM, HSN Code, GST %

console.log('\n═══ Step 7: Create Raw Material master + records ═══');

const rmMasterRes = await call('POST', '/config/masters', {
  key: 'raw_material',
  name: 'Raw Material',
  pluralName: 'Raw Materials',
  description: 'Iron Ore, Coal, Scrap and other input materials for the furnace',
  settings: {
    codePattern: null,    // user types the code (RM001, RM002, etc.)
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
          { value: 'All',  label: 'All Locations' },
        ],
      },
    ],
  },
}, jeevakaToken);
ok('Created Raw Material master', rmMasterRes);

// Now add the 6 raw materials as records
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
    code: rm.code,
    name: rm.name,
    data: rm.data,
  }, jeevakaToken);
  ok(`Raw Material: ${rm.name}`, r);
}

// ─── Step 8: Create "Consumable" master ──────────────────────────────────────

console.log('\n═══ Step 8: Create Consumable master + records ═══');

const consMasterRes = await call('POST', '/config/masters', {
  key: 'consumable',
  name: 'Consumable',
  pluralName: 'Consumables',
  description: 'Consumable items like gloves, safety equipment, office supplies etc.',
  settings: {
    codePattern: null,
    codeLabel: 'Item Code',
    nameLabel: 'Item Name',
    showInMenu: true,
  },
  definition: {
    fields: [
      {
        key: 'category',
        type: 'text',
        label: 'Category',
        required: false,
        width: 6,
        placeholder: 'e.g. Safety, Office, Tools',
      },
      {
        key: 'brand',
        type: 'text',
        label: 'Brand',
        required: false,
        width: 6,
      },
      {
        key: 'uom',
        type: 'select',
        label: 'Unit of Measure (UOM)',
        required: true,
        width: 6,
        options: [
          { value: 'NOS', label: 'NOS – Numbers / Pieces' },
          { value: 'PKT', label: 'PKT – Packet' },
          { value: 'BOX', label: 'BOX – Box' },
          { value: 'MT',  label: 'MT – Metric Ton' },
          { value: 'KG',  label: 'KG – Kilogram' },
          { value: 'LTR', label: 'LTR – Litre' },
          { value: 'MTR', label: 'MTR – Metre' },
          { value: 'SET', label: 'SET – Set' },
          { value: 'PAR', label: 'PAR – Pair' },
        ],
      },
      {
        key: 'hsn_code',
        type: 'text',
        label: 'HSN Code',
        required: false,
        width: 6,
      },
      {
        key: 'gst_pct',
        type: 'select',
        label: 'GST %',
        required: false,
        width: 6,
        options: [
          { value: '0',  label: '0%' },
          { value: '5',  label: '5%' },
          { value: '12', label: '12%' },
          { value: '18', label: '18%' },
          { value: '28', label: '28%' },
        ],
      },
    ],
  },
}, jeevakaToken);
ok('Created Consumable master', consMasterRes);

// Add the 1 consumable from old system
const consumables = [
  { code: 'CONS-001', name: 'Gloves', data: { category: 'Safety', brand: 'Nike', uom: 'NOS', hsn_code: '23', gst_pct: '18' } },
];

for (const c of consumables) {
  const r = await call('POST', '/masters/consumable/records', {
    code: c.code,
    name: c.name,
    data: c.data,
  }, jeevakaToken);
  ok(`Consumable: ${c.name}`, r);
}

// ─── Step 9: Create "Payment Terms" master ────────────────────────────────────

console.log('\n═══ Step 9: Create Payment Terms master + records ═══');

const ptMasterRes = await call('POST', '/config/masters', {
  key: 'payment_terms',
  name: 'Payment Term',
  pluralName: 'Payment Terms',
  description: 'Vendor payment terms: advance, credit days, etc.',
  settings: {
    codePattern: null,
    codeLabel: 'Code',
    nameLabel: 'Payment Term',
    showInMenu: true,
  },
  definition: {
    fields: [
      {
        key: 'credit_days',
        type: 'number',
        label: 'Credit Days',
        required: false,
        width: 6,
        placeholder: '0 for advance, 30 for 30-day credit, etc.',
      },
      {
        key: 'description',
        type: 'textarea',
        label: 'Description',
        required: false,
        width: 12,
      },
    ],
  },
}, jeevakaToken);
ok('Created Payment Terms master', ptMasterRes);

// Add 7 payment terms from old system
const paymentTerms = [
  { code: 'PT-01', name: 'Advance',                        data: { credit_days: 0,  description: 'Full payment in advance before delivery' } },
  { code: 'PT-02', name: '15 Days Credit',                  data: { credit_days: 15, description: 'Payment within 15 days of invoice' } },
  { code: 'PT-03', name: '30 Days Credit',                  data: { credit_days: 30, description: 'Payment within 30 days of invoice' } },
  { code: 'PT-04', name: '45 Days Credit',                  data: { credit_days: 45, description: 'Payment within 45 days of invoice' } },
  { code: 'PT-05', name: '60 Days Credit',                  data: { credit_days: 60, description: 'Payment within 60 days of invoice' } },
  { code: 'PT-06', name: 'Against Delivery',                data: { credit_days: 0,  description: 'Payment at the time of delivery' } },
  { code: 'PT-07', name: '50% Advance + 50% on Delivery',   data: { credit_days: 0,  description: '50% advance payment, remaining 50% on delivery' } },
];

for (const pt of paymentTerms) {
  const r = await call('POST', '/masters/payment_terms/records', {
    code: pt.code,
    name: pt.name,
    data: pt.data,
  }, jeevakaToken);
  ok(`Payment Term: ${pt.name}`, r);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n═══ ALL DONE ═══');
console.log('');
console.log('What was configured:');
console.log('  ✓ Tenant settings (workflow, stock, security)');
console.log('  ✓ Locations: SPD Chegunta, SPD-01 Furnace, SPD-02 RMD, SID Nasthipur, OFC-01 Office');
console.log('  ✓ Departments: Purchase, Store, Accounts, Gate, Lab, Weigh, Admin, Management, Production, Maintenance, Quality');
console.log('  ✓ Roles: Manager, Purchase, Accounts, Store, Gate, Lab, Weigh, Indenter, Viewer');
console.log('  ✓ Raw Materials: Iron Ore, Coal, Scrap, Pig Iron, Sponge Iron, Silico Manganese');
console.log('  ✓ Consumables: Gloves (CONS-001)');
console.log('  ✓ Payment Terms: 7 terms (Advance to 60 Days Credit)');
console.log('');
console.log('Next steps (do these in the UI at https://procure-web-i1rq.onrender.com):');
console.log('  1. Login as admin@jeevaka.local / Jeevaka@2026');
console.log('  2. Go to Settings > Roles → assign permissions to each role');
console.log('  3. Add your users and assign them roles + locations');
console.log('  4. Add vendors via Settings > Masters > Vendors');
console.log('  5. Add Finished Goods (steel angles, beams, channels etc.) via Masters UI');

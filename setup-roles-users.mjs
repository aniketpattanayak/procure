/**
 * setup-roles-users.mjs
 * 1. Lists existing roles
 * 2. Creates missing roles for procurement workflow
 * 3. Creates one dummy user per role
 *
 * Run: node setup-roles-users.mjs
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const RENDER_DB  = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const TENANT_ID  = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';
const API        = 'https://procure-api-2g2v.onrender.com/api/v1';
const PLAT_EMAIL = 'owner@procure.local';
const PLAT_PASS  = 'Owner@12345';

// ── API helpers ─────────────────────────────────────────────────────────────
async function api(method, path, body, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  const r = await fetch(`${API}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { ok: r.ok, status: r.status, data: d };
}

// ── Login → impersonate Jeevaka ──────────────────────────────────────────────
const lr = await api('POST', '/auth/platform/login', { email: PLAT_EMAIL, password: PLAT_PASS });
if (!lr.ok) { console.error('Platform login failed:', lr.data); process.exit(1); }
const pt = lr.data.accessToken;

const ir = await api('POST', `/platform/tenants/${TENANT_ID}/impersonate`, { reason: 'setup roles+users' }, pt);
if (!ir.ok) { console.error('Impersonate failed:', ir.data); process.exit(1); }
const jt = ir.data.accessToken;
console.log('✓ Logged in as Jeevaka tenant admin\n');

// ── Step 1: List existing roles ──────────────────────────────────────────────
const rr = await api('GET', '/roles', null, jt);
const existing = rr.ok ? rr.data : [];
console.log('═══ Existing Roles ═══');
for (const r of existing) console.log(`  [${r.key}] ${r.name} (id: ${r.id})`);

// ── Step 2: Define all required roles ────────────────────────────────────────
const ROLES = [
  { key: 'indenter',      name: 'Indenter',         description: 'Raises purchase indent requests' },
  { key: 'hod',           name: 'HOD / Manager',    description: 'Approves indents line by line, approves GRN' },
  { key: 'purchase',      name: 'Purchase',          description: 'Logs vendor quotes, compares and selects vendor' },
  { key: 'purchase_po',   name: 'Purchase (PO)',     description: 'Creates Purchase Orders after vendor selection' },
  { key: 'accounts',      name: 'Accounts',          description: 'Approves PO from finance side, handles payments' },
  { key: 'gate',          name: 'Gate',              description: 'Receives material at gate, creates basic GRN entry' },
  { key: 'store',         name: 'Store',             description: 'Receives material in store, approves GRN' },
  { key: 'lab',           name: 'Lab / QC',          description: 'Quality check and lab testing of received goods' },
  { key: 'weigh',         name: 'Weighment',         description: 'Records weighment entries for GRN' },
  { key: 'viewer',        name: 'Viewer',            description: 'Read-only access to all modules, for reports' },
];

const existingKeys = new Set(existing.map(r => r.key));
const roleMap = Object.fromEntries(existing.map(r => [r.key, r]));

console.log('\n═══ Creating Missing Roles ═══');
for (const role of ROLES) {
  if (existingKeys.has(role.key)) {
    console.log(`  ✓ Already exists: [${role.key}] ${role.name}`);
    continue;
  }
  const cr = await api('POST', '/roles', role, jt);
  if (cr.ok) {
    console.log(`  ✅ Created: [${role.key}] ${role.name} → id: ${cr.data.id}`);
    roleMap[role.key] = cr.data;
  } else {
    console.log(`  ❌ Failed to create [${role.key}]: ${JSON.stringify(cr.data)}`);
  }
}

// ── Step 3: Create dummy users ────────────────────────────────────────────────
// Each user gets: email = <key>@jeevaka.local, password = Jeevaka@2026, displayName = <name>
const USERS = [
  { email: 'indenter@jeevaka.local',   displayName: 'Rahul Indenter',   roleKey: 'indenter' },
  { email: 'hod@jeevaka.local',        displayName: 'Suresh Manager',   roleKey: 'hod' },
  { email: 'purchase@jeevaka.local',   displayName: 'Priya Purchase',   roleKey: 'purchase' },
  { email: 'purchase.po@jeevaka.local',displayName: 'Arun PO Creator',  roleKey: 'purchase_po' },
  { email: 'accounts@jeevaka.local',   displayName: 'Meena Accounts',   roleKey: 'accounts' },
  { email: 'gate@jeevaka.local',       displayName: 'Raju Gate',        roleKey: 'gate' },
  { email: 'store@jeevaka.local',      displayName: 'Deepak Store',     roleKey: 'store' },
  { email: 'lab@jeevaka.local',        displayName: 'Anita Lab',        roleKey: 'lab' },
  { email: 'weigh@jeevaka.local',      displayName: 'Vijay Weigh',      roleKey: 'weigh' },
  { email: 'viewer@jeevaka.local',     displayName: 'Kavita Viewer',    roleKey: 'viewer' },
];

// First get existing users to avoid duplicates
const ur = await api('GET', '/users', null, jt);
const existingUsers = ur.ok ? ur.data?.items ?? ur.data ?? [] : [];
const existingEmails = new Set(existingUsers.map(u => u.email?.toLowerCase()));

console.log('\n═══ Creating Dummy Users ═══');
for (const u of USERS) {
  if (existingEmails.has(u.email.toLowerCase())) {
    console.log(`  ✓ Already exists: ${u.email}`);
    // Still try to assign role
    const existingUser = existingUsers.find(eu => eu.email?.toLowerCase() === u.email.toLowerCase());
    if (existingUser && roleMap[u.roleKey]) {
      const assignR = await api('PUT', `/users/${existingUser.id}/roles`, { roleIds: [roleMap[u.roleKey].id] }, jt);
      console.log(`    Role assign: ${assignR.ok ? '✓' : '❌ ' + JSON.stringify(assignR.data)}`);
    }
    continue;
  }

  const roleId = roleMap[u.roleKey]?.id;
  if (!roleId) {
    console.log(`  ⚠ Skipping ${u.email} — role [${u.roleKey}] not found`);
    continue;
  }

  const createR = await api('POST', '/users', {
    email: u.email,
    displayName: u.displayName,
    password: 'Jeevaka@2026',
    roleIds: [roleId],
  }, jt);

  if (createR.ok) {
    console.log(`  ✅ Created: ${u.email} → role: ${u.roleKey}`);
  } else {
    // Try alternate user creation endpoint
    const alt = await api('POST', '/users/invite', {
      email: u.email,
      displayName: u.displayName,
      roleIds: [roleId],
    }, jt);
    if (alt.ok) {
      console.log(`  ✅ Invited: ${u.email} → role: ${u.roleKey}`);
    } else {
      console.log(`  ❌ Failed: ${u.email} → ${JSON.stringify(createR.data)}`);
    }
  }
}

console.log('\n═══ Final Role List ═══');
const finalR = await api('GET', '/roles', null, jt);
if (finalR.ok) {
  for (const r of finalR.data) console.log(`  [${r.key}] ${r.name}`);
}

console.log('\n═══ Final User List ═══');
const finalU = await api('GET', '/users', null, jt);
if (finalU.ok) {
  const users = finalU.data?.items ?? finalU.data ?? [];
  for (const u of users) {
    const roles = u.roles?.map(r => r.key ?? r.name).join(', ') ?? '—';
    console.log(`  ${u.email} → roles: ${roles}`);
  }
}

console.log('\nDone.');

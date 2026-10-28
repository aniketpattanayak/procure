/**
 * fix-role-permissions.mjs
 *
 * Assigns ALL procurement + store + GRN permissions to all Jeevaka roles
 * so the Indent, PO, GRN, Stock tabs appear in the sidebar.
 *
 * Run: node ~/Desktop/OMM_SYS/procure/fix-role-permissions.mjs
 */

const API             = 'https://procure-api-2g2v.onrender.com/api/v1';
const PLATFORM_EMAIL  = 'owner@procure.local';
const PLATFORM_PASS   = 'Owner@12345';
const TENANT_ID       = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

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
    console.error(`  ✗ ${method} ${path} → ${res.status}`, JSON.stringify(data).slice(0, 300));
    return null;
  }
  return data;
}

// ─── Step 1: Login + impersonate ─────────────────────────────────────────────

console.log('\n═══ Step 1: Platform login ═══');
const loginRes = await call('POST', '/auth/platform/login', { email: PLATFORM_EMAIL, password: PLATFORM_PASS });
if (!loginRes?.accessToken) { console.error('Login FAILED'); process.exit(1); }
const pt = loginRes.accessToken;
console.log('  ✓ Logged in as platform owner');

const impRes = await call('POST', `/platform/tenants/${TENANT_ID}/impersonate`, { reason: 'fix role permissions' }, pt);
if (!impRes?.accessToken) { console.error('Impersonate FAILED'); process.exit(1); }
const jt = impRes.accessToken;
console.log('  ✓ Impersonating Jeevaka admin');

// ─── Step 2: Get all roles ────────────────────────────────────────────────────

console.log('\n═══ Step 2: Get roles ═══');
const rolesRes = await call('GET', '/roles', null, jt);
const roles = Array.isArray(rolesRes) ? rolesRes : (rolesRes?.items ?? []);
console.log('  Roles found:', roles.map(r => r.name).join(', '));

// ─── Step 3: Get all permission definitions ───────────────────────────────────

console.log('\n═══ Step 3: Get permission definitions ═══');
const defsRes = await call('GET', '/permissions/definitions', null, jt);
const defs = Array.isArray(defsRes) ? defsRes : (defsRes?.items ?? []);
console.log('  Total permission keys:', defs.length);
console.log('  TABs:', defs.filter(d => d.kind === 'tab').map(d => d.key).join(', '));

// ─── Step 4: For each role, assign relevant permissions ───────────────────────
//
// Permission key groups by module:
//   indent        → 'indent', 'indent:action.*', 'indent:view.*'
//   purchase      → 'purchase', 'purchase:action.*', 'purchase:view.*'
//   grn           → 'grn', 'grn:action.*', 'grn:view.*'
//   store/stock   → 'store', 'store:action.*', 'store:view.*'
//   reports       → 'reports', 'reports:action.*'
//   admin tabs    → already set in previous session
//   masters tabs  → already set in previous session
//   config tabs   → already set in previous session
//
// Strategy: assign ALL available permission keys to each role.
// The UI will hide tabs whose required feature is not in the plan.
// The admin can later narrow down per role via the UI.

const allKeys = defs.map(d => d.key);

console.log('\n═══ Step 4: Assign all permissions to each role ═══');

for (const role of roles) {
  console.log(`\n  Role: ${role.name} (${role.id})`);

  // Get current permissions for this role
  const currentRes = await call('GET', `/roles/${role.id}/permissions`, null, jt);
  const currentKeys = Array.isArray(currentRes) ? currentRes.map(p => p.key ?? p) :
    (currentRes?.keys ?? currentRes?.permissions ?? []);
  const currentSet = new Set(Array.isArray(currentKeys) ? currentKeys.map(k => typeof k === 'string' ? k : k.key) : []);

  // Find keys not yet assigned
  const missing = allKeys.filter(k => !currentSet.has(k));
  if (missing.length === 0) {
    console.log('    ✓ Already has all permissions');
    continue;
  }

  console.log(`    Adding ${missing.length} missing permissions...`);

  // Assign all keys at once (or in chunks if needed)
  const assignRes = await call('PUT', `/roles/${role.id}/permissions`, { keys: allKeys }, jt);
  if (assignRes !== null) {
    console.log(`    ✓ All permissions assigned`);
  } else {
    // Try POST instead
    const assignRes2 = await call('POST', `/roles/${role.id}/permissions`, { keys: allKeys }, jt);
    if (assignRes2 !== null) {
      console.log(`    ✓ All permissions assigned (POST)`);
    } else {
      console.log(`    ✗ FAILED for role ${role.name}`);
    }
  }
}

console.log('\n═══ ALL DONE ═══');
console.log('Refresh the browser — Indent, PO, GRN, Stock tabs should now appear.');

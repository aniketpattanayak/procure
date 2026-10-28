/**
 * check-permissions.mjs
 * Explores the API to find the correct permission endpoints and
 * checks what the Manager role currently has assigned.
 */

const API            = 'https://procure-api-2g2v.onrender.com/api/v1';
const PLATFORM_EMAIL = 'owner@procure.local';
const PLATFORM_PASS  = 'Owner@12345';
const TENANT_ID      = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';
const MANAGER_ROLE_ID = '01a17f1a-da45-7723-b920-807e2e15adc9';

async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

// Login
const lr = await call('POST', '/auth/platform/login', { email: PLATFORM_EMAIL, password: PLATFORM_PASS });
const pt = lr.data.accessToken;
const ir = await call('POST', `/platform/tenants/${TENANT_ID}/impersonate`, { reason: 'check' }, pt);
const jt = ir.data.accessToken;
console.log('✓ Logged in');

// Try several possible permission endpoints
const endpoints = [
  `/roles/${MANAGER_ROLE_ID}/permissions`,
  `/roles/${MANAGER_ROLE_ID}`,
  `/permissions`,
  `/permissions/role/${MANAGER_ROLE_ID}`,
  `/config/permissions`,
  `/platform/permissions`,
];

console.log('\n=== Probing endpoints ===');
for (const ep of endpoints) {
  const r = await call('GET', ep, null, jt);
  console.log(`${r.status} GET ${ep}`);
  if (r.ok) {
    const d = r.data;
    // Print first 600 chars
    console.log('  =>', JSON.stringify(d).slice(0, 600));
  }
}

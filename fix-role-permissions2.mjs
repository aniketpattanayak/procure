import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const RENDER_DB  = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const API        = 'https://procure-api-2g2v.onrender.com/api/v1';
const TENANT_ID  = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';
const PLAT_EMAIL = 'owner@procure.local';
const PLAT_PASS  = 'Owner@12345';

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) { console.error(`  ✗ ${method} ${path} → ${res.status}`, JSON.stringify(data).slice(0,300)); return null; }
  return data;
}

console.log('\n═══ Step 1: Read all permission keys from DB ═══');
const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows: plat } = await db.query(`SELECT key, kind, requires_feature FROM platform.permission_def ORDER BY sort_order, key`);
const { rows: appP } = await db.query(`SELECT key, kind FROM app.permission_def WHERE tenant_id = $1 ORDER BY key`, [TENANT_ID]);
await db.end();
const allKeys = [...new Set([...plat.map(p=>p.key), ...appP.map(p=>p.key)])];
console.log(`  Platform keys: ${plat.length}, App (master) keys: ${appP.length}, Total: ${allKeys.length}`);
console.log('  Tabs:', plat.filter(p=>p.kind==='tab').map(p=>`${p.key}[${p.requires_feature??'*'}]`).join(', '));

console.log('\n═══ Step 2: Login ═══');
const lr = await api('POST', '/auth/platform/login', { email: PLAT_EMAIL, password: PLAT_PASS });
const pt = lr?.accessToken; if (!pt) { console.error('Login FAILED'); process.exit(1); }
const ir = await api('POST', `/platform/tenants/${TENANT_ID}/impersonate`, { reason: 'fix permissions' }, pt);
const jt = ir?.accessToken; if (!jt) { console.error('Impersonate FAILED'); process.exit(1); }
console.log('  ✓ Ready');

const rolesRes = await api('GET', '/roles', null, jt);
const roles = Array.isArray(rolesRes) ? rolesRes : (rolesRes?.items ?? []);
console.log(`  Roles: ${roles.map(r=>r.name).join(', ')}`);

console.log('\n═══ Step 3: Assign ALL keys to Manager role (test) ═══');
const mgr = roles.find(r => r.name === 'Manager');
if (!mgr) { console.error('Manager role not found'); process.exit(1); }

// Try different request shapes
const shapes = [
  { grants: allKeys.map(key => ({ key })) },
  { grants: allKeys },
  { keys: allKeys },
  { permissions: allKeys.map(key => ({ key })) },
  { permissions: allKeys },
];
for (const body of shapes) {
  console.log(`  Trying body shape: ${Object.keys(body)[0]}=${JSON.stringify(Object.values(body)[0]).slice(0,60)}...`);
  const r = await api('PUT', `/roles/${mgr.id}/permissions`, body, jt);
  if (r !== null) { console.log('  ✓ SUCCESS with shape:', JSON.stringify(body).slice(0,80)); break; }
  const r2 = await api('POST', `/roles/${mgr.id}/permissions`, body, jt);
  if (r2 !== null) { console.log('  ✓ SUCCESS (POST) with shape:', JSON.stringify(body).slice(0,80)); break; }
}

// Check what Manager now has
const check = await api('GET', `/roles/${mgr.id}/permissions`, null, jt);
console.log('\n  Manager permissions after update:', JSON.stringify(check).slice(0,500));

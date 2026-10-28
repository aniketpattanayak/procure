#!/usr/bin/env node
import https from 'node:https';

const API = 'https://procure-api-2g2v.onrender.com/api/v1';

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(API + path);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(b) }); }
        catch(e) { resolve({ status: res.statusCode, body: b }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Step 1: Login as platform owner
console.log('⏳ Logging in as platform owner...');
const loginRes = await request('POST', '/auth/platform/login', { email: 'owner@procure.local', password: 'Owner@12345' });
const token = loginRes.body?.accessToken;
if (!token) { console.error('❌ Login failed:', JSON.stringify(loginRes.body)); process.exit(1); }
console.log('  ✓ Got token\n');

const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

// Step 2: Create admin user for Jeevaka
console.log('⏳ Creating admin user for Jeevaka...');
const createRes = await request('POST', `/platform/tenants/${TENANT_ID}/users`, {
  name: 'Jeevaka Admin',
  email: 'admin@jeevaka.local',
  role: 'admin'
}, token);
console.log(`  HTTP ${createRes.status}`);
console.log('  Response:', JSON.stringify(createRes.body, null, 2));

if (createRes.body?.temporaryPassword) {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  ✅  Admin user created!                             ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`\n  Login URL: https://procure-web-i1rq.onrender.com`);
  console.log(`  Tenant:    jeevaka`);
  console.log(`  Email:     admin@jeevaka.local`);
  console.log(`  Password:  ${createRes.body.temporaryPassword}`);
  console.log('\n  ⚠ Change this password after first login!\n');
}

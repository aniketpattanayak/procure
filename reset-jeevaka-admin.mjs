#!/usr/bin/env node
import https from 'node:https';

const API = 'https://procure-api-2g2v.onrender.com/api/v1';
const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

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

// Login as platform owner
console.log('⏳ Logging in as platform owner...');
const loginRes = await request('POST', '/auth/platform/login', { email: 'owner@procure.local', password: 'Owner@12345' });
const token = loginRes.body?.accessToken;
if (!token) { console.error('❌ Login failed'); process.exit(1); }
console.log('  ✓ Got token\n');

// Reset admin password
console.log('⏳ Resetting Jeevaka admin password...');
const resetRes = await request('POST', `/platform/tenants/${TENANT_ID}/admin/reset-password`, null, token);
console.log(`  HTTP ${resetRes.status}`);
console.log('  Response:', JSON.stringify(resetRes.body, null, 2));

if (resetRes.body?.temporaryPassword) {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  ✅  Password reset!                                 ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`\n  Login URL: https://procure-web-i1rq.onrender.com`);
  console.log(`  Tenant:    jeevaka`);
  console.log(`  Email:     ${resetRes.body.adminEmail}`);
  console.log(`  Password:  ${resetRes.body.temporaryPassword}`);
  console.log('\n  ⚠ Change this password after first login!\n');
}

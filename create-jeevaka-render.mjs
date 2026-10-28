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

// Step 1: Login
console.log('\n⏳ Step 1: Login as platform owner...');
const loginRes = await request('POST', '/auth/platform/login', { email: 'owner@procure.local', password: 'Owner@12345' });
console.log(`  HTTP ${loginRes.status}`);
const token = loginRes.body?.accessToken || loginRes.body?.token;
if (!token) { console.error('❌ Login failed:', JSON.stringify(loginRes.body)); process.exit(1); }
console.log('  ✓ Got token\n');

// Step 2: Get plans
console.log('⏳ Step 2: Get starter plan...');
const plansRes = await request('GET', '/platform/plans', null, token);
console.log(`  HTTP ${plansRes.status}`);
const plans = Array.isArray(plansRes.body) ? plansRes.body : plansRes.body?.data?.rows ?? plansRes.body?.rows ?? [];
console.log('  Plans found:', plans.map(p => `${p.code}(${p.id})`).join(', ') || 'none');
const plan = plans.find(p => p.code === 'starter') || plans[0];
if (!plan) { console.error('❌ No plans found. Raw response:', JSON.stringify(plansRes.body).slice(0,300)); process.exit(1); }
console.log(`  ✓ Using: ${plan.code} (${plan.id})\n`);

// Step 3: Create Jeevaka
console.log('⏳ Step 3: Create Jeevaka tenant...');
const TODAY = new Date().toISOString().slice(0,10);
const RENEWAL = new Date(Date.now() + 365*24*60*60*1000).toISOString().slice(0,10);
const createRes = await request('POST', '/platform/tenants', {
  code: 'jeevaka', name: 'Jeevaka', legalName: 'Jeevaka ERP Pvt Ltd',
  timezone: 'Asia/Kolkata', currency: 'INR', fyStartMonth: 4,
  taxIds: {}, address: { country: 'IN' },
  planId: plan.id,
  subscription: { status: 'active', startDate: TODAY, renewalDate: RENEWAL },
  admin: { name: 'Jeevaka Admin', email: 'admin@jeevaka.local' }
}, token);
console.log(`  HTTP ${createRes.status}`);
console.log('  Response:', JSON.stringify(createRes.body).slice(0, 400));

if (createRes.body?.temporaryPassword) {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  ✅  Jeevaka created on Render!                     ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`\n  URL:      https://procure-web-i1rq.onrender.com/jeevaka/login`);
  console.log(`  Email:    admin@jeevaka.local`);
  console.log(`  Password: ${createRes.body.temporaryPassword}`);
  console.log('\n  (Change password on first login)\n');
} else if (JSON.stringify(createRes.body).toLowerCase().match(/exist|duplicate|already/)) {
  console.log('\n✓ Jeevaka already exists on Render — ready to use.');
} else {
  console.log('\n⚠ Check response above.');
}

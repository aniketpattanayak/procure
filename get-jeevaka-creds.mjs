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

// Login as platform owner
const loginRes = await request('POST', '/auth/platform/login', { email: 'owner@procure.local', password: 'Owner@12345' });
const token = loginRes.body?.accessToken;
if (!token) { console.error('Login failed'); process.exit(1); }

// Get all tenants
const tenantsRes = await request('GET', '/platform/tenants', null, token);
console.log('Tenants response:', JSON.stringify(tenantsRes.body, null, 2));

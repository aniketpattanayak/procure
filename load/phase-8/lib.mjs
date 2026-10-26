// Shared helpers for the Phase 8 load scripts: API client (login, JSON calls, timing) and percentile maths.
import http from 'node:http';

export const API = process.env.API ?? `http://localhost:${process.env.API_PORT ?? 4121}/api/v1`;
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/** One HTTP call; resolves { status, body (parsed JSON or raw), ms, bytes }. */
export function call(method, path, { token, body, raw = false } = {}) {
  const url = new URL(API + path);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = http.request(url, {
      method, agent,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const buf = Buffer.concat(chunks);
        let parsed = buf;
        if (!raw) { try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = buf.toString('utf8'); } }
        resolve({ status: res.statusCode, body: parsed, ms, bytes: buf.length, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function ok(method, path, opts) {
  const r = await call(method, path, opts);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`);
  return r.body;
}

export async function platformLogin() {
  return (await ok('POST', '/auth/platform/login', { body: { email: 'owner@procure.local', password: 'Owner@12345' } })).accessToken;
}

export async function login(tenantCode, email, password) {
  return (await ok('POST', '/auth/login', { body: { tenantCode, email, password } })).accessToken;
}

export function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return { n: s.length, p50: round(pct(s, 50)), p95: round(pct(s, 95)), max: round(s[s.length - 1]), min: round(s[0]) };
}

export const round = x => Math.round(x * 10) / 10;

export async function loadAvg() {
  const { readFile } = await import('node:fs/promises');
  return (await readFile('/proc/loadavg', 'utf8')).split(' ').slice(0, 3).join(' ');
}

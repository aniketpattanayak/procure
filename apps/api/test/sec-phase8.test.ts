/**
 * Phase 8 security — scripted DAST against the in-process API (OWASP ZAP is not available in this environment).
 * The authN/authZ sweeps are generated from the live Express route table, so a new controller is covered
 * automatically. Findings and their ids (SEC8-xxx) are in docs/qa/phase-8-security-report.md.
 *
 * Sections: route-table sweeps (unauthenticated, cross-audience, cross-tenant IDOR with A's real ids, minimal-permission
 * user), JWT tampering, injection (SQL via list/sort/report definitions, Handlebars, CSV/XLSX formulas), SSRF,
 * uploads (ASF parser DoS), ReDoS in form patterns, mass assignment, error leakage, headers/CORS, secrets at rest.
 */
import ExcelJS from 'exceljs';
import { decodeJwt, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/core/config';
import { isBlockedIp, vetUrl } from '../src/modules/notify/util/ssrf';
import { boundedTest } from '../src/modules/forms/validators';
import { CAPEX_HEADER, CAPEX_LINE } from './documents-helpers';
import { api, createMaster, mustOk, PNG_1PX } from './forms-helpers';
import { activeTenantAdmin, API, bearer, bootApp, closeApp, createPlan, createTenant, Ctx, refreshCookie, superAdmin, tenantLogin, uid } from './helpers';
import { restrictedUser } from './permissions-helpers';

type Route = { method: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string };
interface Tenant { tenantId: string; code: string; token: string; adminId: string; adminEmail: string; loc: string; uom: string; item: string; doc: string; file: string }

const CANARY = `CANARYA${uid(6)}`;
const SECRET = 'test-secret-test-secret-test-secret!!'; // JWT_SECRET of the vitest env (vitest.config.ts)
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ID_PARAMS = new Set(['id', 'attId', 'commentId', 'itemId', 'lineId', 'quoteId', 'scheduleId', 'widgetId']);
/** Public by design (contract + ADR-0004/0008/0014). */
const EXPECTED_PUBLIC = [
  'GET /health', 'POST /api/v1/auth/login', 'POST /api/v1/auth/platform/login', 'POST /api/v1/auth/refresh',
  'GET /api/v1/files/:id/content', 'GET /api/v1/hooks/whatsapp', 'POST /api/v1/hooks/whatsapp', 'POST /api/v1/hooks/email/ses',
];

let c: Ctx;
let routes: Route[];
let A: Tenant;
let B: Tenant;
let platform: { token: string; userId: string };
let features: string[];
let planId: string;

const key = (r: Route) => `${r.method.toUpperCase()} ${r.path}`;
const call = (r: Route, path: string, token?: string, body: unknown = {}) => {
  let q = c.http[r.method](path);
  if (token) q = q.set(bearer(token));
  return r.method === 'get' || r.method === 'delete' ? q : q.send(body as object);
};
/** Fills string params with keys that exist in every tenant and id params with `id`. */
const fill = (path: string, id: string) => path
  .replace(/:(type|docType)\b/g, 'capex').replace(/\/masters\/:key/g, '/masters/item').replace(/\/doc-types\/:key/g, '/doc-types/capex')
  .replace(/:formKey\b/g, 'item').replace(/:tabKey\b/g, 'admin.users').replace(/:(v|version)\b/g, '1').replace(/:key\b/g, 'capex')
  .replace(/:([A-Za-z]+)/g, (_m, p: string) => (ID_PARAMS.has(p) ? id : 'x'));

async function fixtureTenant(planId: string, tag: string): Promise<Tenant> {
  const t = await createTenant(c, platform.token, planId);
  const admin = await activeTenantAdmin(c, t);
  const a = api(c, admin.token);
  const loc = await mustOk(a.post('/locations', { code: `L${uid(4)}`, name: `${tag} plant` }), 201);
  const uom = await mustOk(a.post('/masters/uom/records', { code: `U${uid(4)}`, name: `${tag} units`, data: { decimals: '0' } }), 201);
  const item = await mustOk(a.post('/masters/item/records', { name: `${tag} laptop`, data: { uom: uom.id } }), 201);
  await mustOk(a.post('/config/doc-types', { key: 'capex', name: 'Capex', pluralName: 'Capex', headerDefinition: { fields: CAPEX_HEADER }, lineDefinition: { fields: CAPEX_LINE }, numberPattern: 'CX/{SEQ:4}' }), 201);
  const doc = await mustOk(a.post('/docs/capex', { values: { location: loc.id, purpose: `${tag} purpose`, doc_date: '2026-10-01' }, lines: [{ values: { item: item.id, qty: '2', est_rate: '100' } }] }), 201);
  const file = await mustOk(c.http.post(`${API}/files`).set(bearer(admin.token)).attach('file', PNG_1PX, `${tag}.png`), 201);
  await mustOk(a.post(`/docs/capex/${doc.id}/attachments`, { fileId: file.id }), 201);
  await mustOk(a.post(`/docs/capex/${doc.id}/comments`, { body: `${tag} comment` }), 201);
  await mustOk(a.post('/roles', { key: `r_${uid(6)}`, name: `${tag} role` }), 201);
  await mustOk(a.post(`/docs/capex/${doc.id}/submit`, { version: doc.version }), 200);
  return { tenantId: t.tenantId, code: t.code, token: admin.token, adminId: admin.userId, adminEmail: t.adminEmail, loc: loc.id, uom: uom.id, item: item.id, doc: doc.id, file: file.id };
}

/** One id per tenant-scoped table for tenant `tid` (the victim's real ids). */
async function idsOf(tid: string): Promise<string[]> {
  const tables = (await c.db.selectFrom('information_schema.columns as c' as never).select('c.table_name as t' as never)
    .where('c.table_schema' as never, '=', 'app' as never).where('c.column_name' as never, '=', 'tenant_id' as never).execute()) as unknown as { t: string }[];
  const ids = new Set<string>();
  for (const { t } of tables) {
    const r = await c.db.executeQuery<{ id: string }>({ sql: `select id::text as id from app.${t} where tenant_id = $1 and id::text ~ '^[0-9a-f-]{36}$' order by id::text desc limit 1`, parameters: [tid], query: { kind: 'RawNode' } as never }).catch(() => ({ rows: [] }));
    r.rows.forEach(x => ids.add(x.id));
  }
  return [...ids];
}

/** md5 of every tenant-scoped row of `tid` (per table), to prove a sweep changed nothing. */
async function stateOf(tid: string): Promise<Record<string, string>> {
  const tables = (await c.db.executeQuery<{ t: string }>({ sql: `select table_name as t from information_schema.columns where table_schema = 'app' and column_name = 'tenant_id' and table_name in (select table_name from information_schema.tables where table_schema = 'app' and table_type = 'BASE TABLE')`, parameters: [], query: { kind: 'RawNode' } as never })).rows;
  const out: Record<string, string> = {};
  for (const { t } of tables) {
    const r = await c.db.executeQuery<{ h: string }>({ sql: `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from app.${t} x where tenant_id = $1`, parameters: [tid], query: { kind: 'RawNode' } as never });
    out[t] = r.rows[0]!.h;
  }
  return out;
}

beforeAll(async () => {
  c = await bootApp();
  const stack = (c.app.getHttpAdapter().getInstance() as { _router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } })._router.stack;
  routes = stack.filter(l => l.route).flatMap(l => Object.keys(l.route!.methods).map(m => ({ method: m as Route['method'], path: l.route!.path })));
  const sa = await superAdmin(c);
  platform = { token: sa.token, userId: sa.userId };
  features = (await mustOk(c.http.get(`${API}/platform/catalog`).set(bearer(sa.token)))).features.map((f: { key: string }) => f.key);
  const plan = await createPlan(c, sa.token, { features, limits: { max_users: 50, custom_forms: 20, storage_gb: 1, max_locations: 20, webhook_endpoints: 5 } });
  planId = plan.id;
  A = await fixtureTenant(plan.id, CANARY);
  B = await fixtureTenant(plan.id, 'Bravo');
}, 180_000);

afterAll(async () => { await closeApp(c); });

describe('route-table sweeps', () => {
  it('route table is non-trivial (guards against a silently empty sweep)', () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  it('only the documented routes are reachable without a token; everything else is 401', async () => {
    const open: string[] = [];
    for (const r of routes) {
      const res = await call(r, fill(r.path, '00000000-0000-4000-8000-000000000000'));
      // The guard's own refusal; public handlers that fail closed (refresh without a cookie, unsigned hooks) also say 401.
      if (!(res.status === 401 && res.body?.title === 'Please sign in')) open.push(key(r));
    }
    expect(open.sort()).toEqual([...EXPECTED_PUBLIC].sort());
  }, 120_000);

  it('a platform (Super Admin) token is refused on every tenant route', async () => {
    const leaks: string[] = [];
    for (const r of routes) {
      if (/^\/api\/v1\/(platform|auth|hooks)\//.test(r.path) || r.path === '/health' || r.path.endsWith('/files/:id/content')) continue;
      const res = await call(r, fill(r.path, A.doc), platform.token);
      if (res.status !== 403 && res.status !== 401) leaks.push(`${key(r)} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  }, 120_000);

  it('a tenant administrator is refused on every platform route', async () => {
    const leaks: string[] = [];
    for (const r of routes.filter(x => x.path.startsWith('/api/v1/platform/'))) {
      const res = await call(r, fill(r.path, A.tenantId), B.token);
      if (res.status !== 403) leaks.push(`${key(r)} -> ${res.status}`);
    }
    expect(leaks).toEqual([]);
  }, 60_000);

  it("IDOR: tenant B's administrator with every one of A's ids on every id-taking route — no A data out, no A row changed, no 5xx", async () => {
    const pool = await idsOf(A.tenantId);
    expect(pool.length).toBeGreaterThanOrEqual(15);
    const before = await stateOf(A.tenantId);
    const leaks: string[] = [];
    const errors: string[] = [];
    let requests = 0;
    const targets = routes.filter(r => /:([A-Za-z]+)/.test(r.path) && !/^\/api\/v1\/(platform|auth|hooks)\//.test(r.path) && !r.path.endsWith('/files/:id/content'));
    for (const r of targets) {
      for (const id of pool) {
        const res = await call(r, fill(r.path, id), B.token);
        requests++;
        const text = res.text ?? '';
        if (res.status >= 500) errors.push(`${key(r)} [${id}] -> ${res.status}`);
        if (text.includes(CANARY)) leaks.push(`${key(r)} [${id}] -> ${res.status} canary`);
        const otherAIds = (text.match(UUID_RE) ?? []).filter(x => x !== id && pool.includes(x));
        if (otherAIds.length) leaks.push(`${key(r)} [${id}] -> ${res.status} A ids ${otherAIds.slice(0, 3).join(',')}`);
      }
    }
    const after = await stateOf(A.tenantId);
    console.info(`IDOR sweep: ${targets.length} routes x ${pool.length} ids = ${requests} requests`);
    expect(leaks).toEqual([]);
    expect(errors).toEqual([]);
    expect(after).toEqual(before);
  }, 600_000);

  it('vertical: a user with no roles gets 403/404 on everything except self-service routes', async () => {
    const u = await restrictedUser(c, B.code, B.token);
    const SELF_SERVICE = new Set([
      'GET /api/v1/auth/me', 'GET /api/v1/auth/sessions', 'POST /api/v1/auth/logout', 'DELETE /api/v1/auth/sessions/:id', 'POST /api/v1/auth/password/change',
      'GET /api/v1/notifications', 'POST /api/v1/notifications/:id/read', 'POST /api/v1/notifications/read-all', 'GET /api/v1/notifications/count',
      'GET /api/v1/me/permissions', 'GET /api/v1/permissions/me', 'POST /api/v1/files', 'GET /api/v1/files/:id',
      'GET /api/v1/inbox', 'GET /api/v1/inbox/counts', 'GET /api/v1/dashboards/home', 'GET /api/v1/tenant/usage',
    ]);
    const allowed: string[] = [];
    for (const r of routes) {
      if (/^\/api\/v1\/(platform|hooks)\//.test(r.path) || r.path === '/health' || /auth\/(login|platform\/login|refresh)$/.test(r.path) || r.path.endsWith('/files/:id/content')) continue;
      if (key(r) === 'POST /api/v1/auth/logout') continue; // would end this session
      const res = await call(r, fill(r.path, B.doc), u.token);
      if (res.status < 300 && !SELF_SERVICE.has(key(r))) allowed.push(`${key(r)} -> ${res.status}`);
    }
    console.info(`no-role user 2xx outside self-service: ${JSON.stringify(allowed)}`);
    expect(allowed.filter(x => !NO_ROLE_OK.some(p => x.startsWith(p)))).toEqual([]);
  }, 180_000);
});

/** Routes a user without roles may legitimately call (they read only their own / non-sensitive data). Reviewed in the report. */
const NO_ROLE_OK: string[] = [
  'GET /api/v1/users/options', // user picker (lookups, mentions, forward): id, name, email of active colleagues — by design
  'GET /api/v1/masters ', 'GET /api/v1/masters/:key/options', // lookup feeds for forms (hidden fields never in attrs, QA2-BUG-004)
  'GET /api/v1/config/labels', 'GET /api/v1/doc-types ', // UI labels and the menu (only types the caller can see)
  'GET /api/v1/saved-views ', 'GET /api/v1/exports ', 'GET /api/v1/dashboards/mine', // the caller's own rows
];

describe('JWT and sessions', () => {
  const sign = (claims: Record<string, unknown>, opts: { alg?: string; secret?: string; exp?: string | number } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: opts.alg ?? 'HS256' }).setIssuedAt().setIssuer('procure').setAudience(String(claims.typ))
      .setExpirationTime(opts.exp ?? '10m').sign(new TextEncoder().encode(opts.secret ?? SECRET));
  const me = (tok: string) => c.http.get(`${API}/auth/me`).set(bearer(tok));

  it('alg none, wrong secret, HS512, expired, garbage and tampered signatures are 401', async () => {
    const claims = decodeJwt(B.token);
    const [h, p] = B.token.split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
    const tamperedPayload = Buffer.from(JSON.stringify({ ...claims, tid: A.tenantId })).toString('base64url');
    const cases = [
      none,
      `${h}.${tamperedPayload}.${B.token.split('.')[2]}`,
      await sign({ ...claims }, { secret: 'another-secret-another-secret-another!!' }),
      await sign({ ...claims }, { alg: 'HS512' }),
      await sign({ ...claims }, { exp: Math.floor(Date.now() / 1000) - 10 }),
      'not.a.jwt', '', 'Bearer',
    ];
    for (const t of cases) expect((await me(t)).status, t.slice(0, 40)).toBe(401);
    expect((await me(B.token)).status).toBe(200);
  });

  it("[SEC8-009] a validly signed token with another tenant's id (tid spoof) or a platform typ for a tenant user finds no principal", async () => {
    const claims = decodeJwt(B.token);
    expect((await me(B.token)).status).toBe(200); // B's principal is now cached
    expect((await me(await sign({ ...claims, tid: A.tenantId }))).status).toBe(401);
    const asPlatform = await sign({ ...claims, typ: 'platform', tid: undefined });
    expect((await me(asPlatform)).status).toBe(401);
    expect((await c.http.get(`${API}/platform/tenants`).set(bearer(asPlatform))).status).toBe(401);
  });

  it('logout kills the access token at once; a rotated refresh token reused revokes the family', async () => {
    const s = await tenantLogin(c, B.code, B.adminEmail, 'NewAdmin@12345');
    const r1 = await c.http.post(`${API}/auth/refresh`).set('Cookie', s.cookie);
    expect(r1.status).toBe(200);
    const reuse = await c.http.post(`${API}/auth/refresh`).set('Cookie', s.cookie);
    expect(reuse.status).toBe(401);
    expect((await c.http.post(`${API}/auth/refresh`).set('Cookie', refreshCookie(r1))).status).toBe(401); // family revoked
    const s2 = await tenantLogin(c, B.code, B.adminEmail, 'NewAdmin@12345');
    expect((await c.http.post(`${API}/auth/logout`).set(bearer(s2.token)).set('Cookie', s2.cookie)).status).toBeLessThan(300);
    expect((await me(s2.token)).status).toBe(401);
  });

  it('the refresh cookie is HttpOnly, SameSite=Strict and scoped to the auth path', async () => {
    const res = await c.http.post(`${API}/auth/login`).send({ tenantCode: B.code, email: B.adminEmail, password: 'NewAdmin@12345' });
    const ck = (res.headers['set-cookie'] as unknown as string[]).find(x => x.startsWith('rt='))!;
    expect(ck).toMatch(/HttpOnly/i);
    expect(ck).toMatch(/SameSite=Strict/i);
    expect(ck).toMatch(/Path=\/api\/v1\/auth/i);
  });

  it('[SEC8-005] an impersonation token stops working as soon as its platform user is deactivated', async () => {
    const sa = await superAdmin(c, 'support');
    const imp = await mustOk(c.http.post(`${API}/platform/tenants/${B.tenantId}/impersonate`).set(bearer(sa.token)).send({ reason: 'Phase 8 test' }));
    expect((await me(imp.accessToken)).status).toBe(200);
    await c.db.updateTable('platform.platform_user').set({ is_active: false }).where('id', '=', sa.userId).execute();
    const { RedisService } = await import('../src/core/redis.service');
    const { invalidatePrincipal } = await import('../src/core/auth/auth.guard');
    await invalidatePrincipal(c.app.get(RedisService), 'tenant', B.adminId); // as the identity module does on user changes
    expect((await me(imp.accessToken)).status).toBe(401);
  });

  it('impersonation sessions are time-boxed (expires_at well under a normal session)', async () => {
    const sa = await superAdmin(c, 'owner');
    const imp = await mustOk(c.http.post(`${API}/platform/tenants/${B.tenantId}/impersonate`).set(bearer(sa.token)).send({ reason: 'expiry check' }));
    const s = await c.db.selectFrom('platform.auth_session').select(['expires_at', 'impersonated_by']).where('id', '=', String(decodeJwt(imp.accessToken).sid)).executeTakeFirstOrThrow();
    expect(s.impersonated_by).toBe(sa.userId);
    expect(new Date(s.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(61 * 60_000);
  });
});

describe('injection', () => {
  const SQLI = ["'", "' or '1'='1", "1; drop table app.document; --", "\") or 1=1 --", "$$; select pg_sleep(5); $$", "%' union select password_hash from app.tenant_user --", "\\'", 'capex.custom->>\'x\''];
  const noDbLeak = (text: string) => expect(text).not.toMatch(/syntax error at or near|relation "[^"]*" does not exist|column "[^"]*" does not exist|unterminated quoted|invalid input syntax|kysely|node_modules|\n\s+at \S+ \(/i);

  it('SQL metacharacters in list search, sort, filters and cursors: never 5xx, never a DB error in the body', async () => {
    const t0 = Date.now();
    for (const p of SQLI) {
      const e = encodeURIComponent(p);
      for (const url of [
        `/docs/capex?q=${e}`, `/docs/capex?sort=${e}`, `/docs/capex?status=${e}`, `/docs/capex?cursor=${e}`, `/docs/capex?location=${e}`,
        `/docs/capex?view=item&sort=${e}`, `/masters/item/records?q=${e}`, `/masters/item/records?sort=${e}`, `/masters/item/records?cursor=${Buffer.from(JSON.stringify({ v: p, id: p })).toString('base64url')}`,
        `/masters/item/options?q=${e}&filter=${e}`, `/users?q=${e}`, `/audit?entity=${e}&q=${e}`, `/inbox?q=${e}`, `/stock/balances?q=${e}`,
      ]) {
        const res = await c.http.get(`${API}${url}`).set(bearer(B.token));
        expect(res.status, `${url} ${res.text}`).toBeLessThan(500);
        noDbLeak(res.text);
      }
    }
    expect(Date.now() - t0).toBeLessThan(60_000); // no pg_sleep got through
  }, 120_000);

  it('report definitions with injected field ids, aggregates, sort and filter values are refused or parametrised', async () => {
    const src = (await mustOk(c.http.get(`${API}/reports/sources`).set(bearer(B.token)))) as { key: string }[] | { sources: { key: string }[] };
    const sources = Array.isArray(src) ? src : src.sources;
    const source = sources.find(s => /capex|doc/i.test(s.key))?.key ?? sources[0]!.key;
    for (const p of SQLI) {
      for (const def of [
        { source, columns: [{ field: p }] },
        { source: p, columns: [{ field: 'header.number' }] },
        { source, columns: [{ field: 'header.number', aggregate: p }] },
        { source, columns: [{ field: 'header.number' }], sort: [{ field: p, dir: 'desc' }] },
        { source, columns: [{ field: 'header.number' }], sort: [{ field: 'header.number', dir: `desc; ${p}` }] },
        { source, columns: [{ field: 'header.number' }], filters: [{ field: 'header.number', op: 'eq', value: p }] },
        { source, columns: [{ field: 'header.number' }], filters: [{ field: p, op: 'eq', value: '1' }] },
      ]) {
        const res = await c.http.post(`${API}/reports/preview`).set(bearer(B.token)).send({ definition: { name: 'x', ...def }, params: {} });
        expect(res.status, `${JSON.stringify(def)} ${res.text.slice(0, 300)}`).toBeLessThan(500);
        noDbLeak(res.text);
      }
    }
  }, 120_000);

  it('Handlebars: prototype / constructor access and unknown helpers never execute code', async () => {
    const payloads = [
      '{{constructor.constructor "return process"}}',
      '{{#with "s" as |string|}}{{#with string.constructor as |c|}}{{c.constructor "return 1"}}{{/with}}{{/with}}',
      '{{lookup (lookup this "constructor") "constructor"}}',
      '{{__proto__.polluted}}{{#with __proto__}}{{this}}{{/with}}',
      '{{> (lookup . "x")}}', '{{#each (lookup this "__lookupGetter__")}}{{/each}}', '{{log "x"}}', '{{blockHelperMissing}}',
      '{{lookup this "__defineGetter__"}}{{lookup "a" "constructor"}}',
    ];
    for (const body of payloads) {
      const res = await c.http.post(`${API}/config/templates/preview`).set(bearer(B.token))
        .send({ channel: 'email', subject: 's', body, docTypeKey: 'capex', documentId: B.doc });
      expect(res.status, body).toBeLessThan(500);
      expect(res.text, body).not.toMatch(/function|\[native code\]|process|polluted/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('CSV / XLSX exports neutralise values starting with = + - @ (formula injection)', async () => {
    const evil = ['=HYPERLINK("http://evil.test","x")', '+cmd|" /C calc"!A0', '-2+3+cmd|" /C calc"!A0', '@SUM(1+1)*cmd|" /C calc"!A0'];
    for (const name of evil) await mustOk(api(c, B.token).post('/masters/uom/records', { code: `E${uid(5)}`, name, data: { decimals: '0' } }), 201);
    const csv = await c.http.get(`${API}/masters/uom/export?format=csv`).set(bearer(B.token)).buffer(true);
    expect(csv.status).toBe(200);
    const text = csv.text;
    for (const v of evil) {
      expect(text).not.toMatch(new RegExp(`(^|,)"?${v.slice(0, 1).replace(/[+]/, '\\+')}${v.slice(1, 6).replace(/[()+|"]/g, '.')}`, 'm'));
      expect(text).toContain(`'${v.slice(0, 6)}`);
    }
    const xlsx = await c.http.get(`${API}/masters/uom/export?format=xlsx`).set(bearer(B.token)).buffer(true)
      .parse((res, cb) => { const ch: Buffer[] = []; res.on('data', (d: Buffer) => ch.push(d)); res.on('end', () => cb(null, Buffer.concat(ch))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as ArrayBuffer);
    let formulas = 0;
    wb.worksheets[0]!.eachRow(row => row.eachCell(cell => { if (cell.type === ExcelJS.ValueType.Formula) formulas++; }));
    expect(formulas).toBe(0);
  });
});

describe('SSRF (outgoing webhooks)', () => {
  it.each([
    'http://example.com/hook', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://0x7f000001/x', 'https://0177.0.0.1/x', 'https://127.1/x',
    'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[::ffff:7f00:1]/x', 'https://[64:ff9b::a9fe:a9fe]/x', 'https://[2002:a9fe:a9fe::]/x',
    'https://169.254.169.254/latest/meta-data', 'https://[fd00:ec2::254]/x', 'https://10.0.0.1/x', 'https://100.64.0.1/x', 'https://localhost/x',
    'https://metadata.google.internal/x', 'https://user:pw@example.com/x', 'https://0.0.0.0/x', 'file:///etc/passwd', 'gopher://127.0.0.1:6379/_x',
  ])('refuses %s', async url => {
    const res = await c.http.post(`${API}/config/webhooks`).set(bearer(B.token)).send({ url, events: ['document.submitted'] });
    expect(res.status, res.text).toBe(400);
  });

  it('DNS rebinding: a host that resolves to any private address is refused, and the vetted address is what gets dialled', async () => {
    await expect(vetUrl('https://rebind.test/x', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }])).rejects.toThrow(/private or reserved/);
    await expect(vetUrl('https://rebind.test/x', async () => [{ address: '::ffff:169.254.169.254', family: 6 }])).rejects.toThrow();
    const ok = await vetUrl('https://pub.test/x', async () => [{ address: '93.184.216.34', family: 4 }]);
    expect(ok.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    for (const ip of ['127.0.0.1', '169.254.169.254', '::1', 'fe80::1', '::ffff:10.1.2.3', '0.0.0.0', '255.255.255.255', 'not-an-ip']) expect(isBlockedIp(ip), ip).toBe(true);
    expect(isBlockedIp('93.184.216.34')).toBe(false);
  });
});

describe('uploads', () => {
  it('[SEC8-002] a crafted ASF header (file-type infinite loop) is refused quickly instead of hanging the process', async () => {
    const buf = Buffer.alloc(200);
    Buffer.from([0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C]).copy(buf, 0);
    const t0 = Date.now();
    const res = await c.http.post(`${API}/files`).set(bearer(B.token)).attach('file', buf, 'clip.png').timeout(10_000);
    expect(res.status).toBe(400);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('[SEC8-016] image decompression bombs: a PNG declaring more than 50 MP is refused at upload; sharp has an explicit pixel limit', async () => {
    const { crc32, deflateSync } = await import('node:zlib');
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const png = (w: number, h: number) => {
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; // 8-bit greyscale
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(w + 1))), chunk('IEND', Buffer.alloc(0))]);
    };
    const bomb = await c.http.post(`${API}/files`).set(bearer(B.token)).attach('file', png(10_000, 10_000), 'bomb.png');
    expect(bomb.status, JSON.stringify(bomb.body)).toBe(400);
    expect(JSON.stringify(bomb.body)).toMatch(/at most 50 megapixels/);
    const { decodeImage, MAX_IMAGE_PIXELS } = await import('../src/modules/files');
    expect(MAX_IMAGE_PIXELS).toBe(50_000_000);
    // 56 MP is under sharp's default (268 MP) but over the explicit limit; callers cannot raise it
    await expect(decodeImage(png(8000, 7000)).metadata()).rejects.toThrow(/pixel limit/i);
    await expect(decodeImage(png(8000, 7000), { limitInputPixels: 1e12 }).metadata()).rejects.toThrow(/pixel limit/i);
    expect((await decodeImage(png(7000, 7000)).metadata()).width).toBe(7000);
    // an ordinary image still uploads
    expect((await c.http.post(`${API}/files`).set(bearer(B.token)).attach('file', PNG_1PX, 'ok.png')).status).toBe(201);
  });

  it('uploads over 25 MB get 413; directory traversal in the name is neutralised', async () => {
    const big = await c.http.post(`${API}/files`).set(bearer(B.token)).attach('file', Buffer.alloc(25 * 1024 * 1024 + 10, 0x41), 'big.txt');
    expect(big.status).toBe(413);
    const trav = await mustOk(c.http.post(`${API}/files`).set(bearer(B.token)).attach('file', PNG_1PX, '../../../etc/passwd.png'), 201);
    expect(trav.filename).not.toContain('/');
  });
});

describe('ReDoS in form-designer patterns', () => {
  it('boundedTest interrupts catastrophic backtracking', () => {
    const t0 = Date.now();
    expect(boundedTest(/^(?:(a+)+b)$/, `${'a'.repeat(40)}!`)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(boundedTest(/^(?:[A-Z]{3}\d{2})$/, 'ABC12')).toBe(true);
    expect(boundedTest(/^(?:[A-Z]{3}\d{2})$/, 'abc')).toBe(false);
  });

  it('[SEC8-003] a record save against an evil `regex` field pattern answers 400 fast and the API stays responsive', async () => {
    await createMaster(c, B.token, `rx_${uid(4)}`.toLowerCase(), [{ key: 'ref', type: 'regex', label: 'Ref', pattern: '(a+)+b' }]).then(async m => {
      const t0 = Date.now();
      const res = await c.http.post(`${API}/masters/${m.key}/records`).set(bearer(B.token)).send({ code: `X${uid(4)}`, name: 'x', data: { ref: `${'a'.repeat(40)}!` } });
      expect(res.status).toBe(400);
      expect(res.body.errors?.[0]?.message).toMatch(/too complex/);
      expect(Date.now() - t0).toBeLessThan(3000);
      const ok = await c.http.post(`${API}/masters/${m.key}/records`).set(bearer(B.token)).send({ code: `Y${uid(4)}`, name: 'y', data: { ref: 'aaab' } });
      expect(ok.status, ok.text).toBe(201);
    });
  });
});

describe('mass assignment, error leakage, headers', () => {
  it('server-owned fields in create/update bodies are ignored', async () => {
    const forged = {
      id: '11111111-1111-4111-8111-111111111111', tenantId: A.tenantId, tenant_id: A.tenantId, status: 'approved', statusKey: 'approved', status_key: 'approved',
      number: 'FORGED-1', createdBy: A.adminId, created_by: A.adminId, totalAmount: '1', version: 99,
    };
    const res = await c.http.post(`${API}/docs/capex`).set(bearer(B.token))
      .send({ ...forged, values: { location: B.loc, purpose: 'mass assignment', doc_date: '2026-10-01', status_key: 'approved', number: 'X' }, lines: [{ values: { item: B.item, qty: '1', est_rate: '5' } }] });
    expect(res.status).toBeLessThan(500);
    if (res.status === 201) {
      const row = await c.db.selectFrom('app.document').select(['id', 'tenant_id', 'status_key', 'number', 'created_by']).where('id', '=', res.body.id).executeTakeFirstOrThrow();
      expect(row.id).not.toBe(forged.id);
      expect(row.tenant_id).toBe(B.tenantId);
      expect(row.status_key).toBe('draft');
      expect(row.number).not.toBe('FORGED-1');
      expect(row.created_by).toBe(B.adminId);
    }
    const u = await restrictedUser(c, B.code, B.token);
    const me = await c.http.put(`${API}/users/${u.id}`).set(bearer(B.token)).send({ name: 'Renamed', tenantId: A.tenantId, isTenantAdmin: true, passwordHash: 'x', is_tenant_admin: true });
    expect(me.status).toBeLessThan(500);
    const row = await c.db.selectFrom('app.tenant_user').select(['tenant_id', 'is_tenant_admin', 'password_hash']).where('id', '=', u.id).executeTakeFirstOrThrow();
    expect(row.tenant_id).toBe(B.tenantId);
    expect(row.is_tenant_admin).toBe(false);
    expect(row.password_hash).not.toBe('x');
  });

  it('malformed JSON, oversize bodies, bad ids and unknown routes leak no internals', async () => {
    const bad = await c.http.post(`${API}/docs/capex`).set(bearer(B.token)).set('Content-Type', 'application/json').send('{"values": ');
    expect(bad.status).toBe(400);
    const big = await c.http.post(`${API}/docs/capex`).set(bearer(B.token)).send({ x: 'a'.repeat(1_100_000) });
    expect(big.status).toBe(413);
    for (const r of [bad, big, await c.http.get(`${API}/docs/capex/not-a-uuid`).set(bearer(B.token)), await c.http.get(`${API}/nope`).set(bearer(B.token))]) {
      expect(r.status).toBeLessThan(500);
      expect(r.text).not.toMatch(/node_modules|\/src\/|at \w+ \(|stack|SELECT|kysely/i);
    }
  });

  it('security headers on API responses; no X-Powered-By', async () => {
    const res = await c.http.get(`${API}/auth/me`).set(bearer(B.token));
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d{7,}/);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'self'/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('CORS: only the configured web origin is reflected, with credentials', async () => {
    const evil = await c.http.options(`${API}/auth/me`).set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const origin = config.webOrigin[0]!;
    const good = await c.http.options(`${API}/auth/me`).set('Origin', origin).set('Access-Control-Request-Method', 'GET');
    expect(good.headers['access-control-allow-origin']).toBe(origin);
    expect(good.headers['access-control-allow-credentials']).toBe('true');
  });

  it('[SEC8-008] X-Request-Id from the client is only kept when short and plain', async () => {
    const { requestStore } = await import('../src/core/request-context');
    const seen: string[] = [];
    const orig = requestStore.run.bind(requestStore);
    (requestStore as { run: typeof requestStore.run }).run = ((store: { requestId: string }, cb: () => unknown) => { seen.push(store.requestId); return orig(store as never, cb); }) as never;
    try {
      await c.http.get('/health').set('X-Request-Id', `abc <script> ${'x'.repeat(300)}`);
      await c.http.get('/health').set('X-Request-Id', 'req-123.abc');
    } finally { (requestStore as { run: typeof requestStore.run }).run = orig; }
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]).toBe('req-123.abc');
  });
});

describe('secrets at rest and audit integrity', () => {
  it('passwords are argon2id, refresh tokens are stored as sha256 only, webhook secrets are AES-GCM encrypted', async () => {
    const u = await c.db.selectFrom('app.tenant_user').select('password_hash').where('id', '=', B.adminId).executeTakeFirstOrThrow();
    expect(u.password_hash).toMatch(/^\$argon2id\$/);
    const s = await c.db.selectFrom('platform.auth_session').select('refresh_hash').where('subject_id', '=', B.adminId).limit(1).executeTakeFirstOrThrow();
    expect(s.refresh_hash).toMatch(/^[0-9a-f]{64}$/);
    const ep = await c.http.post(`${API}/config/webhooks`).set(bearer(B.token)).send({ url: 'https://93.184.216.34/hook', events: ['document.submitted'] });
    if (ep.status === 201) {
      expect(ep.body.secret).toMatch(/^whsec_/);
      const row = await c.db.selectFrom('app.webhook_endpoint').select('secret').where('id', '=', ep.body.id).executeTakeFirstOrThrow();
      expect(row.secret).toMatch(/^v1:/);
      expect(row.secret).not.toContain(ep.body.secret);
      const again = await mustOk(c.http.get(`${API}/config/webhooks/${ep.body.id}`).set(bearer(B.token)));
      expect(again.secret).toBeUndefined();
    }
  });

  it('[SEC8-007] audit logs are append-only for both application roles', async () => {
    const { Client } = await import('pg');
    for (const [url, table] of [[process.env.DATABASE_URL!, 'app.audit_log'], [process.env.DATABASE_PLATFORM_URL!, 'platform.audit_log'], [process.env.DATABASE_PLATFORM_URL!, 'app.audit_log']] as const) {
      const cl = new Client({ connectionString: url });
      await cl.connect();
      try {
        for (const stmt of [`update ${table} set action = 'x' where false`, `delete from ${table} where false`]) {
          await expect(cl.query(stmt), `${url.split('@')[0]} ${stmt}`).rejects.toThrow(/permission denied/);
        }
      } finally { await cl.end(); }
    }
  });

  it('audit verification detects an edited row', async () => {
    const last = await c.db.selectFrom('app.audit_log').select(['id', 'action']).where('tenant_id', '=', B.tenantId).orderBy('id', 'desc').limit(1).executeTakeFirstOrThrow();
    const clean = await mustOk(c.http.post(`${API}/audit/checks`).set(bearer(B.token)).send({}), 200, 201);
    expect(JSON.stringify(clean)).not.toMatch(/"(ok|valid)":false|broken|mismatch/i);
    await c.db.updateTable('app.audit_log').set({ action: `${last.action}_tampered` }).where('id', '=', last.id).execute();
    const dirty = await mustOk(c.http.post(`${API}/audit/checks`).set(bearer(B.token)).send({}), 200, 201);
    expect(JSON.stringify(dirty)).not.toEqual(JSON.stringify(clean));
    expect(JSON.stringify(dirty)).toMatch(new RegExp(String(last.id)));
    await c.db.updateTable('app.audit_log').set({ action: last.action }).where('id', '=', last.id).execute();
  });

  it('[SEC8-015] the chain is keyed (HMAC-SHA256): legacy plain rows verify only before keyed rows; a DB writer cannot forge rows; key rotation', async () => {
    const { sql } = await import('kysely');
    const { chainHash } = await import('../src/core/audit.service');
    const { AuditVerifier } = await import('../src/modules/documents');
    const v = c.app.get(AuditVerifier);
    const t = await createTenant(c, platform.token, planId);
    const admin = await activeTenantAdmin(c, t);
    const chain = async () => (await sql<Record<string, unknown> & { id: string; hash: string; hash_alg: string }>`
      select id, actor_id, impersonated_by, action, entity, entity_id, before, after, ip::text as ip, user_agent, at, prev_hash, hash, hash_alg
        from app.audit_log where tenant_id = ${t.tenantId} order by id`.execute(c.db)).rows;
    const tail = async () => (await chain()).at(-1)!;
    const forge = async (alg: 'sha256' | 'hmac-sha256', key?: string) => {
      const last = await tail();
      const row = { actor_id: null, impersonated_by: null, action: 'forged', entity: 'user', entity_id: null, before: null, after: JSON.stringify({ isTenantAdmin: true }), ip: null, user_agent: null, at: new Date().toISOString() };
      const ins = await sql<{ id: string }>`insert into app.audit_log (tenant_id, actor_id, impersonated_by, action, entity, entity_id, before, after, ip, user_agent, at, prev_hash, hash, hash_alg)
        values (${t.tenantId}, null, null, ${row.action}, ${row.entity}, null, null, ${row.after}::jsonb, null, null, ${row.at}, ${last.hash}, ${chainHash(last.hash, row, false, alg, key)}, ${alg}) returning id`.execute(c.db);
      return ins.rows[0]!.id;
    };
    let rows = await chain();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.hash_alg === 'hmac-sha256')).toBe(true);
    expect((await v.verifyTenant(t.tenantId)).ok).toBe(true);
    // (1) downgrade: a row appended with a correctly linked plain SHA-256 hash is refused
    let forged = await forge('sha256');
    let r = await v.verifyTenant(t.tenantId);
    expect(r).toMatchObject({ ok: false, firstBadId: String(forged) });
    expect(r.detail).toMatch(/unkeyed hash after keyed rows/);
    await sql`delete from app.audit_log where id = ${forged}`.execute(c.db);
    // (2) a keyed row under a guessed key does not verify
    forged = await forge('hmac-sha256', 'attacker-guess-attacker-guess-attacker-guess');
    r = await v.verifyTenant(t.tenantId);
    expect(r).toMatchObject({ ok: false, firstBadId: String(forged) });
    expect(r.detail).toMatch(/hash mismatch/);
    await sql`delete from app.audit_log where id = ${forged}`.execute(c.db);
    expect((await v.verifyTenant(t.tenantId)).ok).toBe(true);
    // (3) legacy chain (rows written before 0022: plain SHA-256, marker 'sha256') verifies, and keyed rows continue it
    let prev: string | null = null;
    for (const row of rows) {
      const { id, hash: _h, hash_alg: _a, prev_hash: _p, ...rest } = row;
      const h = chainHash(prev, rest, true, 'sha256');
      await sql`update app.audit_log set prev_hash = ${prev}, hash = ${h}, hash_alg = 'sha256' where id = ${id}`.execute(c.db);
      prev = h;
    }
    expect((await v.verifyTenant(t.tenantId)).ok).toBe(true);
    await mustOk(api(c, admin.token).post('/locations', { code: `K${uid(4)}`, name: 'Keyed after legacy' }), 201);
    rows = await chain();
    expect(rows.at(-1)!.hash_alg).toBe('hmac-sha256');
    expect(rows.filter(x => x.hash_alg === 'sha256').length).toBeGreaterThan(0);
    expect((await v.verifyTenant(t.tenantId)).ok).toBe(true);
    forged = await forge('sha256');
    expect((await v.verifyTenant(t.tenantId)).firstBadId).toBe(String(forged));
    await sql`delete from app.audit_log where id = ${forged}`.execute(c.db);
    // (4) rotation: rows under the old key verify while it is listed in AUDIT_HASH_KEY_PREVIOUS
    const cfg = config.audit as { hashKey: string; previousHashKeys: string[] };
    const [oldKey, oldPrev] = [cfg.hashKey, [...cfg.previousHashKeys]];
    try {
      cfg.hashKey = 'rotated-audit-key-rotated-audit-key-0123456789';
      await mustOk(api(c, admin.token).post('/locations', { code: `R${uid(4)}`, name: 'After rotation' }), 201);
      expect((await v.verifyTenant(t.tenantId)).detail).toMatch(/hash mismatch/);
      cfg.previousHashKeys.push(oldKey);
      expect((await v.verifyTenant(t.tenantId)).ok).toBe(true);
    } finally {
      cfg.hashKey = oldKey;
      cfg.previousHashKeys.splice(0, cfg.previousHashKeys.length, ...oldPrev);
    }
  });
});

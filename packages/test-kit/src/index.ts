/**
 * @procure/test-kit — a small, dependency-free fixture builder for Procure tests.
 *
 * Works over any HTTP "transport", so the same fixtures run in:
 *   - API integration tests (vitest + supertest against an in-process Nest app) → `supertestTransport(http)`
 *   - Playwright E2E / smoke scripts against a running API                      → `fetchTransport('http://localhost:4000')`
 *
 * Everything goes through the public Phase 1 API (docs/contracts/phase-1-api.md). The only thing the API
 * cannot do is create a platform (Super Admin) user; for that pass an existing login (e.g. the seed owner)
 * or a `createPlatformUser` hook that inserts one directly as the DB owner.
 *
 * Later phases: add builders here (locations, vendors, documents…) rather than in each test file.
 */
import { randomUUID } from 'node:crypto';

export const API_PREFIX = '/api/v1';

// ------------------------------------------------------------------ transport

export interface TkResponse {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string | string[] | undefined>;
}

export interface TkRequest {
  token?: string;
  body?: unknown;
  cookie?: string;
  query?: Record<string, string | number | boolean>;
}

export type Transport = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, req?: TkRequest) => Promise<TkResponse>;

function withQuery(path: string, q?: TkRequest['query']) {
  if (!q || !Object.keys(q).length) return path;
  const s = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
  return `${path}${path.includes('?') ? '&' : '?'}${s}`;
}

/** Global fetch transport (Node 18+). `baseUrl` is the API origin, e.g. http://localhost:4000. */
export function fetchTransport(baseUrl: string): Transport {
  return async (method, path, req = {}) => {
    const headers: Record<string, string> = {};
    if (req.token) headers.authorization = `Bearer ${req.token}`;
    if (req.cookie) headers.cookie = req.cookie;
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${baseUrl}${API_PREFIX}${withQuery(path, req.query)}`, {
      method, headers, body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    const h: Record<string, string | string[]> = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    const setCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
    if (setCookie?.length) h['set-cookie'] = setCookie;
    return { status: res.status, body, headers: h };
  };
}

/** Minimal shape of a supertest agent (`request(app.getHttpServer())`), so we don't depend on supertest. */
interface SupertestLike {
  get(p: string): SupertestReq; post(p: string): SupertestReq; put(p: string): SupertestReq; delete(p: string): SupertestReq;
}
interface SupertestReq extends PromiseLike<{ status: number; body: unknown; headers: Record<string, string | string[] | undefined> }> {
  set(k: string, v: string): SupertestReq;
  send(b: unknown): SupertestReq;
  query(q: Record<string, unknown>): SupertestReq;
}

export function supertestTransport(http: SupertestLike): Transport {
  return async (method, path, req = {}) => {
    const m = method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
    let r = http[m](`${API_PREFIX}${path}`);
    if (req.token) r = r.set('Authorization', `Bearer ${req.token}`);
    if (req.cookie) r = r.set('Cookie', req.cookie);
    if (req.query) r = r.query(req.query);
    if (req.body !== undefined) r = r.send(req.body);
    const res = await r;
    return { status: res.status, body: res.body, headers: res.headers };
  };
}

// ------------------------------------------------------------------ helpers

export const uid = (n = 8) => randomUUID().replace(/-/g, '').slice(0, n);
export const today = () => new Date().toISOString().slice(0, 10);

export function refreshCookieOf(res: TkResponse): string | undefined {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find(x => x.startsWith('rt='))?.split(';')[0];
}

export class FixtureError extends Error {
  constructor(what: string, readonly res: TkResponse) {
    super(`${what} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
}

function expectStatus(what: string, res: TkResponse, ...ok: number[]) {
  if (!ok.includes(res.status)) throw new FixtureError(what, res);
  return res;
}

// ------------------------------------------------------------------ fixture types

export interface Session { token: string; userId: string; cookie?: string; mustChangePassword: boolean; raw: any } // eslint-disable-line @typescript-eslint/no-explicit-any
export interface PlanFixture { id: string; code: string; name: string; version: number; features: string[]; limits: Record<string, number | null> }
export interface TenantFixture { tenantId: string; code: string; name: string; adminEmail: string; temporaryPassword: string; planId: string }
export interface UserFixture { id: string; email: string; name: string; version: number; temporaryPassword: string; raw: any } // eslint-disable-line @typescript-eslint/no-explicit-any

export interface PlanSpec {
  code?: string; name?: string; price?: number; features?: string[]; limits?: Record<string, number | null>;
  [k: string]: unknown;
}
export interface TenantSpec {
  code?: string; name?: string; adminEmail?: string; adminName?: string;
  subscriptionStatus?: 'trial' | 'active' | 'grace' | 'expired' | 'suspended';
  [k: string]: unknown;
}

export const DEFAULT_ADMIN_PASSWORD = 'NewAdmin@12345';
export const DEFAULT_USER_PASSWORD = 'NewUser@12345';

export interface KitOptions {
  /**
   * Called when `platformSession()` has no explicit credentials: must create an owner platform user
   * (e.g. a direct insert as the DB owner) and return its email + password.
   */
  createPlatformUser?: (role: 'owner' | 'support' | 'billing') => Promise<{ email: string; password: string }>;
}

// ------------------------------------------------------------------ the kit

export class TestKit {
  constructor(readonly t: Transport, private readonly opts: KitOptions = {}) {}

  // ---- auth
  async platformLogin(email: string, password: string): Promise<Session> {
    const res = expectStatus('platform login', await this.t('POST', '/auth/platform/login', { body: { email, password } }), 200);
    return { token: res.body.accessToken, userId: res.body.principal.userId, cookie: refreshCookieOf(res), mustChangePassword: res.body.mustChangePassword, raw: res.body };
  }

  /** Logs in as a Super Admin. Uses given credentials or the `createPlatformUser` hook. */
  async platformSession(creds?: { email: string; password: string }, role: 'owner' | 'support' | 'billing' = 'owner'): Promise<Session> {
    let c = creds;
    if (!c) {
      if (!this.opts.createPlatformUser) throw new Error('TestKit: pass platform credentials or a createPlatformUser hook');
      c = await this.opts.createPlatformUser(role);
    }
    return this.platformLogin(c.email, c.password);
  }

  async tenantLogin(tenantCode: string, email: string, password: string): Promise<Session> {
    const res = expectStatus('tenant login', await this.t('POST', '/auth/login', { body: { tenantCode, email, password } }), 200);
    return { token: res.body.accessToken, userId: res.body.principal.userId, cookie: refreshCookieOf(res), mustChangePassword: res.body.mustChangePassword, raw: res.body };
  }

  async changePassword(s: Session, currentPassword: string, newPassword: string): Promise<Session> {
    const res = expectStatus('password change', await this.t('POST', '/auth/password/change', { token: s.token, body: { currentPassword, newPassword } }), 200);
    return { ...s, token: res.body.accessToken, mustChangePassword: false, raw: res.body };
  }

  // ---- platform
  async plan(platformToken: string, spec: PlanSpec = {}): Promise<PlanFixture> {
    const body = { code: `plan-${uid()}`, name: `Plan ${uid(4)}`, price: 1000, features: ['indent', 'purchase'], limits: { max_users: 10 }, ...spec };
    const res = expectStatus('create plan', await this.t('POST', '/platform/plans', { token: platformToken, body }), 201);
    return res.body;
  }

  async tenant(platformToken: string, planId: string, spec: TenantSpec = {}): Promise<TenantFixture> {
    const { code: c, name: n, adminEmail: ae, adminName, subscriptionStatus, ...extra } = spec;
    const code = c ?? `t-${uid()}`;
    const name = n ?? `Tenant ${code}`;
    const adminEmail = ae ?? `admin@${code}.test`;
    const res = expectStatus('create tenant', await this.t('POST', '/platform/tenants', {
      token: platformToken,
      body: {
        code, name, planId,
        subscription: { status: subscriptionStatus ?? 'active', startDate: today() },
        admin: { name: adminName ?? 'Tenant Admin', email: adminEmail },
        ...extra,
      },
    }), 201);
    return { tenantId: res.body.tenantId, code, name, adminEmail, temporaryPassword: res.body.temporaryPassword, planId };
  }

  async setOverride(platformToken: string, tenantId: string, o: { kind: 'limit' | 'feature'; key: string; value?: unknown; remove?: boolean; reason: string }) {
    return expectStatus('set override', await this.t('PUT', `/platform/tenants/${tenantId}/overrides`, { token: platformToken, body: o }), 200).body;
  }

  /** Logs the tenant admin in with the temp password and changes it. */
  async activeAdmin(t: TenantFixture, newPassword = DEFAULT_ADMIN_PASSWORD): Promise<Session> {
    const first = await this.tenantLogin(t.code, t.adminEmail, t.temporaryPassword);
    const s = await this.changePassword(first, t.temporaryPassword, newPassword);
    return s;
  }

  /** Plan + tenant + active admin. */
  async tenantWithAdmin(platformToken: string, plan: PlanSpec = {}, tenant: TenantSpec = {}) {
    const p = await this.plan(platformToken, plan);
    const t = await this.tenant(platformToken, p.id, tenant);
    const admin = await this.activeAdmin(t);
    return { plan: p, tenant: t, admin };
  }

  // ---- tenant
  async user(adminToken: string, extra: Record<string, unknown> = {}): Promise<UserFixture> {
    const res = expectStatus('create user', await this.t('POST', '/users', {
      token: adminToken, body: { name: `User ${uid(4)}`, email: `u-${uid()}@example.test`, ...extra },
    }), 201);
    const u = res.body.user;
    return { id: u.id, email: u.email, name: u.name, version: u.version, temporaryPassword: res.body.temporaryPassword, raw: u };
  }

  /** Raw create (no status check) — for limit tests. */
  createUserRaw(adminToken: string, extra: Record<string, unknown> = {}) {
    return this.t('POST', '/users', { token: adminToken, body: { name: `User ${uid(4)}`, email: `u-${uid()}@example.test`, ...extra } });
  }

  async role(adminToken: string, key = `r_${uid(6)}`, name = `Role ${uid(4)}`) {
    return expectStatus('create role', await this.t('POST', '/roles', { token: adminToken, body: { key, name } }), 201).body as { id: string; key: string; name: string };
  }

  async notifications(token: string, query: TkRequest['query'] = {}) {
    return expectStatus('list notifications', await this.t('GET', '/notifications', { token, query }), 200).body as { data: any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  async impersonate(platformToken: string, tenantId: string, reason = 'QA test'): Promise<Session> {
    const res = expectStatus('impersonate', await this.t('POST', `/platform/tenants/${tenantId}/impersonate`, { token: platformToken, body: { reason } }), 200);
    return { token: res.body.accessToken, userId: res.body.principal.userId, cookie: refreshCookieOf(res), mustChangePassword: false, raw: res.body };
  }

  // ---- Phase 2: raw calls, forms, masters, records, permissions, locations (docs/contracts/phase-2-api.md)

  /** Raw call, no status check. */
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, token: string, body?: unknown, query?: TkRequest['query']) {
    return this.t(method, path, { token, body, query });
  }

  /** Call that must answer with one of `ok` (default 200/201/204); returns the body. */
  async ok<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, token: string, body?: unknown, ...ok: number[]): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return expectStatus(`${method} ${path}`, await this.t(method, path, { token, body }), ...(ok.length ? ok : [200, 201, 204])).body as T;
  }

  /** Plan with the form builder + tenant + active admin (Phase 2 defaults: generous limits). */
  builderTenant(platformToken: string, limits: Record<string, number | null> = {}, tenant: TenantSpec = {}) {
    return this.tenantWithAdmin(platformToken, {
      features: ['indent', 'purchase', 'form_builder'],
      limits: { max_users: 50, custom_forms: 20, storage_gb: 1, max_locations: 50, ...limits },
    }, tenant);
  }

  /** POST /config/masters (fields besides code/name optional). */
  createMaster(token: string, key: string, fields: unknown[] = [], extra: Record<string, unknown> = {}) {
    const label = key.replace(/_/g, ' ');
    return this.ok('POST', '/config/masters', token, {
      key, name: label, pluralName: `${label}s`, ...(fields.length ? { definition: { fields } } : {}), ...extra,
    }, 201);
  }

  /** Saves `fields` as the draft of `formKey` and publishes it. Returns the raw publish response. */
  async publishForm(token: string, formKey: string, fields: unknown[], validations: unknown[] = [], changeNote?: string) {
    const d = await this.ok('GET', `/config/forms/${formKey}`, token);
    const saved = await this.ok('PUT', `/config/forms/${formKey}/draft`, token, { definition: { fields, validations }, version: d.version });
    return this.t('POST', `/config/forms/${formKey}/publish`, { token, body: { version: saved.version, ...(changeNote ? { changeNote } : {}) } });
  }

  /** Current published fields of a form (without layout-agnostic filtering). */
  async formFields(token: string, formKey: string): Promise<any[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return (await this.ok('GET', `/config/forms/${formKey}`, token)).published?.fields ?? [];
  }

  record(token: string, master: string, body: { code?: string; name: string; data?: Record<string, unknown> }) {
    return this.ok('POST', `/masters/${master}/records`, token, { data: {}, ...body }, 201);
  }

  async records(token: string, master: string, query: TkRequest['query'] = {}): Promise<{ data: any[]; nextCursor: string | null }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return expectStatus(`list ${master}`, await this.t('GET', `/masters/${master}/records`, { token, query }), 200).body;
  }

  /** Code → id map of a master's records (all views). */
  async recordIds(token: string, master: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let cursor: string | null = null;
    do {
      const page = await this.records(token, master, { view: 'all', limit: 200, ...(cursor ? { cursor } : {}) });
      for (const r of page.data) out[r.code] = r.id;
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  /** Role whose grants are exactly `keys` (grouped per tab) plus optional per-tab field access; returns the role. */
  async roleWithKeys(adminToken: string, keys: string[], fieldAccess: Record<string, { formKey: string; fieldKey: string; mode: 'hidden' | 'readonly' }[]> = {}, name = `QA role ${uid(4)}`) {
    const role = await this.role(adminToken, `r_${uid(6)}`, name);
    const byTab = new Map<string, { actions: string[]; views: string[] }>();
    for (const k of keys) {
      const [tab, rest = ''] = k.split(':');
      const e = byTab.get(tab!) ?? { actions: [], views: [] };
      (rest.startsWith('view.') ? e.views : e.actions).push(k);
      byTab.set(tab!, e);
    }
    for (const tab of Object.keys(fieldAccess)) if (!byTab.has(tab)) byTab.set(tab, { actions: [], views: [] });
    for (const [tab, e] of byTab) await this.ok('PUT', `/roles/${role.id}/permissions/tabs/${tab}`, adminToken, { ...e, fieldAccess: fieldAccess[tab] ?? [] });
    return role;
  }

  /** Creates a user with `roleIds`, signs in, changes the temp password; returns a ready session + user id. */
  async signedInUser(tenantCode: string, adminToken: string, roleIds: string[] = [], extra: Record<string, unknown> = {}, password = DEFAULT_USER_PASSWORD) {
    const u = await this.user(adminToken, { roleIds, ...extra });
    const first = await this.tenantLogin(tenantCode, u.email, u.temporaryPassword);
    const s = await this.changePassword(first, u.temporaryPassword, password);
    return { ...s, id: u.id, email: u.email, password };
  }

  // ---- locations
  async location(token: string, code: string, name: string, parentId: string | null = null) {
    return this.ok('POST', '/locations', token, { code, name, parentId }, 201) as Promise<{ id: string; version: number; code: string }>;
  }

  async locationTree(token: string, query: TkRequest['query'] = { view: 'all' }): Promise<any[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
    return expectStatus('location tree', await this.t('GET', '/locations/tree', { token, query }), 200).body;
  }
}

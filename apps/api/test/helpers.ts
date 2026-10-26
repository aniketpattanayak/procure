/**
 * Shared integration-test helpers (vitest + supertest against the real procure_test DB).
 * Reusable by the QA agent: boot the app once per file, create plans/tenants/users via the API,
 * and log in as any audience.
 */
import type { INestApplication } from '@nestjs/common';
import type { AuthResult, PlanInput } from '@procure/schema';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import type { DB } from '../src/core/db-types';
import { hashPassword } from '../src/modules/identity/passwords';

export const API = '/api/v1';

export interface Ctx {
  app: INestApplication;
  http: ReturnType<typeof request>;
  /** Superuser connection for setup/assertions that bypass the API (never used by the app). */
  db: Kysely<DB>;
}

export async function bootApp(): Promise<Ctx> {
  const app = await createApp();
  await app.init();
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, max: 3 }) }) });
  return { app, http: request(app.getHttpServer()), db };
}

export async function closeApp(c: Ctx) {
  await c.db.destroy();
  await c.app.close();
}

export const uid = (n = 8) => randomUUID().replace(/-/g, '').slice(0, n);
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Extracts the `rt=...` cookie pair from a response (for /auth/refresh). */
export function refreshCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = list.find(x => x.startsWith('rt='));
  if (!c) throw new Error('no rt cookie in response');
  return c.split(';')[0]!;
}

// ---------------------------------------------------------------- platform users

export interface PlatformLogin { token: string; result: AuthResult; cookie: string; userId: string }

/** Creates a platform user directly in the DB (the API has no platform-user CRUD in Phase 1). */
export async function createPlatformUser(c: Ctx, role: 'owner' | 'support' | 'billing' = 'owner', password = 'Owner@12345') {
  const email = `pu-${uid()}@procure.test`;
  const row = await c.db.insertInto('platform.platform_user')
    .values({ email, name: `Platform ${role}`, role, password_hash: await hashPassword(password), must_change_password: false })
    .returning('id').executeTakeFirstOrThrow();
  return { id: row.id, email, password };
}

export async function platformLogin(c: Ctx, email: string, password: string): Promise<PlatformLogin> {
  const res = await c.http.post(`${API}/auth/platform/login`).send({ email, password });
  if (res.status !== 200) throw new Error(`platform login failed ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken, result: res.body, cookie: refreshCookie(res), userId: res.body.principal.userId };
}

/** New owner-role platform user, logged in. */
export async function superAdmin(c: Ctx, role: 'owner' | 'support' | 'billing' = 'owner'): Promise<PlatformLogin> {
  const u = await createPlatformUser(c, role);
  return platformLogin(c, u.email, u.password);
}

// ---------------------------------------------------------------- plans & tenants

export async function createPlan(c: Ctx, token: string, overrides: Partial<PlanInput> = {}) {
  const body = {
    code: `plan-${uid()}`, name: `Plan ${uid(4)}`, price: 1000,
    features: ['indent', 'purchase'], limits: { max_users: 10 },
    ...overrides,
  };
  const res = await c.http.post(`${API}/platform/plans`).set(bearer(token)).send(body);
  if (res.status !== 201) throw new Error(`create plan failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; code: string; version: number; features: string[]; limits: Record<string, number | null> };
}

export interface TenantFixture {
  tenantId: string;
  code: string;
  adminEmail: string;
  temporaryPassword: string;
}

export async function createTenant(c: Ctx, token: string, planId: string, extra: Record<string, unknown> = {}): Promise<TenantFixture> {
  const code = `t-${uid()}`;
  const adminEmail = `admin@${code}.test`;
  const res = await c.http.post(`${API}/platform/tenants`).set(bearer(token)).send({
    code, name: `Tenant ${code}`, planId,
    subscription: { status: 'active', startDate: new Date().toISOString().slice(0, 10) },
    admin: { name: 'Tenant Admin', email: adminEmail },
    ...extra,
  });
  if (res.status !== 201) throw new Error(`create tenant failed ${res.status} ${JSON.stringify(res.body)}`);
  return { tenantId: res.body.tenantId, code, adminEmail, temporaryPassword: res.body.temporaryPassword };
}

export interface TenantLogin { token: string; result: AuthResult; cookie: string; userId: string }

export async function tenantLogin(c: Ctx, tenantCode: string, email: string, password: string): Promise<TenantLogin> {
  const res = await c.http.post(`${API}/auth/login`).send({ tenantCode, email, password });
  if (res.status !== 200) throw new Error(`tenant login failed ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken, result: res.body, cookie: refreshCookie(res), userId: res.body.principal.userId };
}

export const NEW_ADMIN_PASSWORD = 'NewAdmin@12345';

/** Logs the tenant admin in with the temp password and changes it; returns a ready-to-use session. */
export async function activeTenantAdmin(c: Ctx, t: TenantFixture): Promise<TenantLogin> {
  const first = await tenantLogin(c, t.code, t.adminEmail, t.temporaryPassword);
  const res = await c.http.post(`${API}/auth/password/change`).set(bearer(first.token))
    .send({ currentPassword: t.temporaryPassword, newPassword: NEW_ADMIN_PASSWORD });
  if (res.status !== 200) throw new Error(`password change failed ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken, result: res.body, cookie: first.cookie, userId: first.userId };
}

/** Plan + tenant + logged-in admin (password already changed) in one call. */
export async function tenantWithAdmin(c: Ctx, platformToken: string, plan: Partial<PlanInput> = {}) {
  const p = await createPlan(c, platformToken, plan);
  const t = await createTenant(c, platformToken, p.id);
  const admin = await activeTenantAdmin(c, t);
  return { plan: p, tenant: t, admin };
}

/** Creates a tenant user via the API as the given admin; returns the user + temp password. */
export async function createUser(c: Ctx, adminToken: string, extra: Record<string, unknown> = {}) {
  const res = await c.http.post(`${API}/users`).set(bearer(adminToken)).send({ name: `User ${uid(4)}`, email: `u-${uid()}@example.test`, ...extra });
  return res;
}

// ---------------------------------------------------------------- background jobs (Phase 3, ADR-0012)

/**
 * Starts the queue workers inside the test app (processors + repeatables registered by modules), as the API does
 * with RUN_WORKERS=inline. Call after bootApp() in suites that need jobs to run (outbox relay, SLA, audit-verify).
 */
export async function startWorkers(c: Ctx) {
  const { QueueService } = await import('../src/core/queue.service');
  await c.app.get(QueueService).startWorkers();
}

/** Waits until the named queues have no waiting/active jobs (repeatables excluded). */
export async function drainQueues(c: Ctx, queues: string[] = ['outbox', 'events'], timeoutMs = 10000) {
  const { QueueService } = await import('../src/core/queue.service');
  await c.app.get(QueueService).drain(queues, timeoutMs);
}

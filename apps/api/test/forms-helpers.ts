/**
 * Helpers for the form & master engine suites (forms*, masters*, records*, files*, templates*).
 */
import { API, bearer, createUser, Ctx, superAdmin, tenantLogin, tenantWithAdmin, uid } from './helpers';

export const FULL_FEATURES = ['indent', 'purchase', 'form_builder'];

/** Tenant on a plan with the form builder, ample limits; admin logged in. */
export async function builderTenant(c: Ctx, limits: Record<string, number | null> = {}) {
  const sa = await superAdmin(c);
  const t = await tenantWithAdmin(c, sa.token, {
    features: FULL_FEATURES, limits: { max_users: 50, custom_forms: 20, storage_gb: 1, max_locations: 10, ...limits },
  });
  return { ...t, sa, token: t.admin.token };
}

export const api = (c: Ctx, token: string) => ({
  get: (p: string) => c.http.get(`${API}${p}`).set(bearer(token)),
  post: (p: string, body?: unknown) => c.http.post(`${API}${p}`).set(bearer(token)).send(body as object),
  put: (p: string, body?: unknown) => c.http.put(`${API}${p}`).set(bearer(token)).send(body as object),
  del: (p: string, body?: unknown) => c.http.delete(`${API}${p}`).set(bearer(token)).send(body as object),
});

export async function mustOk<T = any>(res: Promise<{ status: number; body: any }> | { status: number; body: any }, ...ok: number[]): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await res;
  const want = ok.length ? ok : [200, 201];
  if (!want.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

/** Creates a custom master via the API. */
export async function createMaster(c: Ctx, token: string, key: string, fields: unknown[] = [], extra: Record<string, unknown> = {}) {
  return mustOk(api(c, token).post('/config/masters', {
    key, name: key.replace(/_/g, ' '), pluralName: `${key.replace(/_/g, ' ')}s`,
    ...(fields.length ? { definition: { fields } } : {}), ...extra,
  }), 201);
}

/** Draft + publish in one go (fetches the row version first). */
export async function publish(c: Ctx, token: string, formKey: string, fields: unknown[], validations: unknown[] = []) {
  const a = api(c, token);
  const d = await mustOk(a.get(`/config/forms/${formKey}`));
  const saved = await mustOk(a.put(`/config/forms/${formKey}/draft`, { definition: { fields, validations }, version: d.version }));
  return a.post(`/config/forms/${formKey}/publish`, { version: saved.version });
}

export async function addRecord(c: Ctx, token: string, master: string, body: Record<string, unknown>) {
  return mustOk(api(c, token).post(`/masters/${master}/records`, { data: {}, ...body }), 201);
}

/** A non-admin user with a role holding `keys`; returns a logged-in session (password changed). */
export async function userWithKeys(c: Ctx, adminToken: string, tenantCode: string, keys: string[], extra: Record<string, unknown> = {}) {
  const a = api(c, adminToken);
  const role = await mustOk(a.post('/roles', { key: `r_${uid(6)}`, name: `Role ${uid(4)}` }), 201);
  const byTab = new Map<string, { actions: string[]; views: string[] }>();
  for (const k of keys) {
    const tab = k.split(':')[0]!;
    const e = byTab.get(tab) ?? { actions: [], views: [] };
    if (k.includes(':view.')) e.views.push(k);
    else if (k.includes(':action.')) e.actions.push(k);
    byTab.set(tab, e);
  }
  for (const [tab, e] of byTab) await mustOk(a.put(`/roles/${role.id}/permissions/tabs/${tab}`, { ...e, ...(extra[tab] as object ?? {}) }));
  const res = await createUser(c, adminToken, { roleIds: [role.id] });
  if (res.status !== 201) throw new Error(`create user ${res.status} ${JSON.stringify(res.body)}`);
  const first = await tenantLogin(c, tenantCode, res.body.user.email, res.body.temporaryPassword);
  const ch = await c.http.post(`${API}/auth/password/change`).set(bearer(first.token))
    .send({ currentPassword: res.body.temporaryPassword, newPassword: 'NewUser@12345' });
  if (ch.status !== 200) throw new Error(`pw change ${ch.status}`);
  return { token: ch.body.accessToken as string, userId: res.body.user.id as string, roleId: role.id as string };
}

/** 1x1 PNG. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

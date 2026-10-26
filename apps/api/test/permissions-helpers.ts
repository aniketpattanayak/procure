/** Helpers shared by the Phase 2 permissions / locations / settings integration tests. */
import { expect } from 'vitest';
import { API, bearer, Ctx, tenantLogin, uid } from './helpers';

export const PW = 'Restricted@12345';

/** Creates a user (with roles) as the admin, signs in and changes the temp password. */
export async function restrictedUser(c: Ctx, tenantCode: string, adminToken: string, roleIds: string[] = []) {
  const email = `r-${uid()}@example.test`;
  const res = await c.http.post(`${API}/users`).set(bearer(adminToken)).send({ name: `Restricted ${uid(4)}`, email, roleIds });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const first = await tenantLogin(c, tenantCode, email, res.body.temporaryPassword);
  const ch = await c.http.post(`${API}/auth/password/change`).set(bearer(first.token)).send({ currentPassword: res.body.temporaryPassword, newPassword: PW });
  expect(ch.status).toBe(200);
  return { id: res.body.user.id as string, email, token: ch.body.accessToken as string };
}

export async function createRole(c: Ctx, adminToken: string, name = 'Role') {
  const res = await c.http.post(`${API}/roles`).set(bearer(adminToken)).send({ key: `r_${uid(8)}`, name });
  expect(res.status).toBe(201);
  return res.body as { id: string; key: string; version: number };
}

export async function grantTab(c: Ctx, token: string, roleId: string, tab: string, actions: string[], views: string[] = [], fieldAccess: unknown[] = []) {
  return c.http.put(`${API}/roles/${roleId}/permissions/tabs/${tab}`).set(bearer(token)).send({ actions, views, fieldAccess });
}

/** A role holding exactly the given keys (grouped by tab), assigned to a fresh restricted user. */
export async function userWithKeys(c: Ctx, tenantCode: string, adminToken: string, keys: string[]) {
  const role = await createRole(c, adminToken, 'Keys role');
  const byTab = new Map<string, { actions: string[]; views: string[] }>();
  for (const k of keys) {
    const [tab, rest] = k.split(':') as [string, string];
    const t = byTab.get(tab) ?? { actions: [], views: [] };
    (rest.startsWith('view.') ? t.views : t.actions).push(k);
    byTab.set(tab, t);
  }
  for (const [tab, t] of byTab) {
    const r = await grantTab(c, adminToken, role.id, tab, t.actions, t.views);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const u = await restrictedUser(c, tenantCode, adminToken, [role.id]);
  return { ...u, roleId: role.id };
}

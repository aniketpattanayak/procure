/** Integration: location tree CRUD, move, deactivate cascade, delete rules, max_locations, scope=mine. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, bearer, bootApp, closeApp, Ctx, superAdmin, tenantWithAdmin, uid } from './helpers';
import { createRole, restrictedUser, userWithKeys } from './permissions-helpers';

type Node = { id: string; parentId: string | null; code: string; name: string; depth: number; levelLabel: string; isActive: boolean; childCount: number; pathNames: string[]; version: number };

describe('locations', () => {
  let c: Ctx;
  let owner: string;

  beforeAll(async () => {
    c = await bootApp();
    owner = (await superAdmin(c)).token;
  });
  afterAll(async () => closeApp(c));

  async function tenant(maxLocations: number | null = 50) {
    const t = await tenantWithAdmin(c, owner, { limits: { max_users: 20, max_locations: maxLocations } });
    const token = t.admin.token;
    const add = async (name: string, parentId: string | null = null, extra: Record<string, unknown> = {}) => {
      const r = await c.http.post(`${API}/locations`).set(bearer(token)).send({ code: `${name.replace(/\W/g, '').slice(0, 10)}-${uid(6)}`, name, parentId, ...extra });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as Node;
    };
    const get = async (id: string) => (await c.http.get(`${API}/locations/${id}`).set(bearer(token))).body as Node;
    return { ...t, token, add, get };
  }

  it('CRUD with level labels, child counts and breadcrumbs', async () => {
    const t = await tenant();
    await c.http.put(`${API}/config/settings`).set(bearer(t.token)).send({ 'labels.location_levels': ['Plant', 'Store'] });
    const plant = await t.add('Pune Plant');
    const store = await t.add('Main Store', plant.id);
    const bin = await t.add('Bin A1', store.id);
    const deep = await t.add('Shelf 1', bin.id);
    expect(plant).toMatchObject({ depth: 1, levelLabel: 'Plant', parentId: null, pathNames: [], isActive: true });
    expect(store).toMatchObject({ depth: 2, levelLabel: 'Store', pathNames: ['Pune Plant'] });
    expect(deep).toMatchObject({ depth: 4, levelLabel: 'Store', pathNames: ['Pune Plant', 'Main Store', 'Bin A1'] });

    const top = await c.http.get(`${API}/locations`).set(bearer(t.token));
    expect(top.body.map((n: Node) => n.id)).toEqual([plant.id]);
    expect(top.body[0].childCount).toBe(1);
    const kids = await c.http.get(`${API}/locations`).query({ parentId: store.id }).set(bearer(t.token));
    expect(kids.body.map((n: Node) => n.name)).toEqual(['Bin A1']);
    const search = await c.http.get(`${API}/locations`).query({ q: 'shelf' }).set(bearer(t.token));
    expect(search.body.map((n: Node) => n.id)).toEqual([deep.id]);
    const tree = await c.http.get(`${API}/locations/tree`).set(bearer(t.token));
    expect(tree.body.map((n: Node) => n.id)).toEqual([plant.id, store.id, bin.id, deep.id]);

    const upd = await c.http.put(`${API}/locations/${bin.id}`).set(bearer(t.token)).send({ name: 'Bin A-1', version: bin.version });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: 'Bin A-1', version: bin.version + 1, code: bin.code });
    expect((await c.http.put(`${API}/locations/${bin.id}`).set(bearer(t.token)).send({ name: 'Stale', version: bin.version })).status).toBe(409);
    const dup = await c.http.post(`${API}/locations`).set(bearer(t.token)).send({ code: plant.code.toLowerCase(), name: 'Dup' });
    expect(dup.status).toBe(409);
    expect(dup.body.meta.field).toBe('code');
    expect((await c.http.post(`${API}/locations`).set(bearer(t.token)).send({ code: 'bad code!', name: 'X' })).status).toBe(400);
    expect((await c.http.post(`${API}/locations`).set(bearer(t.token)).send({ code: 'ORPHAN', name: 'X', parentId: '00000000-0000-7000-8000-000000000000' })).status).toBe(400);
    expect((await c.http.get(`${API}/locations/00000000-0000-7000-8000-000000000000`).set(bearer(t.token))).status).toBe(404);
    const audit = await c.db.selectFrom('app.audit_log').select('action').where('tenant_id', '=', t.tenant.tenantId).where('entity', '=', 'location').execute();
    expect(audit.length).toBe(5);
  });

  it('move updates descendant paths; moving under own descendant → 409', async () => {
    const t = await tenant();
    const pune = await t.add('Pune');
    const chennai = await t.add('Chennai');
    const store = await t.add('Store', pune.id);
    const bin = await t.add('Bin', store.id);

    const mv = await c.http.post(`${API}/locations/${store.id}/move`).set(bearer(t.token)).send({ parentId: chennai.id, version: store.version });
    expect(mv.status).toBe(200);
    expect(mv.body).toMatchObject({ parentId: chennai.id, pathNames: ['Chennai'], depth: 2 });
    expect(await t.get(bin.id)).toMatchObject({ pathNames: ['Chennai', 'Store'], depth: 3 });
    const paths = await c.db.selectFrom('app.location_node').select(['id', 'path']).where('id', 'in', [chennai.id, store.id, bin.id]).execute();
    const p = new Map(paths.map(r => [r.id, String(r.path)]));
    expect(p.get(bin.id)!.startsWith(`${p.get(store.id)}.`)).toBe(true);
    expect(p.get(store.id)!.startsWith(`${p.get(chennai.id)}.`)).toBe(true);

    const cur = await t.get(chennai.id);
    const loop = await c.http.post(`${API}/locations/${chennai.id}/move`).set(bearer(t.token)).send({ parentId: bin.id, version: cur.version });
    expect(loop.status).toBe(409);
    expect(loop.body.code).toBe('CONFLICT');
    expect((await c.http.post(`${API}/locations/${chennai.id}/move`).set(bearer(t.token)).send({ parentId: chennai.id, version: cur.version })).status).toBe(409);
    // To the top level.
    const s2 = await t.get(store.id);
    const top = await c.http.post(`${API}/locations/${store.id}/move`).set(bearer(t.token)).send({ parentId: null, version: s2.version });
    expect(top.body).toMatchObject({ parentId: null, depth: 1, pathNames: [] });
    expect(await t.get(bin.id)).toMatchObject({ depth: 2, pathNames: ['Store'] });
    expect((await c.http.post(`${API}/locations/${store.id}/move`).set(bearer(t.token)).send({ parentId: pune.id, version: s2.version })).status).toBe(409); // stale version
  });

  it('deactivate cascades; activate requires an active parent; views', async () => {
    const t = await tenant();
    const plant = await t.add('Plant');
    const store = await t.add('Store', plant.id);
    const bin = await t.add('Bin', store.id);
    const d = await c.http.post(`${API}/locations/${store.id}/deactivate`).set(bearer(t.token));
    expect(d.status).toBe(200);
    expect(d.body.isActive).toBe(false);
    expect((await t.get(bin.id)).isActive).toBe(false);
    expect((await t.get(plant.id)).isActive).toBe(true);
    expect((await t.get(plant.id)).childCount).toBe(1); // GET by id counts every child

    const activeKids = await c.http.get(`${API}/locations`).query({ parentId: plant.id }).set(bearer(t.token));
    expect(activeKids.body).toEqual([]);
    const inactive = await c.http.get(`${API}/locations/tree`).query({ view: 'inactive' }).set(bearer(t.token));
    expect(inactive.body.map((n: Node) => n.id).sort()).toEqual([store.id, bin.id].sort());
    const all = await c.http.get(`${API}/locations/tree`).query({ view: 'all' }).set(bearer(t.token));
    expect(all.body).toHaveLength(3);

    expect((await c.http.post(`${API}/locations/${bin.id}/activate`).set(bearer(t.token))).status).toBe(409);
    expect((await c.http.post(`${API}/locations/${store.id}/activate`).set(bearer(t.token))).body.isActive).toBe(true);
    expect((await t.get(bin.id)).isActive).toBe(false); // activate does not cascade
    expect((await c.http.post(`${API}/locations/${bin.id}/activate`).set(bearer(t.token))).body.isActive).toBe(true);
    // Creating under an inactive parent is refused.
    await c.http.post(`${API}/locations/${bin.id}/deactivate`).set(bearer(t.token));
    expect((await c.http.post(`${API}/locations`).set(bearer(t.token)).send({ code: `X-${uid()}`, name: 'Under inactive', parentId: bin.id })).status).toBe(409);
  });

  it('delete: only an unreferenced leaf; otherwise 409 with usedBy', async () => {
    const t = await tenant();
    const plant = await t.add('Plant');
    const leaf = await t.add('Leaf', plant.id);
    const parentBlocked = await c.http.delete(`${API}/locations/${plant.id}`).set(bearer(t.token));
    expect(parentBlocked.status).toBe(409);
    expect(parentBlocked.body.meta.usedBy).toEqual([{ kind: 'location_node', label: 'Sub-locations', count: 1 }]);

    const role = await createRole(c, t.token);
    await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(t.token)).send({ entries: [{ nodeId: leaf.id }] });
    const scoped = await c.http.delete(`${API}/locations/${leaf.id}`).set(bearer(t.token));
    expect(scoped.status).toBe(409);
    expect(scoped.body.meta.usedBy).toEqual([{ kind: 'scope_grant', label: 'Permission scopes', count: 1 }]);
    await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(t.token)).send({ entries: [] });

    const fakeRecord = '00000000-0000-7000-8000-0000000000aa';
    await c.db.insertInto('app.record_ref').values({ tenant_id: t.tenant.tenantId, from_kind: 'master_record', from_id: fakeRecord, from_field: 'store', to_kind: 'location_node', to_id: leaf.id }).execute();
    const ref = await c.http.delete(`${API}/locations/${leaf.id}`).set(bearer(t.token));
    expect(ref.status).toBe(409);
    expect(ref.body.meta.usedBy[0]).toMatchObject({ kind: 'record_ref', count: 1 });
    await c.db.deleteFrom('app.record_ref').where('tenant_id', '=', t.tenant.tenantId).where('to_id', '=', leaf.id).execute();

    expect((await c.http.delete(`${API}/locations/${leaf.id}`).set(bearer(t.token))).status).toBe(204);
    expect((await c.http.get(`${API}/locations/${leaf.id}`).set(bearer(t.token))).status).toBe(404);
    expect((await c.http.delete(`${API}/locations/${plant.id}`).set(bearer(t.token))).status).toBe(204);
  });

  it('max_locations = 5: the 6th active node is rejected; admins notified at 80% and 100%; activate counts', async () => {
    const t = await tenant(5);
    const nodes: Node[] = [];
    for (let i = 1; i <= 5; i++) nodes.push(await t.add(`Node ${i}`));
    const sixth = await c.http.post(`${API}/locations`).set(bearer(t.token)).send({ code: 'SIXTH', name: 'Sixth' });
    expect(sixth.status).toBe(403);
    expect(sixth.body.code).toBe('LIMIT_EXCEEDED.max_locations');
    expect(sixth.body.title).toBe('Your plan allows 5 active locations; you are using 5. Ask your administrator to upgrade the plan or free up capacity.');
    expect(sixth.body.meta).toEqual({ limitKey: 'max_locations', limit: 5, used: 5 });

    const notes = await c.http.get(`${API}/notifications`).set(bearer(t.token));
    const warn = notes.body.data.filter((n: { kind: string; data: { limitKey: string } }) => n.kind === 'limit_warning' && n.data.limitKey === 'max_locations');
    expect(warn.map((n: { data: { threshold: number } }) => n.data.threshold).sort()).toEqual([100, 80]);

    // Deactivate frees a slot; reactivating while full is refused.
    await c.http.post(`${API}/locations/${nodes[0]!.id}/deactivate`).set(bearer(t.token));
    await t.add('Replacement');
    const re = await c.http.post(`${API}/locations/${nodes[0]!.id}/activate`).set(bearer(t.token));
    expect(re.status).toBe(403);
    expect(re.body.code).toBe('LIMIT_EXCEEDED.max_locations');
    const usage = await c.http.get(`${API}/tenant/usage`).set(bearer(t.token));
    expect(usage.body.limits.find((l: { key: string }) => l.key === 'max_locations')).toMatchObject({ effective: 5, used: 5 });
  });

  it('parallel creates never exceed the limit', async () => {
    const t = await tenant(3);
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      c.http.post(`${API}/locations`).set(bearer(t.token)).send({ code: `P${i}-${uid(4)}`, name: `P${i}` })));
    expect(res.filter(r => r.status === 201)).toHaveLength(3);
    expect(res.filter(r => r.status === 403)).toHaveLength(5);
  });

  it('scope=mine returns only the user\'s subtree; keys enforced', async () => {
    const t = await tenant();
    const pune = await t.add('Pune Plant');
    const main = await t.add('Main Store', pune.id);
    const a1 = await t.add('Bin A1', main.id);
    const chennai = await t.add('Chennai Plant');
    const raw = await t.add('Raw Material Store', chennai.id);

    const role = await createRole(c, t.token, 'Indent clerk');
    expect((await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(t.token)).send({ entries: [{ nodeId: pune.id, includeDescendants: true }] })).status).toBe(200);
    const u = await restrictedUser(c, t.tenant.code, t.token, [role.id]);

    // No admin.locations keys: scope=all → 403, scope=mine → own subtree.
    expect((await c.http.get(`${API}/locations`).set(bearer(u.token))).status).toBe(403);
    const mineTop = await c.http.get(`${API}/locations`).query({ scope: 'mine' }).set(bearer(u.token));
    expect(mineTop.status).toBe(200);
    expect(mineTop.body.map((n: Node) => n.id)).toEqual([pune.id]);
    const mineTree = await c.http.get(`${API}/locations/tree`).query({ scope: 'mine' }).set(bearer(u.token));
    expect(mineTree.body.map((n: Node) => n.id)).toEqual([pune.id, main.id, a1.id]);
    expect((await c.http.get(`${API}/locations`).query({ scope: 'mine', parentId: chennai.id }).set(bearer(u.token))).body).toEqual([]);
    expect((await c.http.get(`${API}/locations/tree`).query({ scope: 'mine', view: 'inactive' }).set(bearer(u.token))).status).toBe(403);
    expect((await c.http.get(`${API}/locations/${a1.id}`).set(bearer(u.token))).status).toBe(200);
    expect((await c.http.get(`${API}/locations/${raw.id}`).set(bearer(u.token))).status).toBe(404);
    expect((await c.http.post(`${API}/locations`).set(bearer(u.token)).send({ code: 'NOPE', name: 'Nope' })).status).toBe(403);

    // A node added under Pune shows up on the user's next request (permver bump).
    const a2 = await t.add('Bin A2', main.id);
    const after = await c.http.get(`${API}/locations/tree`).query({ scope: 'mine' }).set(bearer(u.token));
    expect(after.body.map((n: Node) => n.id)).toContain(a2.id);
    expect((await c.http.get(`${API}/auth/me`).set(bearer(u.token))).body.permissions.scope.nodeIds).toContain(a2.id);
    // Deactivated nodes leave the expanded scope.
    await c.http.post(`${API}/locations/${a2.id}/deactivate`).set(bearer(t.token));
    expect((await c.http.get(`${API}/auth/me`).set(bearer(u.token))).body.permissions.scope.nodeIds).not.toContain(a2.id);

    // Exact node (no descendants): just Main Store.
    await c.http.put(`${API}/users/${u.id}/scope`).set(bearer(t.token)).send({ entries: [{ nodeId: chennai.id, includeDescendants: false }] });
    const two = await c.http.get(`${API}/locations/tree`).query({ scope: 'mine' }).set(bearer(u.token));
    expect(two.body.map((n: Node) => n.id).sort()).toEqual([pune.id, main.id, a1.id, chennai.id].sort());

    // Tab-specific scope replaces the default for admin.locations.
    await c.http.put(`${API}/users/${u.id}/scope`).set(bearer(t.token)).send({ entries: [{ nodeId: raw.id, tabKey: 'admin.locations' }] });
    const tabScoped = await c.http.get(`${API}/locations/tree`).query({ scope: 'mine' }).set(bearer(u.token));
    expect(tabScoped.body.map((n: Node) => n.id)).toEqual([raw.id]);

    // Admin: scope=mine = everything (6 nodes, one inactive).
    expect((await c.http.get(`${API}/locations/tree`).query({ scope: 'mine' }).set(bearer(t.token))).body).toHaveLength(5);
    expect((await c.http.get(`${API}/locations/tree`).query({ scope: 'mine', view: 'all' }).set(bearer(t.token))).body).toHaveLength(6);
    // No scope rows at all → nothing.
    const none = await restrictedUser(c, t.tenant.code, t.token);
    expect((await c.http.get(`${API}/locations/tree`).query({ scope: 'mine' }).set(bearer(none.token))).body).toEqual([]);
  });

  it('admin.locations is scoped: scope=all, by-id reads and every mutation stay inside the caller\'s scope', async () => {
    const t = await tenant();
    const pune = await t.add('Pune Plant');
    const main = await t.add('Main Store', pune.id);
    const a1 = await t.add('Bin A1', main.id);
    const chennai = await t.add('Chennai Plant');
    const raw = await t.add('Raw Material Store', chennai.id);
    const all = ['view', 'add', 'edit', 'move', 'deactivate'].map(a => `admin.locations:action.${a}`);
    const mgr = await userWithKeys(c, t.tenant.code, t.token, [...all, 'admin.locations:view.active', 'admin.locations:view.inactive']);
    await c.http.put(`${API}/roles/${mgr.roleId}/scope`).set(bearer(t.token)).send({ entries: [{ nodeId: pune.id }] });
    const h = bearer(mgr.token);
    const ids = (b: Node[]) => b.map(n => n.id);

    // Reads: scope=all == own subtree; top level = own scope roots; ancestors only in pathNames.
    expect(ids((await c.http.get(`${API}/locations/tree`).set(h)).body)).toEqual([pune.id, main.id, a1.id]);
    expect(ids((await c.http.get(`${API}/locations`).set(h)).body)).toEqual([pune.id]);
    expect(ids((await c.http.get(`${API}/locations`).query({ q: 'store' }).set(h)).body)).toEqual([main.id]);
    expect((await c.http.get(`${API}/locations`).query({ parentId: chennai.id }).set(h)).body).toEqual([]);
    expect((await c.http.get(`${API}/locations/${a1.id}`).set(h)).body.pathNames).toEqual(['Pune Plant', 'Main Store']);
    expect((await c.http.get(`${API}/locations/${raw.id}`).set(h)).status).toBe(404);

    // Mutations on out-of-scope nodes → 404; top-level adds/moves need all-nodes → 403.
    const v = (await c.http.get(`${API}/locations/${a1.id}`).set(bearer(t.token))).body.version;
    expect((await c.http.post(`${API}/locations`).set(h).send({ code: 'OUT1', name: 'x', parentId: chennai.id })).status).toBe(400);
    expect((await c.http.post(`${API}/locations`).set(h).send({ code: 'TOP1', name: 'x' })).status).toBe(403);
    expect((await c.http.put(`${API}/locations/${raw.id}`).set(h).send({ name: 'x', version: raw.version })).status).toBe(404);
    expect((await c.http.post(`${API}/locations/${raw.id}/move`).set(h).send({ parentId: main.id, version: raw.version })).status).toBe(404);
    expect((await c.http.post(`${API}/locations/${a1.id}/move`).set(h).send({ parentId: chennai.id, version: v })).status).toBe(400);
    expect((await c.http.post(`${API}/locations/${a1.id}/move`).set(h).send({ parentId: null, version: v })).status).toBe(403);
    expect((await c.http.post(`${API}/locations/${chennai.id}/deactivate`).set(h)).status).toBe(404);
    expect((await c.http.post(`${API}/locations/${chennai.id}/activate`).set(h)).status).toBe(404);
    expect((await c.http.delete(`${API}/locations/${raw.id}`).set(h)).status).toBe(404);
    expect((await c.http.get(`${API}/locations/${raw.id}`).set(bearer(t.token))).body).toMatchObject({ name: 'Raw Material Store', isActive: true, version: raw.version });

    // In scope: everything works.
    const bin = await c.http.post(`${API}/locations`).set(h).send({ code: `IN-${uid(4)}`, name: 'Bin A2', parentId: main.id });
    expect(bin.status).toBe(201);
    expect((await c.http.post(`${API}/locations/${bin.body.id}/move`).set(h).send({ parentId: pune.id, version: bin.body.version })).status).toBe(200);
    expect((await c.http.post(`${API}/locations/${main.id}/deactivate`).set(h)).status).toBe(200);
    expect((await c.http.delete(`${API}/locations/${bin.body.id}`).set(h)).status).toBe(204);

    // Granted without descendants: the node itself is visible, but cascading writes on it are not allowed.
    await c.http.put(`${API}/roles/${mgr.roleId}/scope`).set(bearer(t.token)).send({ entries: [{ nodeId: chennai.id, includeDescendants: false }] });
    expect(ids((await c.http.get(`${API}/locations/tree`).set(h)).body)).toEqual([chennai.id]);
    expect((await c.http.post(`${API}/locations/${chennai.id}/deactivate`).set(h)).status).toBe(404);
    expect((await c.http.put(`${API}/locations/${chennai.id}`).set(h).send({ name: 'Chennai', version: chennai.version })).status).toBe(200);

    // No scope at all → nothing; tenant admin → everything.
    await c.http.put(`${API}/roles/${mgr.roleId}/scope`).set(bearer(t.token)).send({ entries: [] });
    expect((await c.http.get(`${API}/locations/tree`).set(h)).body).toEqual([]);
    expect((await c.http.get(`${API}/locations/tree`).query({ view: 'all' }).set(bearer(t.token))).body).toHaveLength(5);
  });

  it('location keys map to routes (view / add / edit / move / deactivate)', async () => {
    const t = await tenant();
    const plant = await t.add('Plant');
    const viewer = await userWithKeys(c, t.tenant.code, t.token, ['admin.locations:action.view', 'admin.locations:view.active']);
    await c.http.put(`${API}/roles/${viewer.roleId}/scope`).set(bearer(t.token)).send({ entries: [{ allNodes: true }] });
    expect((await c.http.get(`${API}/locations`).set(bearer(viewer.token))).status).toBe(200);
    expect((await c.http.get(`${API}/locations`).query({ view: 'inactive' }).set(bearer(viewer.token))).status).toBe(403);
    expect((await c.http.get(`${API}/locations/${plant.id}`).set(bearer(viewer.token))).status).toBe(200);
    expect((await c.http.put(`${API}/locations/${plant.id}`).set(bearer(viewer.token)).send({ name: 'x', version: plant.version })).status).toBe(403);
    expect((await c.http.post(`${API}/locations/${plant.id}/move`).set(bearer(viewer.token)).send({ parentId: null, version: plant.version })).status).toBe(403);
    expect((await c.http.post(`${API}/locations/${plant.id}/deactivate`).set(bearer(viewer.token))).status).toBe(403);
    expect((await c.http.delete(`${API}/locations/${plant.id}`).set(bearer(viewer.token))).status).toBe(403);
    const editor = await userWithKeys(c, t.tenant.code, t.token, ['admin.locations:action.edit', 'admin.locations:action.add']);
    await c.http.put(`${API}/roles/${editor.roleId}/scope`).set(bearer(t.token)).send({ entries: [{ allNodes: true }] });
    expect((await c.http.put(`${API}/locations/${plant.id}`).set(bearer(editor.token)).send({ name: 'Renamed', version: plant.version })).status).toBe(200);
    expect((await c.http.post(`${API}/locations`).set(bearer(editor.token)).send({ code: `E-${uid()}`, name: 'By editor' })).status).toBe(201);
  });
});

/**
 * Stock (Phase 5) test helpers: tenant with `store` feature, items, locations, permission-limited users, and the
 * isolation seed for the six 0015 tables.
 */
import { API, bearer, Ctx, superAdmin, tenantWithAdmin, uid } from './helpers';
import { scoped } from './procurement-helpers';

/** Rows in every 0015 table for one tenant, written as the DB owner (isolation is about RLS, not the API). */
export async function seedStockIsolation(c: Ctx, s: { tenantId: string; adminId: string; itemId: string; nodeId: string }) {
  const batch = await c.db.insertInto('app.stock_batch').values({ tenant_id: s.tenantId, item_id: s.itemId, batch_no: `ISO-${uid(6)}`, expiry_date: '2030-01-01' })
    .returning('id').executeTakeFirstOrThrow();
  const mv = await c.db.insertInto('app.stock_movement').values({
    tenant_id: s.tenantId, item_id: s.itemId, node_id: s.nodeId, batch_id: batch.id, stock_status: 'available', movement_type: 'opening',
    qty_in: '5', unit_cost: '2', value: '10', actor_id: s.adminId, idempotency_key: `iso-${uid(12)}`,
  }).returning('id').executeTakeFirstOrThrow();
  await c.db.insertInto('app.stock_balance').values({
    tenant_id: s.tenantId, item_id: s.itemId, node_id: s.nodeId, batch_key: batch.id, stock_status: 'available', qty: '5', value: '10', last_movement_id: mv.id,
  }).execute();
  await c.db.insertInto('app.item_avg_cost').values({ tenant_id: s.tenantId, item_id: s.itemId, node_id: s.nodeId, qty: '5', value: '10', avg_cost: '2' }).execute();
  await c.db.insertInto('app.valuation_layer').values({
    tenant_id: s.tenantId, item_id: s.itemId, node_id: s.nodeId, movement_id: mv.id, received_at: new Date(), qty_in: '5', qty_left: '5', unit_cost: '2',
  }).execute();
  const rule = await c.db.insertInto('app.reorder_rule').values({ tenant_id: s.tenantId, item_id: s.itemId, node_id: s.nodeId, min_qty: '1', reorder_qty: '10', created_by: s.adminId })
    .returning('id').executeTakeFirstOrThrow();
  return { batchId: batch.id, movementId: mv.id, ruleId: rule.id };
}

export interface StockWorld {
  tenantId: string; code: string; adminToken: string; adminId: string;
  /** Root (plant) → store → bin; plus a second plant outside the limited user's scope. */
  plant: string; store: string; bin: string; otherPlant: string;
  items: string[]; uomId: string;
}

/** Tenant on a plan with `store` (+ indent for auto-indent), three items, a location tree. */
export async function stockWorld(c: Ctx, opts: { features?: string[] } = {}): Promise<StockWorld> {
  const owner = (await superAdmin(c)).token;
  const { tenant, admin } = await tenantWithAdmin(c, owner, {
    features: opts.features ?? ['indent', 'purchase', 'store', 'grn', 'workflow_designer'], limits: { max_users: 20, max_locations: 50 },
  });
  const loc = async (code: string, name: string, parentId?: string) => {
    const r = await c.http.post(`${API}/locations`).set(bearer(admin.token)).send({ code: `${code}-${uid(4)}`, name, ...(parentId ? { parentId } : {}) });
    if (r.status !== 201) throw new Error(`location ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.id as string;
  };
  const plant = await loc('PL', 'Plant');
  const store = await loc('MS', 'Main Store', plant);
  const bin = await loc('A1', 'Bin A1', store);
  const otherPlant = await loc('PL2', 'Other plant');
  const uom = await c.http.post(`${API}/masters/uom/records`).set(bearer(admin.token)).send({ code: `KG${uid(3)}`, name: 'Kilogram', data: { decimals: '3' } });
  const items: string[] = [];
  for (const n of ['Steel', 'Cement', 'Paint']) {
    const r = await c.http.post(`${API}/masters/item/records`).set(bearer(admin.token)).send({ name: n, data: { uom: uom.body.id } });
    if (r.status !== 201) throw new Error(`item ${r.status} ${JSON.stringify(r.body)}`);
    items.push(r.body.id);
  }
  return { tenantId: tenant.tenantId, code: tenant.code, adminToken: admin.token, adminId: admin.userId, plant, store, bin, otherPlant, items, uomId: uom.body.id };
}

/** A user with a role holding exactly `keys`, scoped to `nodeId` (with descendants) or everything. */
export async function limitedUser(c: Ctx, w: StockWorld, keys: string[], nodeId?: string): Promise<{ token: string; userId: string; roleId: string }> {
  const u = await scoped(c, w.adminToken, w.code, keys, nodeId);
  return u;
}

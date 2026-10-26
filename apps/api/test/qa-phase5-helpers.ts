/**
 * QA Phase 5 helpers: ledger integrity oracle (balance = Σ movements, value conservation, pairs, FIFO layers),
 * store-document clerks (a submitter distinct from the approver — segregation of duties, QA3-BUG-004) and
 * small wrappers used by every qa-phase5-*.test.ts file.
 */
import { sql } from 'kysely';
import { expect } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { Ctx } from './helpers';
import { docs, scoped } from './procurement-helpers';
import { StockWorld } from './stock-helpers';

export const VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed', 'waiting_approve'];
export const docKeys = (type: string, actions = ['view', 'add', 'edit', 'submit', 'cancel', 'delete']) =>
  [...actions.map(a => `doc.${type}:action.${a}`), ...VIEWS.map(v => `doc.${type}:view.${v}`)];
export const STOCK_VIEW = ['stock', 'stock:action.view', 'stock:view.available', 'stock:view.quarantine', 'stock:view.rejected'];
export const CLERK_KEYS = [...docKeys('stock_transfer'), ...docKeys('stock_adjustment'), ...docKeys('stock_count'), ...STOCK_VIEW];

export interface IntegrityReport {
  balanceMismatch: unknown[]; orphanMovements: unknown[]; avgMismatch: unknown[]; negatives: unknown[]; brokenPairs: unknown[]; fifoMismatch: unknown[];
}

/**
 * Full (not sampled) recomputation of a tenant's stock from its movement ledger, as the DB owner.
 * `fifo`: also require Σ open layer qty = node qty (only valid for tenants that were FIFO from their first movement).
 */
export async function integrity(c: Ctx, tenantId: string, opts: { allowNegative?: boolean; fifo?: boolean } = {}): Promise<IntegrityReport> {
  const balanceMismatch = (await sql`
    select b.item_id, b.node_id, b.batch_key, b.stock_status, b.qty::text, b.value::text, coalesce(m.q, 0)::text as lq, coalesce(m.v, 0)::text as lv
      from app.stock_balance b
      left join (select item_id, node_id, coalesce(batch_id, '00000000-0000-0000-0000-000000000000'::uuid) as bk, stock_status, sum(qty_in - qty_out) as q, sum(value) as v
                   from app.stock_movement where tenant_id = ${tenantId} group by 1, 2, 3, 4) m
        on m.item_id = b.item_id and m.node_id = b.node_id and m.bk = b.batch_key and m.stock_status = b.stock_status
     where b.tenant_id = ${tenantId} and (b.qty <> coalesce(m.q, 0) or b.value <> coalesce(m.v, 0))`.execute(c.db)).rows;
  const orphanMovements = (await sql`
    select m.item_id, m.node_id, m.stock_status from app.stock_movement m
     where m.tenant_id = ${tenantId} and not exists (select 1 from app.stock_balance b where b.tenant_id = m.tenant_id and b.item_id = m.item_id and b.node_id = m.node_id
       and b.batch_key = coalesce(m.batch_id, '00000000-0000-0000-0000-000000000000'::uuid) and b.stock_status = m.stock_status)`.execute(c.db)).rows;
  const avgMismatch = (await sql`
    select a.item_id, a.node_id, a.qty::text, a.value::text, coalesce(m.q, 0)::text as lq, coalesce(m.v, 0)::text as lv
      from app.item_avg_cost a
      left join (select item_id, node_id, sum(qty_in - qty_out) as q, sum(value) as v from app.stock_movement where tenant_id = ${tenantId} group by 1, 2) m
        on m.item_id = a.item_id and m.node_id = a.node_id
     where a.tenant_id = ${tenantId} and (a.qty <> coalesce(m.q, 0) or a.value <> coalesce(m.v, 0))`.execute(c.db)).rows;
  const negatives = opts.allowNegative ? [] : (await sql`select item_id, node_id, stock_status, qty::text from app.stock_balance where tenant_id = ${tenantId} and qty < 0`.execute(c.db)).rows;
  const brokenPairs = (await sql`
    select pair_id, sum(qty_in)::text as qi, sum(qty_out)::text as qo, sum(value)::text as v, count(*)::int as n
      from app.stock_movement where tenant_id = ${tenantId} and pair_id is not null
     group by pair_id having sum(qty_in) <> sum(qty_out) or sum(value) <> 0 or count(*) % 2 <> 0`.execute(c.db)).rows;
  const fifoMismatch = opts.fifo ? (await sql`
    select a.item_id, a.node_id, a.qty::text, coalesce(v.l, 0)::text as layers from app.item_avg_cost a
      left join (select item_id, node_id, sum(qty_left) as l from app.valuation_layer where tenant_id = ${tenantId} group by 1, 2) v on v.item_id = a.item_id and v.node_id = a.node_id
     where a.tenant_id = ${tenantId} and a.qty >= 0 and a.qty <> coalesce(v.l, 0)`.execute(c.db)).rows : [];
  return { balanceMismatch, orphanMovements, avgMismatch, negatives, brokenPairs, fifoMismatch };
}

export async function expectIntegrity(c: Ctx, tenantId: string, opts: { allowNegative?: boolean; fifo?: boolean } = {}) {
  const r = await integrity(c, tenantId, opts);
  expect(r).toEqual({ balanceMismatch: [], orphanMovements: [], avgMismatch: [], negatives: [], brokenPairs: [], fifoMismatch: [] });
}

export const setSetting = (c: Ctx, tenantId: string, key: string, value: unknown) =>
  c.db.insertInto('app.tenant_setting').values({ tenant_id: tenantId, key, value: JSON.stringify(value) })
    .onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(value) })).execute();

/** Sum of balance rows (numbers) for item × node [× status]. */
export async function bal(c: Ctx, tenantId: string, item: string, node: string, status = 'available') {
  const r = await c.db.selectFrom('app.stock_balance').select(['qty', 'value']).where('tenant_id', '=', tenantId).where('item_id', '=', item).where('node_id', '=', node)
    .where('stock_status', '=', status as 'available').execute();
  return { qty: r.reduce((t, x) => t + Number(x.qty), 0), value: Math.round(r.reduce((t, x) => t + Number(x.value), 0) * 10000) / 10000 };
}

export async function clerk(c: Ctx, w: StockWorld, keys = CLERK_KEYS, nodeId?: string) {
  return scoped(c, w.adminToken, w.code, keys, nodeId);
}

/** Creates + submits a store document as `token`, then the admin approves every line in full (or `approve`). */
export async function storeDoc(c: Ctx, w: StockWorld, token: string, type: string, body: { values: Record<string, unknown>; lines: { values: Record<string, unknown> }[] }) {
  const d = docs(c, token, type);
  const draft = await mustOk(d.create(body), 201);
  return mustOk(d.submit(draft.id, draft.version));
}
export function approveAll(c: Ctx, w: StockWorld, type: string, sub: { id: string; lines: { id: string; values: { qty: string } }[] }, approve?: Record<string, string>, headers: Record<string, string> = {}) {
  const body = {
    action: 'decide', stageKey: 'approve',
    decisions: sub.lines.map(l => {
      const ap = approve?.[l.id] ?? String(l.values.qty);
      const rej = (Number(l.values.qty) - Number(ap)).toString();
      return { lineId: l.id, approve: ap, reject: rej, ...(rej !== '0' ? { reason: 'Partly' } : {}) };
    }),
  };
  return c.http.post(`/api/v1/docs/${type}/${sub.id}/actions`).set({ Authorization: `Bearer ${w.adminToken}`, ...headers }).send(body);
}

export const opening = (c: Ctx, token: string, rows: Record<string, unknown>[], asOf = '2026-04-01') => api(c, token).post('/stock/opening', { asOf, rows });

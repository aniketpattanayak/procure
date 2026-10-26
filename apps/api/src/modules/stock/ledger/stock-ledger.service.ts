import { Injectable } from '@nestjs/common';
import { ErrorCode, StockPost, StockStatus } from '@procure/schema';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { getTenantSetting } from '../../identity';
import { canon, c6, D, dec, Dec, isDec, q4, r4 } from './decimal';
import { ReorderService } from './reorder.service';
import { BatchInput, LedgerPost, NO_BATCH, PostedMovement, PostOptions, STATUS_MOVES, STOCK_ERRORS } from './types';

const STATUSES: ReadonlySet<string> = new Set(StockStatus.options);
const MOVEMENT_TYPES: ReadonlySet<string> = new Set(['opening', 'receipt', 'issue', 'return', 'transfer_out', 'transfer_in', 'adjustment_in', 'adjustment_out',
  'block', 'unblock', 'reject', 'rtv', 'count_in', 'count_out', 'reversal']);

interface Norm {
  i: number;
  post: LedgerPost;
  itemId: string; nodeId: string; batchId: string | null; batchKey: string; status: StockStatus;
  dir: 'in' | 'out'; qty: Dec; key: string | null; pairId: string | null;
  /** Specific identification (rtv / status-move outs): the receipt movement whose goods leave. */
  sourceId: string | null;
}

interface BalRow { item_id: string; node_id: string; batch_key: string; stock_status: StockStatus; qty: string; value: string }
interface AvgRow { item_id: string; node_id: string; qty: string; value: string; avg_cost: string }
interface AvgState { qty: Dec; value: Dec; avg: Dec; dirty: boolean }
interface BalState { qty: Dec; value: Dec; last: string | null; dirty: boolean }

const balKey = (itemId: string, nodeId: string, batchKey: string, status: string) => `${itemId}|${nodeId}|${batchKey}|${status}`;
const avgKey = (itemId: string, nodeId: string) => `${itemId}|${nodeId}`;
const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, { code: STOCK_ERRORS.invalid }, [{ path, message }]);

/**
 * The ONLY write path for stock (ADR-0016, contract "Stock ledger"). In the caller's transaction:
 *  1. validates and de-duplicates the posts (idempotency keys);
 *  2. locks the affected stock_balance rows in key order (insert-on-conflict first, then SELECT … FOR UPDATE), then
 *     the item_avg_cost rows in key order — always balances before costs, so concurrent posts never deadlock;
 *  3. skips posts whose idempotency key already exists (returned with `duplicate: true`);
 *  4. values outs (WAC = node average; FIFO = oldest layers first) — ins of a pair (transfer_in, block/unblock/reject
 *     in-side) carry the out-side's cost; status moves never change the node's valuation;
 *  5. rejects negative balances unless `stock.allow_negative`;
 *  6. writes movements, balances, average cost and FIFO layers; outbox `stock.moved`; re-order check after outs.
 */
@Injectable()
export class StockLedger {
  constructor(private readonly reorder: ReorderService) {}

  /** New pair id for the two sides of a block/unblock/reject/transfer. */
  newPairId(): string {
    return randomUUID();
  }

  async post(tx: Tx, posts: LedgerPost[], actorId: string | null, opts: PostOptions = {}): Promise<PostedMovement[]> {
    if (!posts.length) return [];
    const tenantId = await this.tenantOf(tx);
    const norm = this.normalise(posts);
    const allowNegative = await getTenantSetting(tx, 'stock.allow_negative');
    const method = await getTenantSetting(tx, 'stock.valuation');

    // ---- locks: balances (key order), then average-cost rows (key order)
    const balKeys = [...new Map(norm.map(n => [balKey(n.itemId, n.nodeId, n.batchKey, n.status), n])).values()]
      .sort((a, b) => cmp(balKey(a.itemId, a.nodeId, a.batchKey, a.status), balKey(b.itemId, b.nodeId, b.batchKey, b.status)));
    await this.validateRefs(tx, tenantId, norm);
    const sources = await this.sourceCosts(tx, tenantId, norm);
    for (const n of balKeys) {
      await tx.insertInto('app.stock_balance').values({ tenant_id: tenantId, item_id: n.itemId, node_id: n.nodeId, batch_key: n.batchKey, stock_status: n.status, qty: 0, value: 0 })
        .onConflict(oc => oc.doNothing()).execute();
    }
    const balRows = await sql<BalRow>`
      select b.item_id, b.node_id, b.batch_key, b.stock_status, b.qty::text as qty, b.value::text as value
        from app.stock_balance b
        join (select * from unnest(${sql.val(balKeys.map(n => n.itemId))}::uuid[], ${sql.val(balKeys.map(n => n.nodeId))}::uuid[],
                                   ${sql.val(balKeys.map(n => n.batchKey))}::uuid[], ${sql.val(balKeys.map(n => n.status))}::text[]) as k(i, n, bk, s)) k
          on b.item_id = k.i and b.node_id = k.n and b.batch_key = k.bk and b.stock_status = k.s
       where b.tenant_id = ${tenantId}
       order by b.item_id, b.node_id, b.batch_key, b.stock_status
       for update of b`.execute(tx);
    const avgKeys = [...new Set(norm.map(n => avgKey(n.itemId, n.nodeId)))].sort(cmp);
    for (const k of avgKeys) {
      const [item, node] = k.split('|') as [string, string];
      await tx.insertInto('app.item_avg_cost').values({ tenant_id: tenantId, item_id: item, node_id: node, qty: 0, value: 0, avg_cost: 0 })
        .onConflict(oc => oc.doNothing()).execute();
    }
    const avgRows = await sql<AvgRow>`
      select a.item_id, a.node_id, a.qty::text as qty, a.value::text as value, a.avg_cost::text as avg_cost
        from app.item_avg_cost a
        join (select * from unnest(${sql.val(avgKeys.map(k => k.split('|')[0]))}::uuid[], ${sql.val(avgKeys.map(k => k.split('|')[1]))}::uuid[]) as k(i, n)) k
          on a.item_id = k.i and a.node_id = k.n
       where a.tenant_id = ${tenantId}
       order by a.item_id, a.node_id
       for update of a`.execute(tx);

    const bal = new Map<string, BalState>(balRows.rows.map(r => [balKey(r.item_id, r.node_id, r.batch_key, r.stock_status), { qty: dec(r.qty), value: dec(r.value), last: null, dirty: false }]));
    const avg = new Map<string, AvgState>(avgRows.rows.map(r => [avgKey(r.item_id, r.node_id), { qty: dec(r.qty), value: dec(r.value), avg: dec(r.avg_cost), dirty: false }]));

    // ---- idempotency (checked under the locks so a concurrent retry sees the committed first attempt)
    const keys = norm.map(n => n.key).filter((k): k is string => !!k);
    const existing = new Map<string, PostedMovement>();
    if (keys.length) {
      const rows = await tx.selectFrom('app.stock_movement').selectAll().where('tenant_id', '=', tenantId).where('idempotency_key', 'in', keys).execute();
      for (const r of rows) existing.set(r.idempotency_key!, { ...toPosted(r), duplicate: true });
    }

    // ---- valuation: outs first (in given order), then ins (pairs carry the out-side cost)
    const out: (PostedMovement | null)[] = norm.map(() => null);
    const pairCost = new Map<string, { qty: Dec; value: Dec }>();
    const at = opts.at ?? new Date();
    const todo = norm.filter(n => {
      const dup = n.key ? existing.get(n.key) : undefined;
      if (dup) out[n.i] = dup;
      return !dup;
    });
    // Given order, except that the in-side of a pair waits for its out-side (it carries the out-side's cost).
    const order: Norm[] = [];
    const done = new Set<number>();
    for (const n of todo) {
      if (done.has(n.i)) continue;
      if (n.dir === 'in' && n.pairId) {
        for (const o of todo) if (o.dir === 'out' && o.pairId === n.pairId && !done.has(o.i)) { order.push(o); done.add(o.i); }
      }
      order.push(n);
      done.add(n.i);
    }

    // ---- valuation + movement rows (written as we go so FIFO outs see layers opened earlier in the same post)
    for (const n of order) {
      const b = bal.get(balKey(n.itemId, n.nodeId, n.batchKey, n.status))!;
      const a = avg.get(avgKey(n.itemId, n.nodeId))!;
      let unit: Dec;
      let value: Dec; // signed (+ in, − out)
      if (n.dir === 'out') {
        if (!allowNegative && b.qty.minus(n.qty).isNegative()) {
          throw new AppError(409, STOCK_ERRORS.negative, `Not enough ${n.status} stock: ${q4(b.qty)} on hand, ${q4(n.qty)} needed.`, {
            itemId: n.itemId, nodeId: n.nodeId, batchId: n.batchId, status: n.status, available: q4(b.qty), requested: q4(n.qty),
          });
        }
        let taken: Dec;
        let u: Dec | null = null;
        const src = n.sourceId ? sources.get(n.sourceId)! : null;
        if (STATUS_MOVES.has(n.post.movementType)) {
          taken = this.statusMoveValue(b, a, n.qty, src?.unit);
        } else if (method === 'fifo') {
          taken = await this.consumeFifo(tx, tenantId, n, a, src?.movementId);
          a.qty = a.qty.minus(n.qty);
          a.value = a.value.minus(taken);
          a.dirty = true;
        } else if (src) {
          // QA5-BUG-001: specific identification — the returned goods leave at their receipt cost; what stays keeps its
          // own cost (the node average moves). Bounded by the node's value; the last units take exactly what is left.
          taken = a.qty.eq(n.qty) ? a.value : clamp(r4(n.qty.times(src.unit)), a.value);
          a.qty = a.qty.minus(n.qty);
          a.value = a.qty.isZero() ? new D(0) : a.value.minus(taken);
          if (a.qty.gt(0)) a.avg = a.value.div(a.qty).toDecimalPlaces(6);
          a.dirty = true;
        } else {
          u = a.avg;
          taken = a.qty.eq(n.qty) ? a.value : r4(n.qty.times(a.avg));
          a.qty = a.qty.minus(n.qty);
          a.value = a.qty.isZero() ? new D(0) : a.value.minus(taken);
          a.dirty = true;
        }
        b.qty = b.qty.minus(n.qty);
        b.value = b.value.minus(taken);
        if (n.pairId) {
          const p = pairCost.get(n.pairId) ?? { qty: new D(0), value: new D(0) };
          pairCost.set(n.pairId, { qty: p.qty.plus(n.qty), value: p.value.plus(taken) });
        }
        unit = u ?? taken.div(n.qty);
        value = taken.neg();
      } else {
        const carried = n.pairId ? pairCost.get(n.pairId) : undefined;
        if (carried && carried.qty.gt(0)) {
          unit = carried.value.div(carried.qty);
          // Same qty on both sides → carry the exact value (no rounding drift across the pair).
          value = carried.qty.eq(n.qty) ? carried.value : r4(n.qty.times(unit));
        } else if (n.post.unitCost !== undefined && n.post.unitCost !== null && n.post.unitCost !== '') {
          unit = dec(n.post.unitCost);
          value = r4(n.qty.times(unit));
        } else {
          unit = a.qty.gt(0) ? a.value.div(a.qty) : a.avg;
          value = r4(n.qty.times(unit));
        }
        if (!STATUS_MOVES.has(n.post.movementType)) {
          a.qty = a.qty.plus(n.qty);
          a.value = a.value.plus(value);
          if (a.qty.gt(0)) a.avg = a.value.div(a.qty).toDecimalPlaces(6);
          a.dirty = true;
        }
        b.qty = b.qty.plus(n.qty);
        b.value = b.value.plus(value);
      }
      b.dirty = true;
      const row = await tx.insertInto('app.stock_movement').values({
        tenant_id: tenantId, item_id: n.itemId, node_id: n.nodeId, batch_id: n.batchId, stock_status: n.status, movement_type: n.post.movementType,
        qty_in: n.dir === 'in' ? q4(n.qty) : '0', qty_out: n.dir === 'out' ? q4(n.qty) : '0', unit_cost: c6(unit), value: q4(value),
        document_id: n.post.documentId ?? null, line_id: n.post.lineId ?? null, pair_id: n.pairId, reason: n.post.reason ?? null,
        actor_id: actorId, at, idempotency_key: n.key,
      }).returningAll().executeTakeFirstOrThrow();
      out[n.i] = { ...toPosted(row), duplicate: false };
      b.last = row.id;
      if (n.dir === 'in' && method === 'fifo' && !STATUS_MOVES.has(n.post.movementType)) {
        await tx.insertInto('app.valuation_layer').values({
          tenant_id: tenantId, item_id: n.itemId, node_id: n.nodeId, movement_id: row.id, received_at: at, qty_in: q4(n.qty), qty_left: q4(n.qty), unit_cost: c6(unit),
        }).execute();
      }
    }

    for (const [k, b] of bal) {
      if (!b.dirty) continue;
      const [item, node, bk, st] = k.split('|') as [string, string, string, StockStatus];
      await tx.updateTable('app.stock_balance').set({ qty: q4(b.qty), value: q4(b.value), last_movement_id: b.last, updated_at: new Date() })
        .where('tenant_id', '=', tenantId).where('item_id', '=', item).where('node_id', '=', node).where('batch_key', '=', bk).where('stock_status', '=', st).execute();
    }
    for (const [k, a] of avg) {
      if (!a.dirty) continue;
      const [item, node] = k.split('|') as [string, string];
      await tx.updateTable('app.item_avg_cost').set({ qty: q4(a.qty), value: q4(a.value), avg_cost: c6(a.avg), updated_at: new Date() })
        .where('tenant_id', '=', tenantId).where('item_id', '=', item).where('node_id', '=', node).execute();
    }

    const written = out.filter((m): m is PostedMovement => !!m && !m.duplicate);
    if (written.length) {
      const documentIds = [...new Set(written.map(m => posts[out.indexOf(m)]?.documentId).filter((d): d is string => !!d))];
      await tx.insertInto('app.outbox_event').values({
        event_type: 'stock.moved', aggregate_kind: documentIds.length === 1 ? 'document' : 'stock', aggregate_id: documentIds.length === 1 ? documentIds[0]! : null,
        payload: JSON.stringify({
          documentIds,
          movements: written.slice(0, 200).map(m => ({ id: m.id, itemId: m.itemId, nodeId: m.nodeId, batchId: m.batchId, status: m.status, movementType: m.movementType, qtyIn: m.qtyIn, qtyOut: m.qtyOut })),
          count: written.length,
        }),
      }).execute();
      if (!opts.skipReorder) {
        const outs = written.filter(m => dec(m.qtyOut).gt(0) && m.status === 'available');
        if (outs.length) await this.reorder.check(tx, tenantId, [...new Map(outs.map(m => [avgKey(m.itemId, m.nodeId), { itemId: m.itemId, nodeId: m.nodeId }])).values()], actorId);
      }
    }
    return out as PostedMovement[];
  }

  /**
   * Value moved by a status change at one node: proportional share of the source balance's value (WAC and FIFO), or
   * — when the goods are identified (`sourceMovementId`) — their receipt cost, bounded by the source row's value.
   */
  private statusMoveValue(b: BalState, a: AvgState, qty: Dec, srcUnit?: Dec): Dec {
    if (b.qty.eq(qty)) return b.value;
    if (srcUnit && b.value.gte(0)) return clamp(r4(qty.times(srcUnit)), b.value);
    if (b.qty.gt(0) && b.value.gte(0)) return r4(qty.times(b.value.div(b.qty)));
    const unit = a.qty.gt(0) ? a.value.div(a.qty) : a.avg;
    return r4(qty.times(unit));
  }

  /**
   * Consumes FIFO layers oldest-first; returns the value taken. Shortfall (negative stock allowed) uses the last cost.
   * With `sourceMovementId` (specific identification, QA5-BUG-001) that receipt's layer is consumed first.
   */
  private async consumeFifo(tx: Tx, tenantId: string, n: Norm, a: AvgState, sourceMovementId?: string): Promise<Dec> {
    const all = await tx.selectFrom('app.valuation_layer').select(['id', 'qty_left', 'unit_cost', 'movement_id'])
      .where('tenant_id', '=', tenantId).where('item_id', '=', n.itemId).where('node_id', '=', n.nodeId).where('qty_left', '>', '0')
      .orderBy('received_at').orderBy('id').forUpdate().execute();
    const own = sourceMovementId ? all.filter(l => String(l.movement_id) === sourceMovementId) : [];
    const layers = own.length ? all.filter(l => !own.includes(l)) : all;
    let need = n.qty;
    let value = new D(0);
    let lastCost = a.avg;
    // Stock that predates FIFO (tenant switched from WAC at a year boundary) has no layers: it is the oldest stock,
    // valued at what the node holds beyond the open layers.
    const layerQty = all.reduce((t, l) => t.plus(dec(l.qty_left)), new D(0));
    const layerValue = all.reduce((t, l) => t.plus(dec(l.qty_left).times(dec(l.unit_cost))), new D(0));
    const legacy = a.qty.minus(layerQty);
    for (const l of own) { // the identified receipt leaves first, at its own cost
      const left = dec(l.qty_left);
      const take = D.min(left, need);
      value = value.plus(take.times(dec(l.unit_cost)));
      need = need.minus(take);
      await tx.updateTable('app.valuation_layer').set({ qty_left: q4(left.minus(take)) }).where('id', '=', l.id).execute();
    }
    if (legacy.gt(0) && need.gt(0)) {
      const take = D.min(legacy, need);
      const unit = a.value.minus(layerValue).div(legacy);
      value = value.plus(take.times(unit.isNegative() ? new D(0) : unit));
      need = need.minus(take);
    }
    for (const l of layers) {
      if (need.lte(0)) break;
      const left = dec(l.qty_left);
      const take = D.min(left, need);
      lastCost = dec(l.unit_cost);
      value = value.plus(take.times(lastCost));
      need = need.minus(take);
      await tx.updateTable('app.valuation_layer').set({ qty_left: q4(left.minus(take)) }).where('id', '=', l.id).execute();
    }
    if (need.gt(0)) value = value.plus(need.times(lastCost));
    value = r4(value);
    // Everything gone: take exactly what is left at the node so no residual value remains.
    if (a.qty.eq(n.qty) && need.isZero()) value = a.value;
    return value;
  }

  /** Unit cost of each `sourceMovementId` (an in-movement of the same item × node in this tenant). */
  private async sourceCosts(tx: Tx, tenantId: string, norm: Norm[]): Promise<Map<string, { movementId: string; unit: Dec }>> {
    const ids = [...new Set(norm.map(n => n.sourceId).filter((x): x is string => !!x))];
    if (!ids.length) return new Map();
    const rows = await tx.selectFrom('app.stock_movement').select(['id', 'item_id', 'node_id', 'unit_cost', 'qty_in'])
      .where('tenant_id', '=', tenantId).where('id', 'in', ids).execute();
    const byId = new Map(rows.map(r => [String(r.id), r]));
    for (const n of norm) {
      if (!n.sourceId) continue;
      const r = byId.get(n.sourceId);
      if (!r || r.item_id !== n.itemId || r.node_id !== n.nodeId || !dec(r.qty_in).gt(0)) throw bad(`posts.${n.i}.sourceMovementId`, 'Unknown source receipt for this item and location.');
    }
    return new Map(rows.map(r => [String(r.id), { movementId: String(r.id), unit: dec(r.unit_cost) }]));
  }

  private normalise(posts: LedgerPost[]): Norm[] {
    const seen = new Set<string>();
    return posts.map((p, i) => {
      const at = `posts.${i}`;
      if (!p || typeof p !== 'object') throw bad(at, 'Invalid stock post.');
      if (!MOVEMENT_TYPES.has(p.movementType)) throw bad(`${at}.movementType`, `Unknown movement type "${String(p.movementType)}".`);
      if (!STATUSES.has(p.status)) throw bad(`${at}.status`, `Unknown stock status "${String(p.status)}".`);
      const hasIn = p.qtyIn !== undefined && p.qtyIn !== null && p.qtyIn !== '' && dec(p.qtyIn).gt(0);
      const hasOut = p.qtyOut !== undefined && p.qtyOut !== null && p.qtyOut !== '' && dec(p.qtyOut).gt(0);
      for (const [k, v] of [['qtyIn', p.qtyIn], ['qtyOut', p.qtyOut], ['unitCost', p.unitCost]] as const) {
        if (v !== undefined && v !== null && v !== '' && !isDec(String(v))) throw bad(`${at}.${k}`, `${k} must be a decimal number.`);
      }
      if (hasIn === hasOut) throw bad(at, 'A stock post needs exactly one of qtyIn / qtyOut greater than zero.');
      const qty = dec(hasIn ? p.qtyIn : p.qtyOut);
      if (!qty.eq(qty.toDecimalPlaces(4))) throw bad(at, 'Quantities have at most 4 decimals.');
      if (p.unitCost && dec(p.unitCost).isNegative()) throw bad(`${at}.unitCost`, 'Unit cost cannot be negative.');
      const sourceId = p.sourceMovementId ? String(p.sourceMovementId) : null;
      if (sourceId) {
        if (!/^\d{1,18}$/.test(sourceId)) throw bad(`${at}.sourceMovementId`, 'sourceMovementId must be a movement id.');
        if (hasIn || (p.movementType !== 'rtv' && !STATUS_MOVES.has(p.movementType))) throw bad(`${at}.sourceMovementId`, 'Only rtv and status-move outs name a source receipt.');
      }
      const key = p.idempotencyKey ? String(p.idempotencyKey).slice(0, 200) : null;
      if (key) {
        if (seen.has(key)) throw bad(`${at}.idempotencyKey`, 'Duplicate idempotency key in one post.');
        seen.add(key);
      }
      return {
        i, post: p, itemId: p.itemId, nodeId: p.nodeId, batchId: p.batchId ?? null, batchKey: p.batchId ?? NO_BATCH, status: p.status,
        dir: hasIn ? 'in' : 'out', qty, key, pairId: p.pairId ?? null, sourceId,
      } satisfies Norm;
    });
  }

  /** Item must be an item master record, node a location, batch (if any) a batch of that item. All in this tenant. */
  private async validateRefs(tx: Tx, tenantId: string, norm: Norm[]) {
    const items = [...new Set(norm.map(n => n.itemId))];
    const nodes = [...new Set(norm.map(n => n.nodeId))];
    const batches = [...new Set(norm.map(n => n.batchId).filter((b): b is string => !!b))];
    const okItems = await sql<{ id: string }>`select r.id from app.master_record r join app.master_def m on m.id = r.master_id
      where r.tenant_id = ${tenantId} and m.key = 'item' and r.id = any(${sql.val(items)}::uuid[])`.execute(tx);
    const okI = new Set(okItems.rows.map(r => r.id));
    const okNodes = new Set((await tx.selectFrom('app.location_node').select('id').where('tenant_id', '=', tenantId).where('id', 'in', nodes).execute()).map(r => r.id));
    const okBatches = batches.length
      ? new Map((await tx.selectFrom('app.stock_batch').select(['id', 'item_id']).where('tenant_id', '=', tenantId).where('id', 'in', batches).execute()).map(r => [r.id, r.item_id]))
      : new Map<string, string>();
    for (const n of norm) {
      if (!okI.has(n.itemId)) throw bad(`posts.${n.i}.itemId`, 'Unknown item.');
      if (!okNodes.has(n.nodeId)) throw bad(`posts.${n.i}.nodeId`, 'Unknown location.');
      if (n.batchId && okBatches.get(n.batchId) !== n.itemId) throw bad(`posts.${n.i}.batchId`, 'Unknown batch for this item.');
    }
  }

  private async tenantOf(tx: Tx): Promise<string> {
    const r = await sql<{ t: string | null }>`select app.current_tenant_id()::text as t`.execute(tx);
    const t = r.rows[0]?.t;
    if (!t) throw new Error('StockLedger.post needs a tenant transaction');
    return t;
  }

  // ------------------------------------------------------------------ helpers for other modules

  /** Finds or creates a batch of an item (unique per item × batch no). Fills empty dates on an existing batch. */
  async ensureBatch(tx: Tx, b: BatchInput): Promise<string> {
    const batchNo = b.batchNo.trim();
    if (!batchNo) throw bad('batchNo', 'Batch number is required.');
    await tx.insertInto('app.stock_batch').values({ item_id: b.itemId, batch_no: batchNo, mfg_date: b.mfgDate ?? null, expiry_date: b.expiryDate ?? null, vendor_id: b.vendorId ?? null })
      .onConflict(oc => oc.columns(['tenant_id', 'item_id', 'batch_no']).doNothing()).execute();
    const row = await tx.selectFrom('app.stock_batch').select('id').where('item_id', '=', b.itemId).where('batch_no', '=', batchNo).executeTakeFirstOrThrow();
    return row.id;
  }

  /** Current balance (qty, value) of item × node [× batch] [× status] (no lock). */
  async balanceOf(tx: Tx, f: { itemId: string; nodeId: string; batchId?: string | null; status?: StockStatus }): Promise<{ qty: string; value: string }> {
    let q = tx.selectFrom('app.stock_balance').select(eb => [eb.fn.coalesce(eb.fn.sum<string>('qty'), sql<string>`0`).as('qty'), eb.fn.coalesce(eb.fn.sum<string>('value'), sql<string>`0`).as('value')])
      .where('item_id', '=', f.itemId).where('node_id', '=', f.nodeId);
    if (f.batchId !== undefined) q = q.where('batch_key', '=', f.batchId ?? NO_BATCH);
    if (f.status) q = q.where('stock_status', '=', f.status);
    const r = await q.executeTakeFirstOrThrow();
    return { qty: canon(r.qty), value: canon(r.value) };
  }
}

/** v bounded to [0, max] (max ≥ 0); unbounded when max is negative (negative stock allowed). */
function clamp(v: Dec, max: Dec): Dec {
  if (max.isNegative()) return v;
  return v.gt(max) ? max : v.isNegative() ? new D(0) : v;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type MovementDb = {
  id: string; item_id: string; node_id: string; batch_id: string | null; stock_status: StockStatus | string; movement_type: string; qty_in: string; qty_out: string;
  unit_cost: string; value: string; pair_id: string | null; idempotency_key: string | null;
};
function toPosted(r: MovementDb): Omit<PostedMovement, 'duplicate'> {
  return {
    id: String(r.id), itemId: r.item_id, nodeId: r.node_id, batchId: r.batch_id, status: r.stock_status as StockStatus, movementType: r.movement_type as StockPost['movementType'],
    qtyIn: canon(r.qty_in), qtyOut: canon(r.qty_out), unitCost: canon(r.unit_cost), value: canon(r.value), pairId: r.pair_id, idempotencyKey: r.idempotency_key,
  };
}

import { Injectable } from '@nestjs/common';
import { BlockInput, CountSnapshotInput, DocumentRow, ErrorCode, OpeningBalanceInput, ReorderRuleInput, StockPost } from '@procure/schema';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit.service';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { DocumentsService, fitsUom, itemUomRules, uomMessage } from '../../documents';
import { tenantToday } from '../../forms';
import { STOCK_COUNT } from '../docs/store-types';
import { canon, dec, isDec } from '../ledger/decimal';
import { ReorderService } from '../ledger/reorder.service';
import { StockLedger } from '../ledger/stock-ledger.service';
import { NO_BATCH, PostedMovement, STOCK_ERRORS } from '../ledger/types';
import { canSeeValue, StockActor, StockQueryService } from './stock-query.service';

export interface ReorderRuleRow {
  id: string; item: { id: string; code: string; name: string }; node: { id: string; code: string; name: string };
  minQty: string; reorderQty: string; maxQty: string | null; autoIndent: boolean; isActive: boolean; lastAlertAt: string | null; version: number;
}

const invalid = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);
/** Largest value numeric(18,4) holds (14 integer digits). QA5-BUG-003. */
const MAX_VALUE = dec('99999999999999.9999');

/** Write endpoints of the stock module (opening balances, block/unblock, re-order rules, count snapshot). */
@Injectable()
export class StockCommandService {
  constructor(
    private readonly ledger: StockLedger,
    private readonly query: StockQueryService,
    private readonly reorder: ReorderService,
    private readonly audit: AuditService,
    private readonly docs: DocumentsService,
  ) {}

  private async assertItem(tx: Tx, a: StockActor, itemId: string, path: string) {
    const ok = await sql<{ id: string }>`select r.id from app.master_record r join app.master_def m on m.id = r.master_id
      where r.tenant_id = ${a.tenantId} and r.id = ${itemId} and m.key = 'item'`.execute(tx);
    if (!ok.rows[0]) throw invalid(path, 'Unknown item.');
  }

  // ------------------------------------------------------------------ opening balances

  async opening(tx: Tx, a: StockActor, input: z.infer<typeof OpeningBalanceInput>): Promise<{ posted: number }> {
    const pairs = new Set<string>();
    // QA5-BUG-002: an opening balance cannot be dated in the future.
    if (input.asOf > (await tenantToday(tx))) throw invalid('asOf', 'The opening date cannot be in the future.');
    for (const [i, r] of input.rows.entries()) {
      if (dec(r.qty).lte(0)) throw invalid(`rows.${i}.qty`, 'Quantity must be greater than 0.');
      if (dec(r.unitCost).isNegative()) throw invalid(`rows.${i}.unitCost`, 'Unit cost cannot be negative.');
      // QA5-BUG-003: qty × unit cost must fit the stored value (numeric(18,4)), else Postgres overflows (500).
      if (isDec(r.qty) && isDec(r.unitCost) && dec(r.qty).times(dec(r.unitCost)).gt(MAX_VALUE)) throw invalid(`rows.${i}.unitCost`, 'Quantity × unit cost is too large.');
      await this.query.nodeInScope(tx, a, r.nodeId).catch(() => { throw invalid(`rows.${i}.nodeId`, 'Unknown location or outside your scope.'); });
      await this.assertItem(tx, a, r.itemId, `rows.${i}.itemId`);
      pairs.add(`${r.itemId}|${r.nodeId}`);
    }
    // QA3-BUG-003: quantities follow the item unit's decimal places.
    const uoms = await itemUomRules(tx, a.tenantId, input.rows.map(r => r.itemId));
    for (const [i, r] of input.rows.entries()) {
      const rule = uoms.get(r.itemId);
      if (rule && !fitsUom(r.qty, rule)) throw invalid(`rows.${i}.qty`, uomMessage(r.qty, rule));
    }
    const list = [...pairs].map(p => p.split('|') as [string, string]);
    // Serialise concurrent opening loads for the same pairs (the movement check below must not race).
    for (const [item, node] of [...list].sort()) await sql`select pg_advisory_xact_lock(hashtextextended(${`stock-opening:${a.tenantId}:${item}:${node}`}, 0))`.execute(tx);
    const used = await sql<{ item_id: string; node_id: string }>`
      select distinct m.item_id, m.node_id from app.stock_movement m
        join unnest(${sql.val(list.map(p => p[0]))}::uuid[], ${sql.val(list.map(p => p[1]))}::uuid[]) as k(i, n) on m.item_id = k.i and m.node_id = k.n
       where m.tenant_id = ${a.tenantId}`.execute(tx);
    if (used.rows.length) {
      throw new AppError(409, STOCK_ERRORS.openingExists, 'Opening balances can only be posted for items that have no stock movements yet at that location.', {
        pairs: used.rows.map(r => ({ itemId: r.item_id, nodeId: r.node_id })),
      });
    }
    const posts: StockPost[] = [];
    for (const r of input.rows) {
      const batchId = r.batchNo ? await this.ledger.ensureBatch(tx, { itemId: r.itemId, batchNo: r.batchNo, expiryDate: r.expiryDate ?? null }) : null;
      posts.push({
        itemId: r.itemId, nodeId: r.nodeId, batchId, status: 'available', movementType: 'opening', qtyIn: r.qty, unitCost: r.unitCost, reason: `Opening balance as of ${input.asOf}`,
        idempotencyKey: `opening:${r.itemId}:${r.nodeId}:${batchId ?? NO_BATCH}`,
      });
    }
    const out = await this.ledger.post(tx, posts, a.userId, { at: new Date(`${input.asOf}T00:00:00Z`), skipReorder: true });
    const posted = out.filter(m => !m.duplicate).length;
    await this.audit.tenant(tx, { action: 'opening', entity: 'stock', entityId: null, actorId: a.userId, after: { asOf: input.asOf, rows: input.rows.length, posted } });
    return { posted };
  }

  // ------------------------------------------------------------------ block / unblock

  async block(tx: Tx, a: StockActor, input: z.infer<typeof BlockInput>): Promise<PostedMovement[]> {
    await this.query.nodeInScope(tx, a, input.nodeId);
    await this.assertItem(tx, a, input.itemId, 'itemId');
    if (dec(input.qty).lte(0)) throw invalid('qty', 'Quantity must be greater than 0.');
    const rule = (await itemUomRules(tx, a.tenantId, [input.itemId])).get(input.itemId);
    if (rule && !fitsUom(input.qty, rule)) throw invalid('qty', uomMessage(input.qty, rule));
    const [from, to] = input.direction === 'block' ? (['available', 'quarantine'] as const) : (['quarantine', 'available'] as const);
    const pairId = this.ledger.newPairId();
    const base = { itemId: input.itemId, nodeId: input.nodeId, batchId: input.batchId ?? null, movementType: input.direction, pairId, reason: input.reason } as const;
    const out = await this.ledger.post(tx, [{ ...base, status: from, qtyOut: input.qty }, { ...base, status: to, qtyIn: input.qty }], a.userId);
    await this.audit.tenant(tx, { action: input.direction, entity: 'stock', entityId: pairId, actorId: a.userId, after: { ...input } });
    return canSeeValue(a) ? out : out.map(m => ({ ...m, unitCost: null, value: null }) as unknown as PostedMovement);
  }

  // ------------------------------------------------------------------ re-order rules

  async rules(tx: Tx, a: StockActor, nodeId?: string): Promise<ReorderRuleRow[]> {
    const rows = await sql<{
      id: string; item_id: string; item_code: string; item_name: string; node_id: string; node_code: string; node_name: string; min_qty: string; reorder_qty: string;
      max_qty: string | null; auto_indent: boolean; is_active: boolean; last_alert_at: Date | null; version: number;
    }>`
      select r.id, r.item_id, i.code::text as item_code, i.name as item_name, r.node_id, n.code::text as node_code, n.name as node_name, r.min_qty::text as min_qty,
             r.reorder_qty::text as reorder_qty, r.max_qty::text as max_qty, r.auto_indent, r.is_active, r.last_alert_at, r.version
        from app.reorder_rule r join app.master_record i on i.id = r.item_id join app.location_node n on n.id = r.node_id
       where r.tenant_id = ${a.tenantId} and ${this.query.scopeSql(a, 'n.path')}
         ${nodeId ? sql`and n.path <@ (select path from app.location_node where id = ${nodeId})` : sql``}
       order by n.path, i.code`.execute(tx);
    return rows.rows.map(r => ({
      id: r.id, item: { id: r.item_id, code: r.item_code, name: r.item_name }, node: { id: r.node_id, code: r.node_code, name: r.node_name },
      minQty: canon(r.min_qty), reorderQty: canon(r.reorder_qty), maxQty: r.max_qty === null ? null : canon(r.max_qty), autoIndent: r.auto_indent, isActive: r.is_active,
      lastAlertAt: r.last_alert_at ? new Date(r.last_alert_at).toISOString() : null, version: r.version,
    }));
  }

  private checkRule(input: z.infer<typeof ReorderRuleInput>) {
    // QA5-BUG-003: at most 14 integer digits / 4 decimals (numeric(18,4)); larger values overflowed into a 500.
    for (const k of ['minQty', 'reorderQty', 'maxQty'] as const) {
      const v = input[k];
      if (v !== undefined && (!isDec(v) || !dec(v).eq(dec(v).toDecimalPlaces(4)))) throw invalid(k, 'At most 14 digits before and 4 after the decimal point.');
    }
    if (dec(input.reorderQty).lte(0)) throw invalid('reorderQty', 'Re-order quantity must be greater than 0.');
    if (dec(input.minQty).isNegative()) throw invalid('minQty', 'Minimum cannot be negative.');
    if (input.maxQty !== undefined && dec(input.maxQty).lt(dec(input.minQty))) throw invalid('maxQty', 'Maximum must be at least the minimum.');
  }

  async createRule(tx: Tx, a: StockActor, input: z.infer<typeof ReorderRuleInput>): Promise<ReorderRuleRow> {
    this.checkRule(input);
    await this.query.nodeInScope(tx, a, input.nodeId);
    await this.assertItem(tx, a, input.itemId, 'itemId');
    const dup = await tx.selectFrom('app.reorder_rule').select('id').where('item_id', '=', input.itemId).where('node_id', '=', input.nodeId).executeTakeFirst();
    if (dup) throw AppError.conflict('A re-order rule for this item at this location already exists.', { id: dup.id });
    const r = await tx.insertInto('app.reorder_rule').values({
      item_id: input.itemId, node_id: input.nodeId, min_qty: input.minQty, reorder_qty: input.reorderQty, max_qty: input.maxQty ?? null,
      auto_indent: input.autoIndent, is_active: input.isActive, created_by: a.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await this.audit.tenant(tx, { action: 'create', entity: 'reorder_rule', entityId: r.id, actorId: a.userId, after: input });
    return this.rule(tx, a, r.id);
  }

  async updateRule(tx: Tx, a: StockActor, id: string, input: z.infer<typeof ReorderRuleInput>): Promise<ReorderRuleRow> {
    this.checkRule(input);
    const before = await this.rule(tx, a, id);
    await this.query.nodeInScope(tx, a, input.nodeId);
    await this.assertItem(tx, a, input.itemId, 'itemId');
    if (input.itemId !== before.item.id || input.nodeId !== before.node.id) {
      const dup = await tx.selectFrom('app.reorder_rule').select('id').where('item_id', '=', input.itemId).where('node_id', '=', input.nodeId).where('id', '!=', id).executeTakeFirst();
      if (dup) throw AppError.conflict('A re-order rule for this item at this location already exists.', { id: dup.id });
    }
    await tx.updateTable('app.reorder_rule').set({
      item_id: input.itemId, node_id: input.nodeId, min_qty: input.minQty, reorder_qty: input.reorderQty, max_qty: input.maxQty ?? null,
      auto_indent: input.autoIndent, is_active: input.isActive, version: sql`version + 1`,
    }).where('id', '=', id).execute();
    await this.audit.tenant(tx, { action: 'update', entity: 'reorder_rule', entityId: id, actorId: a.userId, before, after: input });
    return this.rule(tx, a, id);
  }

  async deleteRule(tx: Tx, a: StockActor, id: string): Promise<void> {
    const before = await this.rule(tx, a, id);
    await tx.deleteFrom('app.reorder_rule').where('id', '=', id).execute();
    await this.audit.tenant(tx, { action: 'delete', entity: 'reorder_rule', entityId: id, actorId: a.userId, before });
  }

  async rule(tx: Tx, a: StockActor, id: string): Promise<ReorderRuleRow> {
    const all = await this.rules(tx, a);
    const r = all.find(x => x.id === id);
    if (!r) throw AppError.notFound('Re-order rule');
    return r;
  }

  /** Items below min (subtree available) with the suggested order qty. */
  async belowMin(tx: Tx, a: StockActor, nodeId?: string) {
    if (nodeId) await this.query.nodeInScope(tx, a, nodeId);
    const rows = await this.reorder.belowMin(tx, a.tenantId, { nodeId });
    const visible = new Map((await this.rules(tx, a)).map(r => [r.id, r]));
    return rows.filter(r => visible.has(r.ruleId)).map(r => {
      const rule = visible.get(r.ruleId)!;
      return {
        ruleId: r.ruleId, item: rule.item, node: rule.node, available: r.available, minQty: r.minQty, reorderQty: r.reorderQty, maxQty: r.maxQty,
        suggestedQty: r.suggestedQty, autoIndent: r.autoIndent,
      };
    });
  }

  // ------------------------------------------------------------------ count snapshot

  /** Creates a draft stock_count with one line per item × node × batch holding available stock (book qty frozen). */
  async countSnapshot(tx: Tx, a: StockActor, input: z.infer<typeof CountSnapshotInput>): Promise<DocumentRow> {
    await this.query.nodeInScope(tx, a, input.nodeId);
    const rows = await sql<{ item_id: string; node_id: string; batch_no: string | null }>`
      select b.item_id, b.node_id, sb.batch_no
        from app.stock_balance b join app.location_node n on n.id = b.node_id join app.master_record i on i.id = b.item_id
        left join app.stock_batch sb on sb.id = nullif(b.batch_key, ${NO_BATCH}::uuid)
       where b.tenant_id = ${a.tenantId} and b.stock_status = 'available' and b.qty <> 0
         and ${input.includeChildren ? sql`n.path <@ (select path from app.location_node where id = ${input.nodeId})` : sql`b.node_id = ${input.nodeId}`}
         and ${this.query.scopeSql(a, 'n.path')}
         ${input.itemIds?.length ? sql`and b.item_id = any(${sql.val(input.itemIds)}::uuid[])` : sql``}
       order by n.path, i.code, sb.batch_no nulls first`.execute(tx);
    const lines = rows.rows.map(r => ({ item: r.item_id, location: r.node_id, batch: r.batch_no ?? undefined }));
    // Requested items without stock at the node still get a line (book 0) so found stock can be recorded.
    for (const id of input.itemIds ?? []) if (!lines.some(l => l.item === id)) lines.push({ item: id, location: input.nodeId, batch: undefined });
    if (!lines.length) throw AppError.conflict('There is no stock to count at this location.');
    if (lines.length > 1000) throw invalid('nodeId', 'Too many lines for one count (max 1000). Count a smaller location or a list of items.');
    return this.docs.create(tx, a, STOCK_COUNT, {
      values: { location: input.nodeId },
      lines: lines.map(l => ({ values: { item: l.item, location: l.location, ...(l.batch ? { batch: l.batch } : {}), qty: '1' } })),
    });
  }
}

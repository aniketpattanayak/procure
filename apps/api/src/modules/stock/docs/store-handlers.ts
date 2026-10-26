import { Injectable, OnModuleInit } from '@nestjs/common';
import { ErrorCode, StockPost } from '@procure/schema';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { Tx } from '../../../core/db.service';
import { EntitlementsService } from '../../../core/entitlements.service';
import { AppError } from '../../../core/errors';
import { DocumentHooks } from '../../documents';
import { ProcurementInstaller, SystemTypeInstaller } from '../../procurement';
import { dec, q4 } from '../ledger/decimal';
import { STOCK_FEATURE } from '../ledger/types';
import { StockPostingCtx, StockPostingHandlers } from '../posting/handlers';
import { uuidFrom } from '../posting/stock-effects';
import { resolveBatch } from './batch';
import { STOCK_ADJUSTMENT, STOCK_COUNT, STOCK_TRANSFER, STORE_SPECS } from './store-types';

const invalid = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);

interface LineDb { id: string; line_no: number; item_id: string | null; location_node_id: string; qty: string; custom: unknown }

async function decidedLines(ctx: StockPostingCtx): Promise<{ line: LineDb; qty: string }[]> {
  const decided = ctx.approved.filter(a => dec(a.qty).gt(0));
  if (!decided.length) return [];
  const rows = await ctx.tx.selectFrom('app.document_line').select(['id', 'line_no', 'item_id', 'location_node_id', 'qty', 'custom'])
    .where('document_id', '=', ctx.documentId).where('id', 'in', decided.map(d => d.lineId)).execute();
  const byId = new Map(rows.map(r => [r.id, r as LineDb]));
  return decided.filter(d => byId.get(d.lineId)?.item_id).map(d => ({ line: byId.get(d.lineId)!, qty: d.qty }));
}
const custom = (l: LineDb) => (l.custom ?? {}) as Record<string, unknown>;
const pairOf = (ctx: StockPostingCtx, lineId: string) => {
  const k = ctx.key(lineId, 'pair');
  return k ? uuidFrom(k) : randomUUID();
};

/**
 * Store document types (stock_transfer, stock_adjustment, stock_count): provisioning (registered as an install step
 * of the shared system-type installer, so tenant creation, the boot backfill and the seed all run it — only for
 * tenants whose plan has feature `store`), submit validations, and their `post_stock` handlers.
 */
@Injectable()
export class StockInstaller implements OnModuleInit {
  constructor(
    private readonly installer: ProcurementInstaller,
    private readonly types: SystemTypeInstaller,
    private readonly ent: EntitlementsService,
    private readonly hooks: DocumentHooks,
    private readonly handlers: StockPostingHandlers,
  ) {}

  onModuleInit() {
    this.installer.register({ key: 'store_types', order: 600, run: async (tx, ctx) => { await this.ensure(tx, ctx.tenantId, ctx.actorId, ctx.features); } });
    this.handlers.register(STOCK_TRANSFER, 'post_stock', ctx => this.transfer(ctx));
    this.handlers.register(STOCK_ADJUSTMENT, 'post_stock', ctx => this.adjustment(ctx));
    this.handlers.register(STOCK_COUNT, 'post_stock', ctx => this.count(ctx));
    this.hooks.onSave(STOCK_TRANSFER, async (tx, c) => { if (c.mode === 'submit') await this.checkTransfer(tx, c.documentId); });
    this.hooks.onSave(STOCK_ADJUSTMENT, async (tx, c) => { if (c.mode === 'submit') await this.checkAdjustment(tx, c.documentId); });
    this.hooks.onSave(STOCK_COUNT, async (tx, c) => {
      await this.refreshBook(tx, c.documentId);
      if (c.mode === 'submit') await this.checkCount(tx, c.documentId);
    });
  }

  /** Installs the three store types (idempotent; never overwrites tenant edits). Skipped without feature `store`. */
  async ensure(tx: Tx, tenantId: string, actorId: string | null, features?: string[]): Promise<boolean> {
    const feats = features?.length ? features : (await this.ent.state(tenantId))?.features ?? [];
    if (!feats.includes(STOCK_FEATURE)) return false;
    for (const spec of STORE_SPECS) await this.types.ensure(tx, tenantId, actorId, spec);
    return true;
  }

  // ------------------------------------------------------------------ submit checks

  private async checkTransfer(tx: Tx, documentId: string) {
    const d = await tx.selectFrom('app.document').select(['location_node_id', 'custom']).where('id', '=', documentId).executeTakeFirstOrThrow();
    const to = (d.custom as Record<string, unknown>)?.to_location;
    if (typeof to !== 'string' || !to) throw invalid('to_location', 'Choose the location to transfer to.');
    if (to === d.location_node_id) throw invalid('to_location', 'The destination must differ from the source location.');
  }

  private async checkAdjustment(tx: Tx, documentId: string) {
    const lines = await tx.selectFrom('app.document_line').select(['line_no', 'custom']).where('document_id', '=', documentId).where('is_deleted', '=', false).orderBy('line_no').execute();
    lines.forEach((l, i) => {
      const dir = (l.custom as Record<string, unknown>)?.direction;
      if (dir !== 'in' && dir !== 'out') throw invalid(`lines.${i}.direction`, 'Choose in or out.');
    });
  }

  private async checkCount(tx: Tx, documentId: string) {
    const lines = await tx.selectFrom('app.document_line').select(['line_no', 'custom']).where('document_id', '=', documentId).where('is_deleted', '=', false).orderBy('line_no').execute();
    lines.forEach((l, i) => {
      const v = (l.custom as Record<string, unknown>)?.counted_qty;
      if (v === null || v === undefined || v === '') throw invalid(`lines.${i}.counted_qty`, 'Enter the counted quantity.');
    });
  }

  /**
   * Count lines' `book_qty` is never taken from the user: after every save it is recomputed from the ledger as of the
   * moment the count was opened (document created_at) for item × line location × batch, available status.
   */
  async refreshBook(tx: Tx, documentId: string): Promise<void> {
    const d = await tx.selectFrom('app.document').select(['created_at']).where('id', '=', documentId).executeTakeFirstOrThrow();
    const lines = await tx.selectFrom('app.document_line').select(['id', 'item_id', 'location_node_id', 'custom']).where('document_id', '=', documentId).where('is_deleted', '=', false).execute();
    for (const l of lines) {
      if (!l.item_id) continue;
      const c = (l.custom ?? {}) as Record<string, unknown>;
      let batchId: string | null = null;
      try { batchId = await resolveBatch(tx, l.item_id, c.batch); } catch { batchId = null; }
      const unknownBatch = !!c.batch && String(c.batch).trim() !== '' && !batchId;
      const book = unknownBatch ? '0' : await this.bookQty(tx, l.item_id, l.location_node_id, batchId, d.created_at);
      if (c.book_qty === book) continue;
      await tx.updateTable('app.document_line').set({ custom: JSON.stringify({ ...c, book_qty: book }) }).where('id', '=', l.id).execute();
    }
  }

  async bookQty(tx: Tx, itemId: string, nodeId: string, batchId: string | null, asOf: Date): Promise<string> {
    let qb = tx.selectFrom('app.stock_movement').select(sql<string>`coalesce(sum(qty_in - qty_out), 0)::text`.as('q'))
      .where('item_id', '=', itemId).where('node_id', '=', nodeId).where('stock_status', '=', 'available').where('at', '<=', asOf);
    qb = batchId ? qb.where('batch_id', '=', batchId) : qb.where('batch_id', 'is', null);
    return q4(dec((await qb.executeTakeFirstOrThrow()).q));
  }

  // ------------------------------------------------------------------ post_stock handlers

  /** Paired transfer_out (from = document location) / transfer_in (to_location), value carried at source cost. */
  async transfer(ctx: StockPostingCtx): Promise<StockPost[]> {
    const from = ctx.snapshot.locationNodeId;
    const to = ctx.snapshot.values.to_location;
    if (typeof to !== 'string' || !to || to === from) throw AppError.conflict('The transfer has no valid destination location.');
    const posts: StockPost[] = [];
    for (const { line, qty } of await decidedLines(ctx)) {
      const batchId = await resolveBatch(ctx.tx, line.item_id!, custom(line).batch, { path: `lines.${line.line_no - 1}.batch` });
      const pairId = pairOf(ctx, line.id);
      const base = { itemId: line.item_id!, batchId, status: 'available' as const, lineId: line.id, pairId };
      posts.push({ ...base, nodeId: from, movementType: 'transfer_out', qtyOut: qty, idempotencyKey: ctx.key(line.id, 'out') });
      posts.push({ ...base, nodeId: to, movementType: 'transfer_in', qtyIn: qty, idempotencyKey: ctx.key(line.id, 'in') });
    }
    return posts;
  }

  /** adjustment_in (rate = unit cost, empty = average) / adjustment_out at each line's node. */
  async adjustment(ctx: StockPostingCtx): Promise<StockPost[]> {
    const posts: StockPost[] = [];
    const rates = new Map((await ctx.tx.selectFrom('app.document_line').select(['id', 'rate']).where('document_id', '=', ctx.documentId).execute()).map(r => [r.id, r.rate]));
    for (const { line, qty } of await decidedLines(ctx)) {
      const c = custom(line);
      const isIn = c.direction !== 'out';
      const batchId = await resolveBatch(ctx.tx, line.item_id!, c.batch, { create: isIn, path: `lines.${line.line_no - 1}.batch` });
      const rate = rates.get(line.id);
      posts.push({
        itemId: line.item_id!, nodeId: line.location_node_id, batchId, status: 'available', lineId: line.id,
        movementType: isIn ? 'adjustment_in' : 'adjustment_out', ...(isIn ? { qtyIn: qty, unitCost: rate === null || rate === undefined ? undefined : String(rate) } : { qtyOut: qty }),
        reason: typeof c.reason === 'string' ? c.reason : null, idempotencyKey: ctx.key(line.id),
      });
    }
    return posts;
  }

  /** count_in / count_out for counted − book (book qty frozen by the snapshot) of each approved line. */
  async count(ctx: StockPostingCtx): Promise<StockPost[]> {
    const posts: StockPost[] = [];
    const doc = await ctx.tx.selectFrom('app.document').select('created_at').where('id', '=', ctx.documentId).executeTakeFirstOrThrow();
    for (const { line } of await decidedLines(ctx)) {
      const c = custom(line);
      if (c.counted_qty === null || c.counted_qty === undefined || c.counted_qty === '') continue;
      let batchId = await resolveBatch(ctx.tx, line.item_id!, c.batch, { create: false }).catch(() => null);
      const book = batchId || !c.batch ? await this.bookQty(ctx.tx, line.item_id!, line.location_node_id, batchId, doc.created_at) : '0';
      const diff = dec(String(c.counted_qty)).minus(dec(book));
      if (diff.isZero()) continue;
      const isIn = diff.gt(0);
      if (!batchId && c.batch) batchId = await resolveBatch(ctx.tx, line.item_id!, c.batch, { create: isIn, path: `lines.${line.line_no - 1}.batch` });
      posts.push({
        itemId: line.item_id!, nodeId: line.location_node_id, batchId, status: 'available', lineId: line.id,
        movementType: isIn ? 'count_in' : 'count_out', ...(isIn ? { qtyIn: q4(diff) } : { qtyOut: q4(diff.abs()) }),
        reason: 'Physical count difference', idempotencyKey: ctx.key(line.id),
      });
    }
    return posts;
  }
}

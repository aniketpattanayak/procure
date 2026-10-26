import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { StockPost } from '@procure/schema';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import type { Tx } from '../../../core/db.service';
import { EFFECT_REGISTRY, type EffectContext, type EffectRegistry } from '../../../core/ports';
import { DocStore, DocumentsService, type LineRow } from '../../documents';
import { StockLedger, StockPostingHandlers, type LedgerPost, type StockPostingCtx } from '../../stock';
import { effectSide, GRN_FEATURE, isUuid, jsonPatch, units } from '../common';
import { GrnHooks } from './grn-hooks';
import { GRN, GRN_LINE, RTV, RTV_LINE, RTV_SOURCE_ACTION } from './grn.types';
import { loadPoLines, receiptCost } from './po-lines';
import { ReceiptLedger } from './receipts';

/** Deterministic uuid from a string (pair ids of retried effects stay the same). */
export function uuidFrom(s: string): string {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Existing batch id of an item by batch number (null when none / empty). */
export async function findBatch(tx: Tx, itemId: string, batchNo: unknown): Promise<string | null> {
  const s = typeof batchNo === 'string' ? batchNo.trim() : '';
  if (!s) return null;
  const r = await tx.selectFrom('app.stock_batch').select('id').where('item_id', '=', itemId).where('batch_no', '=', s).executeTakeFirst();
  return r?.id ?? null;
}

/**
 * Latest receipt movement of a GRN line (QA5-BUG-001: RTVs and QA status moves of those goods carry its cost — specific
 * identification). Null when the line posted no receipt (e.g. legacy data).
 */
export async function receiptMovementOf(tx: Tx, tenantId: string, grnId: string, grnLineId: string): Promise<string | null> {
  const r = await tx.selectFrom('app.stock_movement').select('id').where('tenant_id', '=', tenantId).where('document_id', '=', grnId)
    .where('line_id', '=', grnLineId).where('movement_type', '=', 'receipt').orderBy('id', 'desc').executeTakeFirst();
  return r ? String(r.id) : null;
}

/** True when the movement with this idempotency key was already written (a retried effect). */
export async function alreadyPosted(tx: Tx, key: string | undefined): Promise<boolean> {
  if (!key) return false;
  return !!(await tx.selectFrom('app.stock_movement').select('id').where('idempotency_key', '=', key).executeTakeFirst());
}

/**
 * Stock side of GRN and RTV (registered with the stock module's StockPostingHandlers):
 * - grn × post_stock: receipt of the approved qty into `stockStatus` at each line's receiving location, valued at
 *   the PO rate (setting `stock.cost_includes_tax`), batch/expiry → stock_batch; `accepted` on the GRN and PO lines.
 * - grn × block_stock / unblock_stock: the decided qty (rejected for onReject effects) available ⇄ quarantine, with
 *   the line's batch.
 * - rtv × post_stock: `rtv` movement out of the line's "return from" status; `returned` on the GRN and PO lines.
 * - effect `return_to_vendor`: a draft RTV for the rejected qty of the GRN lines (idempotent per workflow action).
 */
@Injectable()
export class GrnStock implements OnModuleInit {
  constructor(
    private readonly handlers: StockPostingHandlers,
    private readonly ledger: StockLedger,
    private readonly store: DocStore,
    private readonly docs: DocumentsService,
    private readonly receipts: ReceiptLedger,
    private readonly hooks: GrnHooks,
    @Inject(EFFECT_REGISTRY) private readonly effects: EffectRegistry,
  ) {}

  onModuleInit() {
    this.handlers.register(GRN, 'post_stock', ctx => this.grnPost(ctx));
    this.handlers.register(GRN, 'block_stock', ctx => this.grnStatusMove(ctx, 'block'));
    this.handlers.register(GRN, 'unblock_stock', ctx => this.grnStatusMove(ctx, 'unblock'));
    this.handlers.register(RTV, 'post_stock', ctx => this.rtvPost(ctx));
    this.effects.register('return_to_vendor', (_e, c) => this.returnToVendor(c), { requiresFeature: GRN_FEATURE });
  }

  private async lines(ctx: StockPostingCtx, ids: string[]): Promise<Map<string, LineRow>> {
    const all = await this.store.loadLines(ctx.tx, ctx.tenantId, ctx.documentId);
    return new Map(all.filter(l => ids.includes(l.id)).map(l => [l.id, l]));
  }

  // ------------------------------------------------------------------ GRN
  async grnPost(ctx: StockPostingCtx): Promise<StockPost[]> {
    if (!ctx.approved.length) return [];
    const lines = await this.lines(ctx, ctx.approved.map(a => a.lineId));
    const po = await loadPoLines(ctx.tx, ctx.tenantId, [...lines.values()].map(l => l.custom[GRN_LINE.poLine]).filter(isUuid));
    const vendorId = (ctx.snapshot.values.party as string | undefined) ?? null;
    const posts: StockPost[] = [];
    const accepted: { lineId: string; qty: string; poLineId: string | null }[] = [];
    for (const a of ctx.approved) {
      const l = lines.get(a.lineId);
      if (!l?.item_id) continue;
      const key = ctx.key(l.id, 'in');
      if (await alreadyPosted(ctx.tx, key)) continue;
      const batchNo = typeof l.custom[GRN_LINE.batchNo] === 'string' ? (l.custom[GRN_LINE.batchNo] as string).trim() : '';
      const batchId = batchNo
        ? await this.ledger.ensureBatch(ctx.tx, {
          itemId: l.item_id, batchNo, mfgDate: (l.custom[GRN_LINE.mfgDate] as string | undefined) ?? null, expiryDate: (l.custom[GRN_LINE.expiryDate] as string | undefined) ?? null, vendorId,
        })
        : null;
      const ref = l.custom[GRN_LINE.poLine];
      const p = isUuid(ref) ? po.get(ref) : undefined;
      const unitCost = p ? await receiptCost(ctx.tx, p) : (l.rate ?? '0');
      posts.push({
        itemId: l.item_id, nodeId: l.location_node_id, batchId, status: ctx.stockStatus, movementType: 'receipt', qtyIn: a.qty, unitCost,
        documentId: ctx.documentId, lineId: l.id, idempotencyKey: key, reason: null,
      });
      accepted.push({ lineId: l.id, qty: a.qty, poLineId: p?.id ?? null });
    }
    if (accepted.length) {
      await this.store.record(ctx.tx, ctx.tenantId, ctx.documentId, accepted.map(x => ({ lineId: x.lineId, type: 'accepted' as const, qty: x.qty, stageKey: ctx.stageKey, wfActionId: ctx.wfActionId })), ctx.actorId);
      await this.receipts.accept(ctx.tx, ctx.tenantId, accepted.filter(x => x.poLineId).map(x => ({ poLineId: x.poLineId!, qty: units(x.qty), refLineId: x.lineId })), ctx.actorId);
      await this.hooks.refreshFigures(ctx.tx, ctx.tenantId, ctx.documentId);
    }
    return posts;
  }

  async grnStatusMove(ctx: StockPostingCtx, type: 'block' | 'unblock'): Promise<LedgerPost[]> {
    const side = await effectSide(ctx.tx, ctx.documentId, ctx.stageKey, ctx.effect);
    const decided = side === 'rejected' ? ctx.rejected : ctx.approved;
    if (!decided.length) return [];
    const lines = await this.lines(ctx, decided.map(d => d.lineId));
    const [from, to] = type === 'block' ? (['available', 'quarantine'] as const) : (['quarantine', 'available'] as const);
    const posts: LedgerPost[] = [];
    for (const d of decided) {
      const l = lines.get(d.lineId);
      if (!l?.item_id) continue;
      const k = ctx.key(l.id, 'pair');
      const sourceMovementId = await receiptMovementOf(ctx.tx, ctx.tenantId, ctx.documentId, l.id);
      const pairId = uuidFrom(k ?? `${ctx.documentId}:${l.id}:${type}:${Date.now()}`);
      const batchId = await findBatch(ctx.tx, l.item_id, l.custom[GRN_LINE.batchNo]);
      const base = { itemId: l.item_id, nodeId: l.location_node_id, batchId, movementType: type, documentId: ctx.documentId, lineId: l.id, pairId, reason: null } as const;
      posts.push({ ...base, status: from, qtyOut: d.qty, idempotencyKey: ctx.key(l.id, 'out'), sourceMovementId });
      posts.push({ ...base, status: to, qtyIn: d.qty, idempotencyKey: ctx.key(l.id, 'in') });
    }
    return posts;
  }

  // ------------------------------------------------------------------ RTV
  async rtvPost(ctx: StockPostingCtx): Promise<LedgerPost[]> {
    if (!ctx.approved.length) return [];
    const lines = await this.lines(ctx, ctx.approved.map(a => a.lineId));
    const grnRefs = [...lines.values()].map(l => l.custom[RTV_LINE.grnLine]).filter(isUuid);
    const grnLines = grnRefs.length
      ? new Map((await ctx.tx.selectFrom('app.document_line').select(['id', 'document_id', 'custom']).where('tenant_id', '=', ctx.tenantId).where('id', 'in', grnRefs).execute())
        .map(r => [r.id, { id: r.id, documentId: r.document_id, poLineId: (r.custom as Record<string, unknown>)[GRN_LINE.poLine] }]))
      : new Map<string, { id: string; documentId: string; poLineId: unknown }>();
    const posts: LedgerPost[] = [];
    const returned: { grnLine: { id: string; documentId: string; poLineId: unknown }; qty: string; rtvLineId: string }[] = [];
    for (const a of ctx.approved) {
      const l = lines.get(a.lineId);
      if (!l?.item_id) continue;
      const key = ctx.key(l.id, 'out');
      if (await alreadyPosted(ctx.tx, key)) continue;
      const status = (['available', 'quarantine', 'rejected'] as const).find(s => s === l.custom[RTV_LINE.fromStatus]) ?? 'quarantine';
      const ref = l.custom[RTV_LINE.grnLine];
      const g = isUuid(ref) ? grnLines.get(ref) : undefined;
      // QA5-BUG-001: the goods go back at the cost they came in at (the GRN line's receipt movement).
      const src = g ? await receiptMovementOf(ctx.tx, ctx.tenantId, g.documentId, g.id) : null;
      posts.push({
        itemId: l.item_id, nodeId: l.location_node_id, batchId: await findBatch(ctx.tx, l.item_id, l.custom[RTV_LINE.batchNo]), status, movementType: 'rtv', qtyOut: a.qty,
        documentId: ctx.documentId, lineId: l.id, idempotencyKey: key, reason: (l.custom[RTV_LINE.reason] as string | undefined) ?? null,
        ...(src && (await sameNode(ctx, src, l.item_id, l.location_node_id)) ? { sourceMovementId: src } : {}),
      });
      if (g) returned.push({ grnLine: g, qty: a.qty, rtvLineId: l.id });
    }
    const byGrn = new Map<string, typeof returned>();
    for (const r of returned) byGrn.set(r.grnLine.documentId, [...(byGrn.get(r.grnLine.documentId) ?? []), r]);
    for (const [grnId, rs] of [...byGrn.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      await this.store.record(ctx.tx, ctx.tenantId, grnId, rs.map(r => ({ lineId: r.grnLine.id, type: 'returned' as const, qty: r.qty, refLineId: r.rtvLineId })), ctx.actorId);
    }
    await this.receipts.returned(ctx.tx, ctx.tenantId, returned.filter(r => isUuid(r.grnLine.poLineId)).map(r => ({
      poLineId: r.grnLine.poLineId as string, qty: units(r.qty), refLineId: r.rtvLineId, reason: 'Returned to vendor',
    })), ctx.actorId);
    return posts;
  }

  // ------------------------------------------------------------------ return_to_vendor effect

  /** Draft RTV for the rejected qty of the GRN lines in this action (once per workflow action). */
  async returnToVendor(c: EffectContext): Promise<void> {
    const rejected = (c.rejected ?? []).filter(r => units(r.qty) > 0n);
    if (!rejected.length) return;
    const grn = await this.store.loadDoc(c.tx, c.tenantId, c.documentId);
    if (c.wfActionId) {
      const dup = await c.tx.selectFrom('app.document').select('id').where('tenant_id', '=', c.tenantId)
        .where(sql<boolean>`custom->>${RTV_SOURCE_ACTION} = ${c.wfActionId}`).executeTakeFirst();
      if (dup) return;
    }
    const lines = new Map((await this.store.loadLines(c.tx, c.tenantId, c.documentId)).map(l => [l.id, l]));
    const out: { values: Record<string, unknown> }[] = [];
    for (const r of rejected) {
      const l = lines.get(r.lineId);
      if (!l?.item_id) continue;
      const batchId = await findBatch(c.tx, l.item_id, l.custom[GRN_LINE.batchNo]);
      const quarantine = await this.ledger.balanceOf(c.tx, { itemId: l.item_id, nodeId: l.location_node_id, batchId, status: 'quarantine' });
      const fromStatus = units(quarantine.qty) >= units(r.qty) ? 'quarantine' : 'available';
      out.push({
        values: {
          item: l.item_id, uom: l.uom_id, qty: r.qty, rate: l.rate ?? undefined, location: l.location_node_id, [RTV_LINE.grnLine]: l.id, [RTV_LINE.fromStatus]: fromStatus,
          ...(typeof l.custom[GRN_LINE.batchNo] === 'string' && l.custom[GRN_LINE.batchNo] ? { [RTV_LINE.batchNo]: l.custom[GRN_LINE.batchNo] } : {}),
          [RTV_LINE.reason]: 'Rejected in quality check',
        },
      });
    }
    if (!out.length) return;
    const actor = { tenantId: c.tenantId, userId: c.actorId, perms: null };
    const rtv = await this.docs.create(c.tx, actor, RTV, {
      values: { party: grn.party_id, location: grn.location_node_id, grn: grn.id, reason: `Rejected material of ${grn.number ?? 'GRN'}` },
      lines: out,
    });
    if (c.wfActionId) {
      await c.tx.updateTable('app.document').set({ custom: jsonPatch('custom', { [RTV_SOURCE_ACTION]: c.wfActionId }) }).where('tenant_id', '=', c.tenantId).where('id', '=', rtv.id).execute();
    }
    await this.store.emit(c.tx, 'grn.return_to_vendor', { kind: 'document', id: c.documentId }, {
      documentId: c.documentId, rtvId: rtv.id, wfActionId: c.wfActionId, lines: rejected,
    });
  }
}

/** The source receipt is at the RTV line's item × node (an RTV raised from another location falls back to valuation). */
async function sameNode(ctx: StockPostingCtx, movementId: string, itemId: string, nodeId: string): Promise<boolean> {
  const r = await ctx.tx.selectFrom('app.stock_movement').select('id').where('tenant_id', '=', ctx.tenantId).where('id', '=', movementId)
    .where('item_id', '=', itemId).where('node_id', '=', nodeId).executeTakeFirst();
  return !!r;
}

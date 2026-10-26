import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Effect, StockPost } from '@procure/schema';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../../core/errors';
import { DOCUMENTS_PORT, DocumentsPort, EFFECT_REGISTRY, EffectContext, EffectRegistry } from '../../../core/ports';
import { resolveBatch } from '../docs/batch';
import { StockLedger } from '../ledger/stock-ledger.service';
import { LedgerPost, PostedMovement, STOCK_ERRORS, STOCK_FEATURE } from '../ledger/types';
import { StockEffectName, StockPostingCtx, StockPostingHandlers } from './handlers';

/**
 * Workflow effects `post_stock`, `block_stock`, `unblock_stock` (Phase 3 effect registry). Each dispatches to the
 * handler registered for the document's type (StockPostingHandlers) and posts the result through StockLedger in the
 * action's transaction. Idempotent per (wfActionId, effect) through movement idempotency keys built by `ctx.key`.
 * `return_to_vendor` is registered by the GRN module.
 */
@Injectable()
export class StockEffects implements OnModuleInit {
  constructor(
    @Inject(EFFECT_REGISTRY) private readonly registry: EffectRegistry,
    @Inject(DOCUMENTS_PORT) private readonly docs: DocumentsPort,
    private readonly handlers: StockPostingHandlers,
    private readonly ledger: StockLedger,
  ) {}

  onModuleInit() {
    this.registry.register('post_stock', (e, c) => this.run('post_stock', e, c).then(() => undefined), { requiresFeature: STOCK_FEATURE });
    this.registry.register('block_stock', (e, c) => this.run('block_stock', e, c).then(() => undefined), { requiresFeature: STOCK_FEATURE });
    this.registry.register('unblock_stock', (e, c) => this.run('unblock_stock', e, c).then(() => undefined), { requiresFeature: STOCK_FEATURE });
  }

  /** Runs one stock effect for a document (also used by tests). Returns the movements written / found. */
  async run(name: StockEffectName, effect: Effect, c: EffectContext): Promise<PostedMovement[]> {
    const snapshot = await this.docs.snapshot(c.tx, c.documentId, { lock: false });
    const handler = this.handlers.get(snapshot.docTypeKey, name) ?? (name === 'post_stock' ? undefined : (ctx: StockPostingCtx) => genericStatusMove(ctx));
    if (!handler) {
      throw new AppError(409, STOCK_ERRORS.noHandler, `"${name}" is not supported for ${snapshot.docTypeKey} documents.`, { docTypeKey: snapshot.docTypeKey, effect: name });
    }
    const prefix = c.wfActionId ? `wf:${c.wfActionId}:${name}` : null;
    const ctx: StockPostingCtx = {
      tx: c.tx, tenantId: c.tenantId, documentId: c.documentId, docTypeKey: snapshot.docTypeKey, effect: name, stageKey: c.stageKey, wfActionId: c.wfActionId,
      actorId: c.actorId, approved: c.approved ?? [], rejected: c.rejected ?? [],
      stockStatus: effect.effect === 'post_stock' ? effect.stockStatus ?? 'available' : 'available',
      snapshot,
      key: (...parts) => (prefix ? [prefix, ...parts].join(':') : undefined),
    };
    const posts = await handler(ctx);
    const withDoc: LedgerPost[] = posts.map(p => ({ ...p, documentId: p.documentId === undefined ? c.documentId : p.documentId }));
    return this.ledger.post(c.tx, withDoc, c.actorId);
  }
}

/**
 * Generic block / unblock for any item-line document: the qty decided in this action (rejected qty when the action
 * rejected anything — the usual `onReject: block_stock` — else the approved qty) of each line, item × line location,
 * available → quarantine (block) or quarantine → available (unblock), as paired movements.
 */
export async function genericStatusMove(ctx: StockPostingCtx): Promise<StockPost[]> {
  const decided = ctx.effect === 'block_stock' && ctx.rejected.length ? ctx.rejected : ctx.approved.length ? ctx.approved : ctx.rejected;
  if (!decided.length) return [];
  const lines = await ctx.tx.selectFrom('app.document_line').select(['id', 'item_id', 'location_node_id'])
    .where('document_id', '=', ctx.documentId).where('id', 'in', decided.map(d => d.lineId)).execute();
  const byId = new Map(lines.map(l => [l.id, l]));
  const [from, to] = ctx.effect === 'block_stock' ? (['available', 'quarantine'] as const) : (['quarantine', 'available'] as const);
  const type = ctx.effect === 'block_stock' ? 'block' : 'unblock';
  const posts: StockPost[] = [];
  for (const d of decided) {
    const l = byId.get(d.lineId);
    if (!l?.item_id) continue;
    const k = ctx.key(d.lineId, 'pair');
    const pairId = k ? uuidFrom(k) : randomUUID();
    const batchId = await resolveBatch(ctx.tx, l.item_id, ctx.snapshot.lines.find(x => x.id === d.lineId)?.values.batch);
    const base = { itemId: l.item_id, nodeId: l.location_node_id, batchId, movementType: type, lineId: d.lineId, pairId } as const;
    posts.push({ ...base, status: from, qtyOut: d.qty, idempotencyKey: ctx.key(d.lineId, 'out') });
    posts.push({ ...base, status: to, qtyIn: d.qty, idempotencyKey: ctx.key(d.lineId, 'in') });
  }
  return posts;
}

/** Deterministic uuid (v4-shaped) from a string, so retried effects produce the same pair id. */
export function uuidFrom(s: string): string {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

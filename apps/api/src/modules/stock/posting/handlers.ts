import { Injectable } from '@nestjs/common';
import type { StockStatus } from '@procure/schema';
import type { Tx } from '../../../core/db.service';
import type { DocumentSnapshot } from '../../../core/ports';
import type { LedgerPost } from '../ledger/types';

/** Stock workflow effects that dispatch by document type (return_to_vendor is owned by the GRN module). */
export type StockEffectName = 'post_stock' | 'block_stock' | 'unblock_stock';

/** What a doc-type posting handler gets: the effect context plus the document snapshot and an idempotency helper. */
export interface StockPostingCtx {
  tx: Tx;
  tenantId: string;
  documentId: string;
  docTypeKey: string;
  effect: StockEffectName;
  stageKey: string | null;
  wfActionId: string | null;
  actorId: string | null;
  /** Qty decided per line in this workflow action (as passed to the effect). */
  approved: { lineId: string; qty: string }[];
  rejected: { lineId: string; qty: string }[];
  /** `post_stock` parameter: status receipts go into (default available). */
  stockStatus: Extract<StockStatus, 'available' | 'quarantine'>;
  /** Document header + lines (locked by the workflow action). */
  snapshot: DocumentSnapshot;
  /**
   * Builds a deterministic idempotency key for one movement of this effect run:
   * `wf:<wfActionId>:<effect>:<parts…>`; undefined when the effect does not run from a workflow action. Use it for
   * every StockPost so retries never double-post (e.g. `ctx.key(line.id, 'out')`).
   */
  key(...parts: (string | number)[]): string | undefined;
}

/** Turns the document's (decided) lines into ledger posts. Must be pure w.r.t. stock (the dispatcher posts them);
 *  it may write module-specific rows (e.g. PO ledger events) in ctx.tx. Returning [] posts nothing. */
export type StockPostingHandler = (ctx: StockPostingCtx) => Promise<LedgerPost[]>;

/**
 * Registry: doc type key × stock effect → handler. Doc-type modules register in `onModuleInit`:
 *   handlers.register('grn', 'post_stock', ctx => …)
 * The stock module registers stock_transfer / stock_adjustment / stock_count; the GRN/issue module registers grn,
 * rtv, store_issue, store_return. `block_stock` / `unblock_stock` fall back to a generic handler (decided qty of
 * each line, line item × line node, available ⇄ quarantine) when a type registers none.
 */
@Injectable()
export class StockPostingHandlers {
  private readonly map = new Map<string, StockPostingHandler>();

  register(docTypeKey: string, effect: StockEffectName, handler: StockPostingHandler): void {
    const k = `${docTypeKey}:${effect}`;
    if (this.map.has(k)) throw new Error(`stock posting handler ${k} already registered`);
    this.map.set(k, handler);
  }

  get(docTypeKey: string, effect: StockEffectName): StockPostingHandler | undefined {
    return this.map.get(`${docTypeKey}:${effect}`);
  }

  has(docTypeKey: string, effect: StockEffectName): boolean {
    return this.map.has(`${docTypeKey}:${effect}`);
  }
}

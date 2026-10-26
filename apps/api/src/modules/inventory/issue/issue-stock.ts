import { Injectable, OnModuleInit } from '@nestjs/common';
import type { StockPost } from '@procure/schema';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import type { LedgerEvent } from '../../../core/ports';
import { DocStore, type LineRow } from '../../documents';
import { StockPostingHandlers, type StockPostingCtx } from '../../stock';
import { isUuid, q, units } from '../common';
import { alreadyPosted, findBatch } from '../grn/grn-stock';
import { assertNotExpired, expiryCutoff, fefoBalances, refLines } from './issue-hooks';
import { ISSUE_LINE, RETURN_LINE, STORE_ISSUE, STORE_RETURN } from './issue.types';

/**
 * Stock side of store issue / store return (StockPostingHandlers):
 * - store_issue × post_stock: `issue` out of available at the line's location (batch); `issued` on the issue line and
 *   on its request line.
 * - store_return × post_stock: `return` into the line's "return as" status at its location, valued at the issue's
 *   cost; `returned` on the issue line.
 */
@Injectable()
export class IssueStock implements OnModuleInit {
  constructor(private readonly handlers: StockPostingHandlers, private readonly store: DocStore) {}

  onModuleInit() {
    this.handlers.register(STORE_ISSUE, 'post_stock', ctx => this.issuePost(ctx));
    this.handlers.register(STORE_RETURN, 'post_stock', ctx => this.returnPost(ctx));
  }

  private async lines(ctx: StockPostingCtx, ids: string[]): Promise<Map<string, LineRow>> {
    const all = await this.store.loadLines(ctx.tx, ctx.tenantId, ctx.documentId);
    return new Map(all.filter(l => ids.includes(l.id)).map(l => [l.id, l]));
  }

  async issuePost(ctx: StockPostingCtx): Promise<StockPost[]> {
    if (!ctx.approved.length) return [];
    const lines = await this.lines(ctx, ctx.approved.map(a => a.lineId));
    const refs = await refLines(ctx.tx, ctx.tenantId, [...lines.values()].map(l => l.custom[ISSUE_LINE.requestLine]).filter(isUuid));
    const posts: StockPost[] = [];
    const own: LedgerEvent[] = [];
    const byReq = new Map<string, LedgerEvent[]>();
    const cutoff = await expiryCutoff(ctx.tx);
    for (const a of ctx.approved) {
      const l = lines.get(a.lineId);
      if (!l?.item_id) continue;
      const key = ctx.key(l.id, 'out');
      if (await alreadyPosted(ctx.tx, key)) continue;
      const reason = (l.custom.purpose as string | undefined) ?? null;
      const base = { itemId: l.item_id, nodeId: l.location_node_id, status: 'available' as const, movementType: 'issue' as const, documentId: ctx.documentId, lineId: l.id, reason };
      const batchNo = typeof l.custom[ISSUE_LINE.batchNo] === 'string' ? (l.custom[ISSUE_LINE.batchNo] as string).trim() : '';
      if (batchNo) {
        const batchId = await findBatch(ctx.tx, l.item_id, batchNo);
        await assertNotExpired(ctx.tx, batchId, cutoff, l.line_no); // QA5-BUG-010 (re-checked at approval)
        posts.push({ ...base, batchId, qtyOut: a.qty, idempotencyKey: key });
      } else {
        // No batch chosen: allocate FEFO across the batches at the node (one movement per batch used). Any shortfall
        // stays on the last allocation so the ledger reports it (STOCK_NEGATIVE) instead of silently under-issuing.
        let left = units(a.qty);
        const bal = await fefoBalances(ctx.tx, ctx.tenantId, l.item_id, l.location_node_id, cutoff);
        const parts: { batchId: string | null; qty: bigint }[] = [];
        for (const b of bal) {
          if (left <= 0n) break;
          const n = b.qty < left ? b.qty : left;
          parts.push({ batchId: b.batchId, qty: n });
          left -= n;
        }
        if (left > 0n) {
          if (parts.length) parts[parts.length - 1]!.qty += left;
          else parts.push({ batchId: null, qty: left });
        }
        parts.forEach((p, i) => posts.push({ ...base, batchId: p.batchId, qtyOut: q(p.qty), idempotencyKey: i === 0 ? key : ctx.key(l.id, 'out', i) }));
      }
      own.push({ lineId: l.id, type: 'issued', qty: a.qty, stageKey: ctx.stageKey, wfActionId: ctx.wfActionId });
      const ref = l.custom[ISSUE_LINE.requestLine];
      const r = isUuid(ref) ? refs.get(ref) : undefined;
      if (r) byReq.set(r.document_id, [...(byReq.get(r.document_id) ?? []), { lineId: r.id, type: 'issued', qty: a.qty, refLineId: l.id }]);
    }
    await this.store.record(ctx.tx, ctx.tenantId, ctx.documentId, own, ctx.actorId);
    for (const [docId, evs] of [...byReq.entries()].sort(([a], [b]) => a.localeCompare(b))) await this.store.record(ctx.tx, ctx.tenantId, docId, evs, ctx.actorId);
    return posts;
  }

  async returnPost(ctx: StockPostingCtx): Promise<StockPost[]> {
    if (!ctx.approved.length) return [];
    const lines = await this.lines(ctx, ctx.approved.map(a => a.lineId));
    const issueIds = [...lines.values()].map(l => l.custom[RETURN_LINE.issueLine]).filter(isUuid);
    const refs = await refLines(ctx.tx, ctx.tenantId, issueIds);
    const costs = issueIds.length ? new Map((await sql<{ line_id: string; cost: string | null }>`
      select line_id, case when sum(qty_out) > 0 then (-sum(value) / sum(qty_out))::text end as cost from app.stock_movement
      where tenant_id = ${ctx.tenantId} and line_id = any(${sql.val(issueIds)}::uuid[]) and movement_type = 'issue' group by line_id`.execute(ctx.tx)).rows.map(r => [r.line_id, r.cost]))
      : new Map<string, string | null>();
    const posts: StockPost[] = [];
    const byIssue = new Map<string, LedgerEvent[]>();
    for (const a of ctx.approved) {
      const l = lines.get(a.lineId);
      if (!l?.item_id) continue;
      const key = ctx.key(l.id, 'in');
      if (await alreadyPosted(ctx.tx, key)) continue;
      const ref = l.custom[RETURN_LINE.issueLine];
      const r = isUuid(ref) ? refs.get(ref) : undefined;
      const status = l.custom[RETURN_LINE.status] === 'quarantine' ? 'quarantine' : 'available';
      const batchNo = l.custom[RETURN_LINE.batchNo] ?? r?.batch_no ?? null;
      // FEFO-allocated issues carry no batch on the line: return into the batch of the issue's last movement.
      const issuedBatch = !batchNo && r
        ? (await ctx.tx.selectFrom('app.stock_movement').select('batch_id').where('line_id', '=', r.id).where('movement_type', '=', 'issue').orderBy('id', 'desc').executeTakeFirst())?.batch_id ?? null
        : null;
      const cost = r ? costs.get(r.id) : null;
      posts.push({
        itemId: l.item_id, nodeId: l.location_node_id, batchId: issuedBatch ?? await findBatch(ctx.tx, l.item_id, batchNo), status, movementType: 'return', qtyIn: a.qty,
        unitCost: cost ? new Decimal(cost).abs().toDecimalPlaces(6).toString() : '0', documentId: ctx.documentId, lineId: l.id, idempotencyKey: key,
        reason: (l.custom.reason as string | undefined) ?? null,
      });
      if (r) byIssue.set(r.document_id, [...(byIssue.get(r.document_id) ?? []), { lineId: r.id, type: 'returned', qty: a.qty, refLineId: l.id }]);
    }
    for (const [docId, evs] of [...byIssue.entries()].sort(([a], [b]) => a.localeCompare(b))) await this.store.record(ctx.tx, ctx.tenantId, docId, evs, ctx.actorId);
    return posts;
  }
}

import { Injectable } from '@nestjs/common';
import type { Tx } from '../../../core/db.service';
import type { LedgerEvent } from '../../../core/ports';
import { Buckets, DocStore, pendingReceiptUnits } from '../../documents';
import { getTenantSetting } from '../../identity';
import { PoLedger } from '../../procurement';
import { lockSummaries, q, qtyExceeds, units, withTolerance } from '../common';

/** Received quantity that still counts against the order: received − rejected at receipt − (returned, when RTVs
 *  re-open the PO per `rtv.reopens_po`). */
export function netReceived(b: Pick<Buckets, 'received' | 'rejected_at_receipt' | 'returned'>, reopens: boolean): bigint {
  return b.received - b.rejected_at_receipt - (reopens ? b.returned : 0n);
}
export function pendingReceipt(b: Pick<Buckets, 'ordered' | 'received' | 'rejected_at_receipt' | 'returned'>, reopens: boolean): bigint {
  return pendingReceiptUnits(b, reopens);
}
const bk = (r: Record<string, unknown> | undefined) => ({
  ordered: units(r?.ordered), received: units(r?.received), rejected_at_receipt: units(r?.rejected_at_receipt), returned: units(r?.returned),
});

export interface ReceiptPick { poLineId: string; qty: bigint; refLineId: string; reason?: string | null }

/**
 * PO-side quantity hand-offs of receipts (contract "GRN and RTV / Ledger"): `received` on PO lines (and their indent
 * lines) at GRN submit under row locks with the over-receipt tolerance; `rejected_at_receipt` when received goods are
 * sent back before they enter stock (re-opens the pending receipt); `accepted` when they enter stock; `returned` when
 * an RTV moves them out again. Every write recomputes the PO status (partially_received / received).
 */
@Injectable()
export class ReceiptLedger {
  constructor(private readonly store: DocStore, private readonly po: PoLedger) {}

  reopens(tx: Tx): Promise<boolean> {
    return getTenantSetting(tx, 'rtv.reopens_po');
  }

  async poLines(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, { id: string; documentId: string }>> {
    if (!ids.length) return new Map();
    const rows = await tx.selectFrom('app.document_line').select(['id', 'document_id']).where('tenant_id', '=', tenantId).where('id', 'in', [...new Set(ids)]).execute();
    return new Map(rows.map(r => [r.id, { id: r.id, documentId: r.document_id }]));
  }

  /** `received` on the PO lines; 409 QTY_EXCEEDS_REMAINING when a PO line would get more than its pending receipt
   *  plus the tolerance (`grn.over_receipt_pct`). Locks the PO line summaries (line-id order) first. */
  async receive(tx: Tx, tenantId: string, picks: ReceiptPick[], actorId: string | null): Promise<void> {
    const live = picks.filter(p => p.qty > 0n);
    if (!live.length) return;
    const lines = await this.poLines(tx, tenantId, live.map(p => p.poLineId));
    const sums = await lockSummaries(tx, tenantId, [...lines.values()]);
    const [pct, reopens] = [await getTenantSetting(tx, 'grn.over_receipt_pct'), await this.reopens(tx)];
    const asked = new Map<string, bigint>();
    for (const p of live) asked.set(p.poLineId, (asked.get(p.poLineId) ?? 0n) + p.qty);
    for (const [id, want] of asked) {
      const b = bk(sums.get(id));
      const pending = pendingReceipt(b, reopens);
      const max = withTolerance(pending, pct);
      if (want > max) {
        throw qtyExceeds(`Only ${q(pending)} is pending on the PO line (up to ${q(max)} with the ${pct}% tolerance); this receipt has ${q(want)}.`, {
          poLineId: id, pendingReceipt: q(pending), maxReceivable: q(max), asked: q(want), tolerancePct: pct,
        });
      }
    }
    await this.write(tx, tenantId, live, 'received', actorId, lines);
  }

  /** `rejected_at_receipt` (goods sent back before they entered stock): re-opens the PO line's pending receipt. */
  unreceive(tx: Tx, tenantId: string, picks: ReceiptPick[], actorId: string | null) {
    return this.write(tx, tenantId, picks, 'rejected_at_receipt', actorId);
  }

  /** `accepted` (goods entered stock). */
  accept(tx: Tx, tenantId: string, picks: ReceiptPick[], actorId: string | null) {
    return this.write(tx, tenantId, picks, 'accepted', actorId);
  }

  /** `returned` (RTV approved): re-opens the pending receipt when `rtv.reopens_po`. */
  returned(tx: Tx, tenantId: string, picks: ReceiptPick[], actorId: string | null) {
    return this.write(tx, tenantId, picks, 'returned', actorId);
  }

  /** Records `type` on the PO lines (grouped per PO, PO-id order) and mirrors it on their indent lines; recomputes POs. */
  private async write(tx: Tx, tenantId: string, picks: ReceiptPick[], type: LedgerEvent['type'], actorId: string | null, known?: Map<string, { id: string; documentId: string }>) {
    const live = picks.filter(p => p.qty > 0n);
    if (!live.length) return;
    const lines = known ?? await this.poLines(tx, tenantId, live.map(p => p.poLineId));
    const refs = await this.po.sources(tx, tenantId, [...lines.keys()]);
    const byDoc = new Map<string, LedgerEvent[]>();
    const push = (docId: string, e: LedgerEvent) => byDoc.set(docId, [...(byDoc.get(docId) ?? []), e]);
    const poDocs = new Set<string>();
    for (const p of live) {
      const l = lines.get(p.poLineId);
      if (!l) continue;
      poDocs.add(l.documentId);
      const e = { type, qty: q(p.qty), refLineId: p.refLineId, reason: p.reason ?? null };
      push(l.documentId, { lineId: l.id, ...e });
      const r = refs.get(l.id);
      const indentLine = r ? (r.sourceKind === 'indent' ? r.sourceLineId : r.indentLineId) : null;
      const indentDoc = r ? (r.sourceKind === 'indent' ? r.sourceDocId : r.indentDocId) : null;
      if (indentLine && indentDoc) push(indentDoc, { lineId: indentLine, ...e });
    }
    for (const [docId, evs] of [...byDoc.entries()].sort(([a], [b]) => a.localeCompare(b))) await this.store.record(tx, tenantId, docId, evs, actorId);
    for (const id of [...poDocs].sort()) await this.store.recompute(tx, tenantId, id, actorId);
  }

  /** Pending receipt per PO line (net of rejections at receipt and, per setting, returns). */
  async pending(tx: Tx, tenantId: string, poLineIds: string[]): Promise<Map<string, bigint>> {
    const reopens = await this.reopens(tx);
    const sums = await this.store.summaries(tx, tenantId, poLineIds);
    return new Map(poLineIds.map(id => [id, pendingReceipt(sums.get(id) ?? { ordered: 0n, received: 0n, rejected_at_receipt: 0n, returned: 0n }, reopens)]));
  }
}


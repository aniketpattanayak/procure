import { Injectable, OnModuleInit } from '@nestjs/common';
import Decimal from 'decimal.js';
import type { Tx } from '../../../core/db.service';
import type { LedgerEvent } from '../../../core/ports';
import { DocStore, DocumentHooks, type LineOutcomeCtx, type SaveHookCtx, type StatusRuleCtx, type SubmitHookCtx } from '../../documents';
import { validationFailed } from '../../forms';
import { getTenantSetting } from '../../identity';
import { isUuid, jsonPatch, minU, postingRank, q, units } from '../common';
import { GRN, GRN_HEADER, GRN_LINE } from './grn.types';
import { loadPoLines, notReceivable, poNetRate, qcItems } from './po-lines';
import { netReceived, ReceiptLedger } from './receipts';

const OPEN_PO_STATUSES = new Set(['approved', 'partially_approved']);

/**
 * The GRN type's behaviour on the documents core:
 * - onSave: lines must reference open PO lines of the GRN's vendor (one PO unless `grn.multi_po`), same item; the
 *   PO rate is copied; `requires_qc` is derived from the item (or a master linked from it) for the quality stage.
 * - onSubmit: `received` on the PO lines under row locks, within the over-receipt tolerance (409 otherwise).
 * - onLineOutcome: quantity rejected (or cancelled) before it entered stock → `rejected_at_receipt` on the GRN line
 *   and the PO line (re-opens the pending receipt); accepted / rejected figures on the line are kept current.
 * - statusRule('po'): approved POs become `partially_received` / `received` from their receipt buckets.
 */
@Injectable()
export class GrnHooks implements OnModuleInit {
  constructor(private readonly hooks: DocumentHooks, private readonly store: DocStore, private readonly receipts: ReceiptLedger) {}

  onModuleInit() {
    this.hooks.onSave(GRN, (tx, ctx) => this.onSave(tx, ctx));
    this.hooks.onSubmit(GRN, (tx, ctx) => this.onSubmit(tx, ctx));
    this.hooks.onLineOutcome(GRN, (tx, ctx) => this.onOutcome(tx, ctx));
    this.hooks.statusRule('po', (tx, ctx) => this.poStatus(tx, ctx));
    this.hooks.extraStatuses('po', [
      { key: 'partially_received', label: 'Partially received', tone: 'amber', after: 'approved' },
      { key: 'received', label: 'Received', tone: 'green', after: 'partially_received' },
    ]);
  }

  // ------------------------------------------------------------------ save
  async onSave(tx: Tx, ctx: SaveHookCtx): Promise<void> {
    if (ctx.mode === 'line_edits') return;
    const { tenantId, documentId: id } = ctx;
    const doc = await tx.selectFrom('app.document').select(['party_id', 'location_node_id', 'custom']).where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirstOrThrow();
    const lines = await this.store.loadLines(tx, tenantId, id);
    const at = (l: { line_no: number }) => `lines.${l.line_no - 1}`;
    const errors: { path: string; message: string }[] = [];
    const refs = lines.map(l => l.custom[GRN_LINE.poLine]).filter(isUuid);
    const po = await loadPoLines(tx, tenantId, refs);
    const multi = await getTenantSetting(tx, 'grn.multi_po');
    const seen = new Set<string>();
    const poDocs = new Set<string>();
    for (const l of lines) {
      const ref = l.custom[GRN_LINE.poLine];
      if (ref === undefined || ref === null || ref === '') {
        if (ctx.mode === 'submit') errors.push({ path: `${at(l)}.${GRN_LINE.poLine}`, message: 'Receive against a purchase order line.' });
        continue;
      }
      const p = isUuid(ref) ? po.get(ref) : undefined;
      const why = notReceivable(p);
      if (why || !p) { errors.push({ path: `${at(l)}.${GRN_LINE.poLine}`, message: why ?? 'The PO line does not exist.' }); continue; }
      if (seen.has(p.id)) errors.push({ path: `${at(l)}.${GRN_LINE.poLine}`, message: 'The same PO line is used twice on this GRN.' });
      seen.add(p.id);
      poDocs.add(p.document_id);
      if (doc.party_id && p.party_id !== doc.party_id) errors.push({ path: 'party', message: 'The vendor must be the vendor of the purchase order.' });
      if (p.item_id && l.item_id !== p.item_id) errors.push({ path: `${at(l)}.item`, message: 'The item must be the item of the PO line.' });
      const mfg = l.custom[GRN_LINE.mfgDate];
      const exp = l.custom[GRN_LINE.expiryDate];
      if (typeof mfg === 'string' && typeof exp === 'string' && exp < mfg) errors.push({ path: `${at(l)}.${GRN_LINE.expiryDate}`, message: 'The expiry date is before the manufacturing date.' });
    }
    if (poDocs.size > 1 && !multi) errors.push({ path: 'lines', message: 'A GRN receives one purchase order (setting "Allow one GRN for several POs" is off).' });
    if (errors.length) throw validationFailed(errors);

    // Derived values: PO rate (+ amount, header total), requires_qc, header `po`.
    const qc = await qcItems(tx, tenantId, lines.map(l => l.item_id).filter((x): x is string => !!x));
    let total = new Decimal(0);
    for (const l of lines) {
      const ref = l.custom[GRN_LINE.poLine];
      const p = isUuid(ref) ? po.get(ref) : undefined;
      const rate = p ? poNetRate(p) : l.rate;
      const amount = rate === null ? null : new Decimal(l.qty).mul(rate).toDecimalPlaces(2).toString();
      total = total.plus(amount ?? 0);
      const needQc = !!l.item_id && qc.has(l.item_id);
      const rateChanged = rate !== null && (l.rate === null || !new Decimal(l.rate).eq(rate));
      if (rateChanged || l.custom[GRN_LINE.requiresQc] !== needQc || (rate !== null && (l.amount === null || !new Decimal(l.amount).eq(amount!)))) {
        await tx.updateTable('app.document_line').set({ rate, amount, custom: jsonPatch('custom', { [GRN_LINE.requiresQc]: needQc }) })
          .where('tenant_id', '=', tenantId).where('id', '=', l.id).execute();
      }
    }
    const firstPo = [...poDocs][0] ?? null;
    const custom = (doc.custom ?? {}) as Record<string, unknown>;
    if ((custom[GRN_HEADER.po] ?? null) !== firstPo || lines.length) {
      await tx.updateTable('app.document').set({ total_amount: total.toFixed(2), custom: jsonPatch('custom', { [GRN_HEADER.po]: firstPo }) })
        .where('tenant_id', '=', tenantId).where('id', '=', id).execute();
    }
  }

  // ------------------------------------------------------------------ submit
  async onSubmit(tx: Tx, ctx: SubmitHookCtx): Promise<void> {
    const lines = await this.store.loadLines(tx, ctx.tenantId, ctx.documentId);
    await this.receipts.receive(tx, ctx.tenantId, lines.filter(l => isUuid(l.custom[GRN_LINE.poLine])).map(l => ({
      poLineId: String(l.custom[GRN_LINE.poLine]), qty: units(l.qty), refLineId: l.id,
    })), ctx.actor.userId);
  }

  // ------------------------------------------------------------------ outcomes
  async onOutcome(tx: Tx, ctx: LineOutcomeCtx): Promise<void> {
    const back = ctx.events.filter(e => e.type === 'rejected' || e.type === 'cancelled');
    if (back.length) {
      const { order, postRank } = await postingRank(tx, ctx.documentId);
      const rank = (s: string | null | undefined) => (s && order.includes(s) ? order.indexOf(s) : -1);
      const sums = await this.store.summaries(tx, ctx.tenantId, [...new Set(back.map(e => e.lineId))]);
      const lines = new Map((await this.store.loadLines(tx, ctx.tenantId, ctx.documentId)).map(l => [l.id, l]));
      // Quantity of each line still in the chain and not yet in stock: requested − accepted − already sent back.
      const left = new Map([...sums].map(([id, b]) => [id, b.requested - b.accepted - b.rejected_at_receipt]));
      const own: LedgerEvent[] = [];
      const picks: { poLineId: string; qty: bigint; refLineId: string; reason: string | null }[] = [];
      for (const e of back) {
        if (e.type === 'rejected' && rank(e.stageKey) > postRank) continue; // in stock already: disposition / RTV path
        const have = left.get(e.lineId) ?? 0n;
        const n = minU(units(e.qty), have);
        if (n <= 0n) continue;
        left.set(e.lineId, have - n);
        const reason = e.reason ?? (e.type === 'cancelled' ? 'Receipt cancelled' : 'Rejected at receipt');
        own.push({ lineId: e.lineId, type: 'rejected_at_receipt', qty: q(n), stageKey: e.stageKey ?? null, wfActionId: e.wfActionId ?? null, reason });
        const ref = lines.get(e.lineId)?.custom[GRN_LINE.poLine];
        if (isUuid(ref)) picks.push({ poLineId: ref, qty: n, refLineId: e.lineId, reason });
      }
      await this.store.record(tx, ctx.tenantId, ctx.documentId, own, ctx.actorId);
      await this.receipts.unreceive(tx, ctx.tenantId, picks, ctx.actorId);
    }
    await this.refreshFigures(tx, ctx.tenantId, ctx.documentId);
  }

  /** Keeps the line's read-only accepted / rejected figures equal to its ledger (accepted into stock; rejected anywhere). */
  async refreshFigures(tx: Tx, tenantId: string, documentId: string): Promise<void> {
    const lines = await this.store.loadLines(tx, tenantId, documentId);
    const sums = await this.store.summaries(tx, tenantId, lines.map(l => l.id));
    for (const l of lines) {
      const b = sums.get(l.id);
      if (!b) continue;
      const rejected = b.rejected > b.rejected_at_receipt ? b.rejected : b.rejected_at_receipt;
      const patch = { [GRN_LINE.accepted]: q(b.accepted), [GRN_LINE.rejected]: q(rejected) };
      if (l.custom[GRN_LINE.accepted] === patch[GRN_LINE.accepted] && l.custom[GRN_LINE.rejected] === patch[GRN_LINE.rejected]) continue;
      await tx.updateTable('app.document_line').set({ custom: jsonPatch('custom', patch) }).where('tenant_id', '=', tenantId).where('id', '=', l.id).execute();
    }
  }

  // ------------------------------------------------------------------ PO status
  async poStatus(tx: Tx, ctx: StatusRuleCtx): Promise<{ lines: Record<string, string>; statusKey: string } | null> {
    if (!OPEN_PO_STATUSES.has(ctx.statusKey)) return null;
    const reopens = await this.receipts.reopens(tx);
    const out: Record<string, string> = {};
    let any = false;
    for (const l of ctx.lines) {
      const b = l.buckets;
      if (!OPEN_PO_STATUSES.has(l.statusKey) || b.ordered <= 0n) continue;
      const net = netReceived(b, reopens);
      if (net >= b.ordered) out[l.id] = 'received';
      else if (net > 0n) out[l.id] = 'partially_received';
      if (out[l.id]) any = true;
    }
    if (!any) return null;
    const live = ctx.lines.filter(l => !['cancelled', 'rejected'].includes(l.statusKey));
    const done = live.every(l => out[l.id] === 'received' || l.statusKey === 'closed');
    return { lines: out, statusKey: done ? 'received' : 'partially_received' };
  }
}

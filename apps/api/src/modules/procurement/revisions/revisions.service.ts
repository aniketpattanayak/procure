import { Injectable } from '@nestjs/common';
import type { AmendInput, DocumentRow, RevisionDiff, RevisionRow } from '@procure/schema';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit.service';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import type { LedgerEvent } from '../../../core/ports';
import {
  dateStr, docAction, DocActor, DocStore, DocumentsService, fromUnits, type LineOutcomeCtx, pendingReceiptUnits, type ResubmitHookCtx, toUnits,
} from '../../documents';
import { getTenantSetting } from '../../identity';
import { jsonPatch, PoDerived } from '../po/po-derived';
import { PoLedger } from '../po/po-ledger';
import { AMENDING, PO, RESERVED } from '../po/po.type';
import { diffSnapshots, isEmptyDiff, Snapshot, SnapLine } from './diff';

/** Open amendment bookkeeping kept in document.custom[RESERVED.amend]. */
interface AmendState {
  reason: string; baseRev: number; by: string | null; at: string;
  phase: 'editing' | 'approval';
  rev?: number;
  /** lineId -> qty routed through the workflow at resubmit. */
  routed?: Record<string, string>;
  /** lineId -> decided qty so far (workflow approvals/rejections kept out of the ledger). */
  decided?: Record<string, { approved: string; rejected: string }>;
}

const WF_TYPES = new Set(['approved', 'rejected', 'held', 'unheld', 'cancelled']);
const isDate = (v: unknown) => (v instanceof Date ? dateStr(v) : v);

/**
 * PO amendments (contract "Amendment flow"): rev 0 is the PO as first approved; `amend` opens the approved PO for
 * editing (status `amending`); resubmit writes rev N+1 (open) with its diff and runs the PO workflow on the amended
 * document. While it is in approval the workflow's approved/rejected quantities are kept out of the ledger
 * (DocumentHooks.beforeRecord); when every routed line is decided the amendment is applied (ledger deltas
 * `ordered` / `order_cancelled` on the PO lines and their sources, rev_no = N+1) — or, if any quantity was
 * rejected, the PO is restored from rev N (revision `rejected`). All-or-nothing by design.
 */
@Injectable()
export class RevisionsService {
  constructor(
    private readonly docs: DocumentsService,
    private readonly store: DocStore,
    private readonly ledger: PoLedger,
    private readonly derived: PoDerived,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ snapshots
  async snapshot(tx: Tx, tenantId: string, docId: string): Promise<Snapshot> {
    const d = await tx.selectFrom('app.document').select(['number', 'rev_no', 'location_node_id', 'doc_date', 'required_by', 'party_id', 'currency', 'total_amount', 'custom'])
      .where('tenant_id', '=', tenantId).where('id', '=', docId).executeTakeFirstOrThrow();
    const lines = await tx.selectFrom('app.document_line').select(['id', 'line_no', 'item_id', 'uom_id', 'qty', 'rate', 'amount', 'required_date', 'location_node_id', 'custom'])
      .where('tenant_id', '=', tenantId).where('document_id', '=', docId).where('is_deleted', '=', false).orderBy('line_no').execute();
    const custom = { ...(d.custom as Record<string, unknown>) };
    delete custom[RESERVED.amend];
    return {
      number: d.number, revNo: d.rev_no,
      header: {
        location_node_id: d.location_node_id, doc_date: String(isDate(d.doc_date)), required_by: (isDate(d.required_by) as string | null) ?? null,
        party_id: d.party_id, currency: d.currency, total_amount: d.total_amount, custom,
      },
      lines: lines.map(l => ({ ...l, required_date: dateStr(l.required_date), custom: (l.custom ?? {}) as Record<string, unknown> })) as SnapLine[],
    };
  }

  private async revision(tx: Tx, tenantId: string, docId: string, revNo: number) {
    return tx.selectFrom('app.document_revision').selectAll().where('tenant_id', '=', tenantId).where('document_id', '=', docId).where('rev_no', '=', revNo).executeTakeFirst();
  }

  /** Writes the current PO as revision `rev_no` (status approved) when it does not exist yet. */
  async ensureBase(tx: Tx, tenantId: string, docId: string, actorId: string | null): Promise<Snapshot> {
    const snap = await this.snapshot(tx, tenantId, docId);
    const have = await this.revision(tx, tenantId, docId, snap.revNo);
    if (have) return have.snapshot as unknown as Snapshot;
    await tx.insertInto('app.document_revision').values({
      tenant_id: tenantId, document_id: docId, rev_no: snap.revNo, snapshot: JSON.stringify(snap), diff: null, reason: snap.revNo === 0 ? 'First approval' : null,
      status: 'approved', created_by: actorId,
    }).execute();
    return snap;
  }

  /** T&C bodies of the PO's `terms` copied into the document so later master edits never change an issued PO. */
  async snapshotTerms(tx: Tx, tenantId: string, docId: string) {
    const d = await tx.selectFrom('app.document').select('custom').where('tenant_id', '=', tenantId).where('id', '=', docId).executeTakeFirstOrThrow();
    const ids = ((d.custom as Record<string, unknown>).terms as unknown[] | undefined)?.filter((x): x is string => typeof x === 'string') ?? [];
    const rows = ids.length
      ? await tx.selectFrom('app.master_record').select(['id', 'code', 'name', 'data']).where('tenant_id', '=', tenantId).where('id', 'in', ids).execute()
      : [];
    const byId = new Map(rows.map(r => [r.id, r]));
    const terms = ids.filter(id => byId.has(id)).map(id => {
      const r = byId.get(id)!;
      return { code: r.code, name: r.name, body: String((r.data as Record<string, unknown>).body ?? '') };
    });
    await tx.updateTable('app.document').set({ custom: jsonPatch('custom', { [RESERVED.terms]: terms }) }).where('tenant_id', '=', tenantId).where('id', '=', docId).execute();
  }

  /** First approval done (nothing left in approval): T&C snapshot + rev 0. */
  async onApprovalComplete(tx: Tx, tenantId: string, docId: string, actorId: string | null) {
    await this.snapshotTerms(tx, tenantId, docId);
    await this.ensureBase(tx, tenantId, docId, actorId);
  }

  private state(custom: unknown): AmendState | null {
    const a = (custom as Record<string, unknown> | null)?.[RESERVED.amend];
    return a && typeof a === 'object' ? a as AmendState : null;
  }

  private async setState(tx: Tx, tenantId: string, docId: string, s: AmendState | null) {
    await tx.updateTable('app.document').set({ custom: jsonPatch('custom', { [RESERVED.amend]: s }) }).where('tenant_id', '=', tenantId).where('id', '=', docId).execute();
  }

  private async labels(tx: Tx, tenantId: string) {
    const type = await this.store.types.load(tx, tenantId, PO);
    const b = await this.store.bundle(tx, tenantId, type);
    const map = (m: Map<string, { label: string }>) => Object.fromEntries([...m].map(([k, f]) => [k, f.label]));
    return { header: map(b.headerFields), line: { ...map(b.lineFields), schedule: 'Delivery schedule' } };
  }

  // ------------------------------------------------------------------ amend / withdraw
  async amend(tx: Tx, actor: DocActor, id: string, input: z.infer<typeof AmendInput>): Promise<DocumentRow> {
    const type = await this.docs.typeFor(tx, actor, PO);
    if (actor.perms && !actor.perms.keys.includes(docAction(PO, 'amend'))) throw AppError.forbidden();
    const doc = await this.docs.access(tx, actor, type, id, true);
    if (doc.cancelled_at || doc.closed_at) throw AppError.conflict('A cancelled or closed purchase order cannot be amended.');
    // Phase 5: a partially received PO can be amended (quantities never below what is already received).
    if (!['approved', 'partially_approved', 'partially_received'].includes(doc.status_key)) throw AppError.conflict('Only approved (or partially approved / partially received) purchase orders can be amended.');
    const sums = await this.store.summaries(tx, actor.tenantId, (await this.store.loadLines(tx, actor.tenantId, id)).map(l => l.id));
    const reopens = await getTenantSetting(tx, 'rtv.reopens_po');
    let ordered = 0n; let pending = 0n;
    for (const b of sums.values()) { ordered += b.ordered; pending += pendingReceiptUnits(b, reopens); }
    if (ordered > 0n && pending <= 0n) throw AppError.conflict('This purchase order is fully received; it cannot be amended.');
    const base = await this.ensureBase(tx, actor.tenantId, id, actor.userId);
    const st: AmendState = { reason: input.reason, baseRev: base.revNo, by: actor.userId, at: new Date().toISOString(), phase: 'editing' };
    await this.setState(tx, actor.tenantId, id, st);
    await tx.updateTable('app.document').set({ status_key: AMENDING, is_locked: false, updated_by: actor.userId }).where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    await this.audit.tenant(tx, { action: 'amend', entity: 'document', entityId: id, actorId: actor.userId, before: { status: doc.status_key, revNo: base.revNo }, after: { status: AMENDING, reason: input.reason } });
    await this.store.emit(tx, 'document.status_changed', { kind: 'document', id }, { documentId: id, docTypeKey: PO, number: doc.number, from: doc.status_key, to: AMENDING, reason: input.reason });
    return this.docs.toRow(tx, actor, type, await this.store.loadDoc(tx, actor.tenantId, id));
  }

  /** Abandons an amendment that has not been resubmitted: values back to the current revision. */
  async withdraw(tx: Tx, actor: DocActor, id: string): Promise<DocumentRow> {
    const type = await this.docs.typeFor(tx, actor, PO);
    if (actor.perms && !actor.perms.keys.includes(docAction(PO, 'amend'))) throw AppError.forbidden();
    const doc = await this.docs.access(tx, actor, type, id, true);
    const st = this.state(doc.custom);
    if (!st || st.phase !== 'editing') throw AppError.conflict('This purchase order has no amendment being edited.');
    const base = await this.revision(tx, actor.tenantId, id, st.baseRev);
    if (!base) throw AppError.conflict('The revision to return to is missing.');
    await this.restore(tx, actor.tenantId, id, base.snapshot as unknown as Snapshot, actor.userId);
    await this.audit.tenant(tx, { action: 'amend_withdraw', entity: 'document', entityId: id, actorId: actor.userId, after: { revNo: st.baseRev } });
    return this.docs.toRow(tx, actor, type, await this.store.loadDoc(tx, actor.tenantId, id));
  }

  /** Writes a snapshot back (columns + custom; lines added since are removed), recomputes derived values + status. */
  private async restore(tx: Tx, tenantId: string, docId: string, snap: Snapshot, actorId: string | null) {
    const h = snap.header;
    await tx.updateTable('app.document').set({
      location_node_id: h.location_node_id, doc_date: h.doc_date, required_by: h.required_by, party_id: h.party_id, currency: h.currency,
      total_amount: h.total_amount, custom: JSON.stringify(h.custom), is_locked: true, updated_by: actorId,
      // A status the recompute below replaces from the ledger.
      status_key: 'submitted',
    }).where('tenant_id', '=', tenantId).where('id', '=', docId).execute();
    const keep = new Set(snap.lines.map(l => l.id));
    const cur = await tx.selectFrom('app.document_line').select('id').where('tenant_id', '=', tenantId).where('document_id', '=', docId).where('is_deleted', '=', false).execute();
    const drop = cur.map(c => c.id).filter(id => !keep.has(id));
    if (drop.length) await tx.updateTable('app.document_line').set({ is_deleted: true, updated_by: actorId }).where('tenant_id', '=', tenantId).where('id', 'in', drop).execute();
    if (keep.size) {
      await tx.updateTable('app.document_line').set(eb => ({ line_no: eb('line_no', '+', 100000) })).where('tenant_id', '=', tenantId).where('id', 'in', [...keep]).execute();
    }
    for (const l of snap.lines) {
      await tx.updateTable('app.document_line').set({
        line_no: l.line_no, item_id: l.item_id, uom_id: l.uom_id, qty: l.qty, rate: l.rate, amount: l.amount, required_date: l.required_date,
        location_node_id: l.location_node_id, custom: JSON.stringify(l.custom), is_deleted: false, updated_by: actorId,
      }).where('tenant_id', '=', tenantId).where('id', '=', l.id).execute();
    }
    await this.derived.refresh(tx, tenantId, docId);
    await this.store.recompute(tx, tenantId, docId, actorId);
  }

  // ------------------------------------------------------------------ resubmit (DocumentHooks.onResubmit)
  async resubmit(tx: Tx, ctx: ResubmitHookCtx): Promise<boolean> {
    const { tenantId, documentId: id, actor } = ctx;
    const doc = await this.store.loadDoc(tx, tenantId, id, { lock: true });
    const st = this.state(doc.custom);
    if (!st) return false;
    if (!(ctx.statusKey === AMENDING || (ctx.statusKey === 'draft' && st.phase === 'approval'))) return false;
    const base = await this.revision(tx, tenantId, id, st.baseRev);
    if (!base) throw AppError.conflict('The revision this amendment started from is missing.');
    const cur = await this.snapshot(tx, tenantId, id);
    const errors: { path: string; message: string }[] = [];
    if (!cur.header.party_id) errors.push({ path: 'party', message: 'Vendor is required.' });
    cur.lines.forEach((l, i) => {
      if (toUnits(l.qty) > 0n && (l.rate === null || l.rate === undefined)) errors.push({ path: `lines.${i}.rate`, message: 'Rate is required.' });
    });
    // Phase 5: never below the quantity already received (net of rejections at receipt and, per setting, returns).
    const sums = await this.store.summaries(tx, tenantId, cur.lines.map(l => l.id));
    const reopens = await getTenantSetting(tx, 'rtv.reopens_po');
    cur.lines.forEach((l, i) => {
      const b = sums.get(l.id);
      if (!b) return;
      const net = b.received - b.rejected_at_receipt - (reopens ? b.returned : 0n);
      if (net > 0n && toUnits(l.qty) < net) errors.push({ path: `lines.${i}.qty`, message: `${fromUnits(net)} has already been received on this line; the quantity cannot be lower.` });
    });
    if (errors.length) throw new AppError(400, 'VALIDATION_FAILED', 'Some fields are invalid', undefined, errors);
    // QA47-BUG-003: quantity added beyond what the source has left is refused here (409 to the buyer), not first at
    // approval (where finalize re-checks under lock, since the source may move in between).
    const baseQty = new Map((base.snapshot as unknown as Snapshot).lines.map(l => [l.id, toUnits(l.qty)]));
    const plus: { poLineId: string; qty: bigint }[] = [];
    const minus: { poLineId: string; qty: bigint }[] = [];
    for (const l of cur.lines) {
      const q = toUnits(l.qty);
      if (baseQty.has(l.id) && baseQty.get(l.id) === q) continue;
      const delta = q - (sums.get(l.id)?.ordered ?? 0n);
      if (delta > 0n) plus.push({ poLineId: l.id, qty: delta });
      else if (delta < 0n) minus.push({ poLineId: l.id, qty: -delta });
    }
    await this.ledger.checkDeltas(tx, tenantId, plus, minus);
    const diff = diffSnapshots(base.snapshot as unknown as Snapshot, cur, await this.labels(tx, tenantId));
    if (isEmptyDiff(diff)) throw AppError.conflict('Nothing was changed. Withdraw the amendment instead.');
    if (st.rev !== undefined) {
      await tx.updateTable('app.document_revision').set({ status: 'withdrawn' }).where('tenant_id', '=', tenantId).where('document_id', '=', id)
        .where('rev_no', '=', st.rev).where('status', '=', 'open').execute();
    }
    const max = await tx.selectFrom('app.document_revision').select(sql<number>`coalesce(max(rev_no), 0)::int`.as('m')).where('tenant_id', '=', tenantId).where('document_id', '=', id).executeTakeFirst();
    const revNo = (max?.m ?? 0) + 1;
    await tx.insertInto('app.document_revision').values({
      tenant_id: tenantId, document_id: id, rev_no: revNo, snapshot: JSON.stringify({ ...cur, revNo }), diff: JSON.stringify(diff), reason: st.reason, status: 'open', created_by: actor.userId,
    }).execute();
    const routed = Object.fromEntries(cur.lines.filter(l => toUnits(l.qty) > 0n).map(l => [l.id, fromUnits(toUnits(l.qty))]));
    await this.setState(tx, tenantId, id, { ...st, phase: 'approval', rev: revNo, routed, decided: {} });
    await tx.updateTable('app.document').set({ status_key: 'submitted', is_locked: true, updated_by: actor.userId }).where('tenant_id', '=', tenantId).where('id', '=', id).execute();
    await this.audit.tenant(tx, { action: 'amend_submit', entity: 'document', entityId: id, actorId: actor.userId, after: { revNo, reason: st.reason, diff } });
    const port = this.store.wf.port;
    if (port && Object.keys(routed).length) await port.start(tx, id, actor.userId ?? doc.created_by ?? '');
    else await this.finalize(tx, tenantId, id, actor.userId, { ...st, phase: 'approval', rev: revNo, routed, decided: {} }, false);
    await this.store.recompute(tx, tenantId, id, actor.userId);
    return true;
  }

  // ------------------------------------------------------------------ approval bookkeeping (DocumentHooks.beforeRecord)
  async beforeRecord(tx: Tx, ctx: LineOutcomeCtx): Promise<LedgerEvent[]> {
    const d = await tx.selectFrom('app.document').select('custom').where('tenant_id', '=', ctx.tenantId).where('id', '=', ctx.documentId).executeTakeFirst();
    const st = this.state(d?.custom);
    if (!st || st.phase !== 'approval' || !st.routed) return ctx.events;
    const routed = st.routed;
    const decided = { ...(st.decided ?? {}) };
    const keep: LedgerEvent[] = [];
    let touched = false;
    for (const e of ctx.events) {
      if (routed[e.lineId] === undefined || !WF_TYPES.has(e.type)) { keep.push(e); continue; }
      touched = true;
      if (e.type !== 'approved' && e.type !== 'rejected') continue;
      const cur = decided[e.lineId] ?? { approved: '0', rejected: '0' };
      cur[e.type] = fromUnits(toUnits(cur[e.type]) + toUnits(e.qty));
      decided[e.lineId] = cur;
    }
    if (!touched) return keep;
    const done = Object.entries(routed).every(([lid, q]) => {
      const x = decided[lid];
      return !!x && toUnits(x.approved) + toUnits(x.rejected) >= toUnits(q);
    });
    const next = { ...st, decided };
    if (!done) await this.setState(tx, ctx.tenantId, ctx.documentId, next);
    else await this.finalize(tx, ctx.tenantId, ctx.documentId, ctx.actorId, next, Object.values(decided).some(x => toUnits(x.rejected) > 0n));
    return keep;
  }

  private async finalize(tx: Tx, tenantId: string, id: string, actorId: string | null, st: AmendState, rejected: boolean) {
    await this.setState(tx, tenantId, id, null);
    const base = (await this.revision(tx, tenantId, id, st.baseRev))!.snapshot as unknown as Snapshot;
    const rev = await this.revision(tx, tenantId, id, st.rev!);
    const doc = await this.store.loadDoc(tx, tenantId, id);
    if (rejected) {
      await this.restore(tx, tenantId, id, base, actorId);
      await tx.updateTable('app.document_revision').set({ status: 'rejected' }).where('tenant_id', '=', tenantId).where('document_id', '=', id).where('rev_no', '=', st.rev!).execute();
      await this.audit.tenant(tx, { action: 'amend_rejected', entity: 'document', entityId: id, actorId, after: { revNo: st.rev, restoredRev: st.baseRev } });
      await this.store.emit(tx, 'po.amendment_rejected', { kind: 'document', id }, { documentId: id, docTypeKey: PO, number: doc.number, revNo: st.rev, restoredRev: st.baseRev });
      return;
    }
    // Ledger deltas for lines whose quantity changed (or that were added).
    const baseQty = new Map(base.lines.map(l => [l.id, toUnits(l.qty)]));
    const lines = await this.store.loadLines(tx, tenantId, id);
    const sums = await this.store.summaries(tx, tenantId, lines.map(l => l.id));
    const plus: LedgerEvent[] = [];
    const minus: LedgerEvent[] = [];
    const orderSrc: { poLineId: string; qty: bigint }[] = [];
    const unorderSrc: { poLineId: string; qty: bigint }[] = [];
    const reason = `Amendment Rev ${st.rev}`;
    for (const l of lines) {
      const q = toUnits(l.qty);
      if (baseQty.has(l.id) && baseQty.get(l.id) === q) continue;
      const ordered = sums.get(l.id)?.ordered ?? 0n;
      const delta = q - ordered;
      if (delta > 0n) {
        plus.push({ lineId: l.id, type: 'requested', qty: fromUnits(delta), reason }, { lineId: l.id, type: 'approved', qty: fromUnits(delta), reason });
        orderSrc.push({ poLineId: l.id, qty: delta });
      } else if (delta < 0n) {
        minus.push({ lineId: l.id, type: 'order_cancelled', qty: fromUnits(-delta), reason });
        unorderSrc.push({ poLineId: l.id, qty: -delta });
      }
    }
    // Releases first, so quantity moved between lines of the same source can be re-ordered.
    await this.store.record(tx, tenantId, id, minus, actorId);
    await this.ledger.unorder(tx, tenantId, unorderSrc, actorId, reason);
    await this.store.record(tx, tenantId, id, plus, actorId);
    await this.ledger.order(tx, tenantId, orderSrc, actorId, { check: true, reason });
    await tx.updateTable('app.document').set({ rev_no: st.rev! }).where('tenant_id', '=', tenantId).where('id', '=', id).execute();
    await tx.updateTable('app.document_revision').set({ status: 'approved' }).where('tenant_id', '=', tenantId).where('document_id', '=', id).where('rev_no', '=', st.rev!).execute();
    await this.snapshotTerms(tx, tenantId, id);
    await this.derived.refresh(tx, tenantId, id);
    await this.audit.tenant(tx, { action: 'amend_approved', entity: 'document', entityId: id, actorId, after: { revNo: st.rev } });
    await this.store.emit(tx, 'po.amended', { kind: 'document', id }, {
      documentId: id, docTypeKey: PO, number: doc.number, revNo: st.rev, reason: st.reason, diff: (rev?.diff ?? null) as RevisionDiff | null,
    });
  }

  // ------------------------------------------------------------------ reads
  async list(tx: Tx, actor: DocActor, id: string): Promise<RevisionRow[]> {
    const type = await this.docs.typeFor(tx, actor, PO);
    const doc = await this.docs.access(tx, actor, type, id);
    // QA3-BUG-007: revision diffs never carry fields the viewer cannot read.
    const hidden = this.store.hiddenFields(actor, await this.store.bundleFor(tx, actor.tenantId, type, doc));
    const visible = (d: RevisionDiff | null): RevisionDiff | null => (!d ? d : {
      ...d,
      header: d.header.filter(f => !hidden.header.has(f.field)),
      lines: d.lines.map(l => ({ ...l, fields: l.fields.filter(f => !hidden.line.has(f.field)) })).filter(l => l.change !== 'changed' || l.fields.length),
    });
    const rows = await tx.selectFrom('app.document_revision as r').leftJoin('app.tenant_user as u', 'u.id', 'r.created_by')
      .select(['r.rev_no', 'r.status', 'r.reason', 'r.created_at', 'r.diff', 'u.name']).where('r.tenant_id', '=', actor.tenantId).where('r.document_id', '=', id)
      .orderBy('r.rev_no').execute();
    return rows.map(r => ({
      revNo: r.rev_no, status: r.status, reason: r.reason, createdAt: new Date(r.created_at).toISOString(), createdBy: r.name ?? null,
      diff: visible((r.diff ?? null) as RevisionDiff | null),
    }));
  }

  /** True while an amendment is open (editing or in approval). */
  isAmending(custom: unknown): boolean {
    return !!this.state(custom);
  }
}

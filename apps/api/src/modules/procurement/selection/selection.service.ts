import { Injectable, OnModuleInit } from '@nestjs/common';
import { DocumentRow, ErrorCode, OrderableLine, Page, SelectionCreate } from '@procure/schema';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import type { z } from 'zod';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import type { LedgerEvent } from '../../../core/ports';
import {
  type DocActor, DocStore, DocumentHooks, DocumentsService, fromUnits, type LineOutcomeCtx, type SubmitHookCtx, toUnits,
} from '../../documents';
import { scopeCondition } from '../../permissions';
import { decodeCursor, getTenantSetting, likePattern, toPage } from '../../identity';
import { dateOnly, IndentLine, IndentLines, isOpen, qtyExceeds, selectable } from '../indent/indent-lines';
import { INDENT, SELECTION } from '../installer/a-steps';

type Create = z.infer<typeof SelectionCreate>;
const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);
const can = (a: DocActor, key: string) => a.perms === null || a.perms.keys.includes(key);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export const OVER_APPROVE_KEY = `doc.${SELECTION}:action.over_approve`;

export interface SelectableQuery { item?: string; location?: string; q?: string; cursor?: string; limit: number }

/** One selection line as stored (values keyed by the vendor_selection line form). */
interface SelLine { id: string; lineNo: number; indentLineId: string | null; vendorId: string | null; quoteId: string | null; qty: bigint; rate: string | null; reason: string | null; itemId: string | null }

/**
 * Vendor selection (contract "Ledger semantics" + SelectionCreate): selectable lines, POST /procurement/selections,
 * and the two document hooks — on submit, consume the indent lines' approved quantity (`selected`, plus
 * `over_approved` for any excess within the over-approval cap, with permission and reason) under row locks; on a
 * rejection/cancellation of selection quantity, give it back (`selection_cancelled`).
 */
@Injectable()
export class SelectionService implements OnModuleInit {
  constructor(
    private readonly docs: DocumentsService, private readonly store: DocStore, private readonly hooks: DocumentHooks, private readonly lines: IndentLines,
  ) {}

  onModuleInit() {
    this.hooks.onSubmit(SELECTION, (tx, ctx) => this.onSubmit(tx, ctx));
    this.hooks.onLineOutcome(SELECTION, (tx, ctx) => this.onOutcome(tx, ctx));
  }

  // ------------------------------------------------------------------ selectable lines
  async selectable(tx: Tx, actor: DocActor, q: SelectableQuery): Promise<Page<OrderableLine>> {
    const cur = decodeCursor(q.cursor);
    const avail = sql<string>`(s.approved + s.over_approved - s.selected - s.short_closed)`;
    let qb = tx.selectFrom('app.document_line as l')
      .innerJoin('app.document as d', 'd.id', 'l.document_id')
      .innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id')
      .innerJoin('app.line_qty_summary as s', 's.line_id', 'l.id')
      .innerJoin('app.location_node as n', 'n.id', 'd.location_node_id')
      .leftJoin('app.master_record as i', 'i.id', 'l.item_id')
      .leftJoin('app.master_record as u', 'u.id', 'l.uom_id')
      .select(['l.id', 'l.line_no', 'l.created_at', 'd.number', 'l.item_id', 'i.code as item_code', 'i.name as item_name', 'u.code as uom_code', 'd.location_node_id',
        'n.name as loc_name', 'l.required_date', avail.as('avail')])
      .where('l.tenant_id', '=', actor.tenantId).where('t.key', '=', INDENT).where('l.is_deleted', '=', false).where('d.is_deleted', '=', false)
      .where('d.closed_at', 'is', null).where('d.cancelled_at', 'is', null).where('l.status_key', 'not in', ['closed', 'cancelled', 'rejected', 'draft', 'submitted'])
      .where(sql<boolean>`(s.approved + s.over_approved - s.selected - s.short_closed) > 0`)
      .where(scopeCondition(sql`n.path`, this.store.scopeFilter(actor, SELECTION)));
    if (q.item) qb = qb.where('l.item_id', '=', q.item);
    if (q.location) qb = qb.where(sql<boolean>`n.path <@ (select p.path from app.location_node p where p.id = ${q.location})`);
    if (q.q) {
      const pat = likePattern(q.q);
      qb = qb.where(eb => eb.or([eb('d.number', 'ilike', pat), eb(sql`i.code::text`, 'ilike', pat), eb('i.name', 'ilike', pat)]));
    }
    if (cur) {
      qb = qb.where(eb => eb.or([eb('l.created_at', '>', new Date(cur.t)), eb.and([eb('l.created_at', '=', new Date(cur.t)), eb('l.id', '>', String(cur.id))])]));
    }
    const rows = await qb.orderBy('l.created_at').orderBy('l.id').limit(q.limit + 1).execute();
    return toPage(rows, q.limit, r => ({ t: r.created_at, id: r.id }), (r): OrderableLine => ({
      sourceLineId: r.id, sourceKind: 'indent', indentLineId: r.id, indentNumber: r.number, lineNo: r.line_no,
      item: r.item_id ? { id: r.item_id, code: r.item_code ?? '', name: r.item_name ?? '' } : null, uom: r.uom_code ?? null, vendor: null, rate: null,
      location: { id: r.location_node_id, name: r.loc_name }, requiredDate: r.required_date ? dateOnly(r.required_date) : null,
      pendingOrder: fromUnits(toUnits(new Decimal(r.avail).toDecimalPlaces(4).toFixed())),
    }));
  }

  // ------------------------------------------------------------------ create
  async create(tx: Tx, actor: DocActor, input: Create): Promise<DocumentRow> {
    if (!(await getTenantSetting(tx, 'flow.vendor_selection.enabled'))) throw new AppError(409, 'FLOW_DISABLED', 'Vendor selection is turned off for this company.');
    if (input.submit && !can(actor, `doc.${SELECTION}:action.submit`)) throw AppError.forbidden();
    const indent = await this.lines.load(tx, actor, input.lines.map(l => l.indentLineId), { scopeType: SELECTION });
    const rows = input.lines.map((l, i) => {
      const il = indent.get(l.indentLineId);
      if (!il) throw new AppError(404, ErrorCode.NOT_FOUND, 'Indent line not found.', { path: `lines.${i}.indentLineId` });
      if (!isOpen(il) || il.buckets.approved + il.buckets.over_approved <= 0n) throw bad(`lines.${i}.indentLineId`, `Line ${il.lineNo} of ${il.number ?? 'the indent'} is not approved or is closed.`);
      return { il, l };
    });
    await this.checkQuotes(tx, actor.tenantId, input.lines.map((l, i) => ({ path: `lines.${i}.quoteId`, quoteId: l.quoteId ?? null, indentLineId: l.indentLineId, vendorId: l.vendorId })));
    const values: Record<string, unknown> = { ...input.values };
    values.location ??= rows[0]!.il.locationId;
    const doc = await this.docs.create(tx, actor, SELECTION, {
      values,
      lines: rows.map(({ il, l }) => ({
        values: {
          indent_line: il.id, item: il.itemId, ...(il.uomId ? { uom: il.uomId } : {}), qty: l.qty, rate: l.rate, vendor: l.vendorId,
          ...(l.quoteId ? { quote: l.quoteId } : {}), ...(l.reason ? { reason: l.reason } : {}), ...(il.requiredDate ? { required_date: il.requiredDate } : {}),
        },
      })),
    });
    if (!input.submit) return doc;
    return this.docs.submit(tx, actor, SELECTION, doc.id, doc.version);
  }

  private async checkQuotes(tx: Tx, tenantId: string, list: { path: string; quoteId: string | null; indentLineId: string; vendorId: string | null }[]) {
    const ids = list.map(x => x.quoteId).filter((x): x is string => !!x);
    if (!ids.length) return;
    const rows = new Map((await tx.selectFrom('app.vendor_quote').select(['id', 'indent_line_id', 'vendor_id']).where('tenant_id', '=', tenantId).where('id', 'in', ids).execute()).map(r => [r.id, r]));
    for (const x of list) {
      if (!x.quoteId) continue;
      const q = rows.get(x.quoteId);
      if (!q || q.indent_line_id !== x.indentLineId || q.vendor_id !== x.vendorId) throw bad(x.path, 'The quote does not belong to this indent line and vendor.');
    }
  }

  // ------------------------------------------------------------------ submit hook
  private async loadSelLines(tx: Tx, tenantId: string, documentId: string, ids?: string[]): Promise<SelLine[]> {
    let q = tx.selectFrom('app.document_line').select(['id', 'line_no', 'item_id', 'qty', 'rate', 'custom']).where('tenant_id', '=', tenantId)
      .where('document_id', '=', documentId).where('is_deleted', '=', false);
    if (ids) q = q.where('id', 'in', ids);
    return (await q.orderBy('line_no').execute()).map(r => {
      const c = (r.custom ?? {}) as Record<string, unknown>;
      return {
        id: r.id, lineNo: r.line_no, itemId: r.item_id, qty: toUnits(String(r.qty)), rate: r.rate, indentLineId: str(c.indent_line), vendorId: str(c.vendor),
        quoteId: str(c.quote), reason: str(c.reason),
      };
    });
  }

  /** Net quantity already selected on indent lines for these selection lines (selected − selection_cancelled). */
  private async alreadySelected(tx: Tx, tenantId: string, selLineIds: string[]): Promise<Map<string, bigint>> {
    if (!selLineIds.length) return new Map();
    const rows = await sql<{ ref: string; net: string }>`
      select ref_line_id as ref, sum(case event_type when 'selected' then qty else -qty end)::text as net from app.line_event
       where tenant_id = ${tenantId} and ref_line_id = any(${sql.val(selLineIds)}::uuid[]) and event_type in ('selected', 'selection_cancelled')
       group by ref_line_id`.execute(tx);
    return new Map(rows.rows.map(r => [r.ref, toUnits(new Decimal(r.net).toDecimalPlaces(4).toFixed())]));
  }

  async onSubmit(tx: Tx, ctx: SubmitHookCtx): Promise<void> {
    const { tenantId, documentId, actor } = ctx;
    const sel = await this.loadSelLines(tx, tenantId, documentId);
    sel.forEach((l, i) => {
      if (!l.indentLineId) throw bad(`lines.${i}.indent_line`, `Line ${l.lineNo} is not linked to an indent line. Create selections from approved indent lines.`);
      if (!l.vendorId) throw bad(`lines.${i}.vendor`, 'Vendor is required.');
    });
    const vendors = [...new Set(sel.map(l => l.vendorId!))];
    const vrows = new Map((await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id').select(['r.id', 'r.is_active', 'r.is_deleted', 'd.key'])
      .where('r.tenant_id', '=', tenantId).where('r.id', 'in', vendors).execute()).map(r => [r.id, r]));
    sel.forEach((l, i) => {
      const v = vrows.get(l.vendorId!);
      if (!v || v.key !== 'vendor' || v.is_deleted || !v.is_active) throw bad(`lines.${i}.vendor`, 'Choose an active vendor.');
    });
    await this.checkQuotes(tx, tenantId, sel.map((l, i) => ({ path: `lines.${i}.quote`, quoteId: l.quoteId, indentLineId: l.indentLineId!, vendorId: l.vendorId })));

    // Lock the indent lines' summaries (line-id order) and re-read them: two selections on the same approved qty
    // serialise here and the second sees what the first consumed.
    const indent = await this.lines.load(tx, actor, sel.map(l => l.indentLineId!), { lockSummaries: true, scopeType: SELECTION });
    const done = await this.alreadySelected(tx, tenantId, sel.map(l => l.id));
    const need = new Map<string, { il: IndentLine; lines: { l: SelLine; i: number; qty: bigint }[]; total: bigint }>();
    sel.forEach((l, i) => {
      const il = indent.get(l.indentLineId!);
      if (!il) throw new AppError(404, ErrorCode.NOT_FOUND, 'Indent line not found.', { path: `lines.${i}.indent_line` });
      if (!isOpen(il)) throw bad(`lines.${i}.indent_line`, `Line ${il.lineNo} of ${il.number ?? 'the indent'} is not approved or is closed.`);
      if (l.itemId && il.itemId && l.itemId !== il.itemId) throw bad(`lines.${i}.item`, 'The item must match the indent line.');
      const qty = l.qty - (done.get(l.id) ?? 0n);
      if (qty <= 0n) return;
      const e = need.get(il.id) ?? { il, lines: [], total: 0n };
      e.lines.push({ l, i, qty });
      e.total += qty;
      need.set(il.id, e);
    });
    if (!need.size) return;

    const pct = await getTenantSetting(tx, 'selection.max_over_approval_pct');
    const byDoc = new Map<string, LedgerEvent[]>();
    const overByLine = new Map<string, bigint>();
    for (const e of need.values()) {
      const b = e.il.buckets;
      const avail = selectable(b);
      let excess = e.total > avail ? e.total - avail : 0n;
      const events = byDoc.get(e.il.documentId) ?? [];
      if (excess > 0n) {
        const label = `line ${e.il.lineNo} of ${e.il.number ?? 'the indent'}`;
        const meta = { indentLineId: e.il.id, selectable: fromUnits(avail), requested: fromUnits(e.total) };
        if (!can(actor, OVER_APPROVE_KEY)) throw qtyExceeds(`Only ${fromUnits(avail)} is left to select on ${label}.`, meta);
        // Cap: total over-approval on the line ≤ max % of its approved qty (4-decimal units, rounded down).
        const cap = (b.approved * BigInt(Math.round(pct * 10000))) / 1000000n;
        if (b.over_approved + excess > cap) {
          throw qtyExceeds(`Selecting ${fromUnits(e.total)} on ${label} exceeds the approved quantity by more than the allowed ${pct}%.`, { ...meta, maxOverApprovalPct: pct });
        }
        const withReason = e.lines.find(x => x.l.reason && x.l.reason.trim().length >= 3);
        if (!withReason) throw bad(`lines.${e.lines[e.lines.length - 1]!.i}.reason`, `Give a reason for selecting more than the approved quantity on ${label}.`);
        events.push({ lineId: e.il.id, type: 'over_approved', qty: fromUnits(excess), refLineId: withReason.l.id, reason: withReason.l.reason });
        // over_qty shown on the selection lines: the excess is attributed to the last lines of that indent line.
        for (const x of [...e.lines].reverse()) {
          if (excess <= 0n) break;
          const part = x.qty < excess ? x.qty : excess;
          overByLine.set(x.l.id, part);
          excess -= part;
        }
      }
      for (const x of e.lines) events.push({ lineId: e.il.id, type: 'selected', qty: fromUnits(x.qty), refLineId: x.l.id, reason: x.l.reason });
      byDoc.set(e.il.documentId, events);
    }
    for (const [docId, events] of [...byDoc.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      await this.store.record(tx, tenantId, docId, events, actor.userId);
    }
    await tx.insertInto('app.line_link').values([...need.values()].flatMap(e => e.lines.map(x => ({
      tenant_id: tenantId, from_line_id: e.il.id, to_line_id: x.l.id, link_type: 'selected', qty: fromUnits(x.qty), created_by: actor.userId,
    })))).execute();
    for (const [lineId, over] of overByLine) {
      await tx.updateTable('app.document_line').set({ custom: sql`custom || jsonb_build_object('over_qty', ${new Decimal(fromUnits(over)).toFixed(3)}::text)` })
        .where('tenant_id', '=', tenantId).where('id', '=', lineId).execute();
    }
    await this.store.emit(tx, 'selection.submitted', { kind: 'document', id: documentId }, {
      documentId, docTypeKey: SELECTION, submittedBy: actor.userId,
      lines: [...need.values()].flatMap(e => e.lines.map(x => ({ selectionLineId: x.l.id, indentLineId: e.il.id, vendorId: x.l.vendorId, qty: fromUnits(x.qty), rate: x.l.rate }))),
      overApproved: [...overByLine.entries()].map(([lineId, q]) => ({ selectionLineId: lineId, qty: fromUnits(q) })),
    });
  }

  // ------------------------------------------------------------------ outcome hook
  /** Rejected / cancelled selection quantity goes back to the indent line (`selection_cancelled`). */
  async onOutcome(tx: Tx, ctx: LineOutcomeCtx): Promise<void> {
    const lost = new Map<string, bigint>();
    for (const e of ctx.events) if (e.type === 'rejected' || e.type === 'cancelled') lost.set(e.lineId, (lost.get(e.lineId) ?? 0n) + toUnits(e.qty));
    if (!lost.size) return;
    const sel = await this.loadSelLines(tx, ctx.tenantId, ctx.documentId, [...lost.keys()]);
    const done = await this.alreadySelected(tx, ctx.tenantId, sel.map(l => l.id));
    const targets = sel.filter(l => l.indentLineId && (done.get(l.id) ?? 0n) > 0n);
    if (!targets.length) return;
    const docs = new Map((await tx.selectFrom('app.document_line').select(['id', 'document_id']).where('tenant_id', '=', ctx.tenantId)
      .where('id', 'in', targets.map(l => l.indentLineId!)).execute()).map(r => [r.id, r.document_id]));
    const reason = ctx.events.find(e => e.reason)?.reason ?? null;
    const byDoc = new Map<string, LedgerEvent[]>();
    for (const l of targets) {
      const docId = docs.get(l.indentLineId!);
      if (!docId) continue;
      const qty = lost.get(l.id)! < done.get(l.id)! ? lost.get(l.id)! : done.get(l.id)!;
      const list = byDoc.get(docId) ?? [];
      list.push({ lineId: l.indentLineId!, type: 'selection_cancelled', qty: fromUnits(qty), refLineId: l.id, reason });
      byDoc.set(docId, list);
    }
    for (const [docId, events] of [...byDoc.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      await this.store.record(tx, ctx.tenantId, docId, events, ctx.actorId);
    }
    await this.releaseOverApproval(tx, ctx, byDoc, reason);
    // Links whose selection line has nothing left (fully rejected / cancelled) are marked cancelled.
    const after = await this.alreadySelected(tx, ctx.tenantId, targets.map(l => l.id));
    const dead = targets.filter(l => (after.get(l.id) ?? 0n) <= 0n).map(l => l.id);
    if (dead.length) {
      await tx.updateTable('app.line_link').set({ is_cancelled: true }).where('tenant_id', '=', ctx.tenantId).where('link_type', '=', 'selected')
        .where('to_line_id', 'in', dead).execute();
    }
  }

  /**
   * QA47-BUG-001: over-approval exists only to cover selected qty beyond the approved qty. After a selection cut, the
   * part no longer in use (over_approved − max(0, selected + short_closed − approved)) is taken back with
   * `over_approval_cancelled`, so the excess is not selectable again without the over_approve key and a reason.
   */
  private async releaseOverApproval(tx: Tx, ctx: LineOutcomeCtx, byDoc: Map<string, LedgerEvent[]>, reason: string | null): Promise<void> {
    for (const [docId, cancelled] of [...byDoc.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const ids = [...new Set(cancelled.map(e => e.lineId))];
      const rows = await tx.selectFrom('app.line_qty_summary').select(['line_id', 'approved', 'over_approved', 'selected', 'short_closed'])
        .where('tenant_id', '=', ctx.tenantId).where('line_id', 'in', ids).orderBy('line_id').execute();
      const events: LedgerEvent[] = [];
      for (const r of rows) {
        const over = toUnits(r.over_approved);
        if (over <= 0n) continue;
        const inUse = toUnits(r.selected) + toUnits(r.short_closed) - toUnits(r.approved);
        const release = over - (inUse > 0n ? inUse : 0n);
        if (release > 0n) {
          events.push({ lineId: r.line_id, type: 'over_approval_cancelled', qty: fromUnits(release), refLineId: cancelled.find(e => e.lineId === r.line_id)?.refLineId ?? null, reason });
        }
      }
      if (events.length) await this.store.record(tx, ctx.tenantId, docId, events, ctx.actorId);
    }
  }
}

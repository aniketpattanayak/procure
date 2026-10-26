import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import type { LedgerEvent } from '../../../core/ports';
import { DocStore, fromUnits, toUnits } from '../../documents';
import { INDENT, SELECTION } from '../installer/a-steps';

export interface SourceRef {
  poLineId: string;
  /** The line the PO line was created from (selection line, or indent line when vendor selection is off). */
  sourceLineId: string;
  sourceDocId: string;
  sourceKind: 'selection' | 'indent';
  /** Indent line behind a selection line (null for indent sources: the source IS the indent line). */
  indentLineId: string | null;
  indentDocId: string | null;
}

/** approved + over_approved − ordered (net of order_cancelled) − short_closed, never negative. */
export const orderableUnits = (s: Record<string, unknown> | undefined): bigint => {
  if (!s) return 0n;
  const v = toUnits(String(s.approved ?? 0)) + toUnits(String(s.over_approved ?? 0)) - toUnits(String(s.ordered ?? 0)) - toUnits(String(s.short_closed ?? 0));
  return v < 0n ? 0n : v;
};

export const qtyExceedsRemaining = (message: string, meta: Record<string, unknown>) => new AppError(409, 'QTY_EXCEEDS_REMAINING', message, meta);

/**
 * Quantity hand-offs between a PO and its sources (contract "Ledger semantics"): `ordered` on the selection line and
 * its indent line (or the indent line alone) at PO submit, `order_cancelled` back for rejected / cancelled /
 * short-closed PO qty, plus `line_link` rows. Source summaries are locked (FOR UPDATE, line-id order) before the
 * remaining quantity is checked, so two POs ordering the same remaining qty serialise and exactly one succeeds.
 */
@Injectable()
export class PoLedger {
  constructor(private readonly store: DocStore) {}

  /** Source refs of PO lines (lines without `source_line` are direct lines and are skipped). */
  async sources(tx: Tx, tenantId: string, poLineIds: string[]): Promise<Map<string, SourceRef>> {
    const out = new Map<string, SourceRef>();
    if (!poLineIds.length) return out;
    const po = await tx.selectFrom('app.document_line').select(['id', sql<string | null>`custom->>'source_line'`.as('src')])
      .where('tenant_id', '=', tenantId).where('id', 'in', poLineIds).execute();
    const srcIds = [...new Set(po.map(p => p.src).filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))];
    if (!srcIds.length) return out;
    const src = await tx.selectFrom('app.document_line as l').innerJoin('app.document as d', 'd.id', 'l.document_id').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id')
      .select(['l.id', 'l.document_id', 't.key', sql<string | null>`l.custom->>'indent_line'`.as('indent_line')])
      .where('l.tenant_id', '=', tenantId).where('l.id', 'in', srcIds).execute();
    const indentIds = src.map(s => s.indent_line).filter((x): x is string => !!x);
    const indents = indentIds.length
      ? new Map((await tx.selectFrom('app.document_line').select(['id', 'document_id']).where('tenant_id', '=', tenantId).where('id', 'in', indentIds).execute()).map(r => [r.id, r.document_id]))
      : new Map<string, string>();
    const byId = new Map(src.map(s => [s.id, s]));
    for (const p of po) {
      const s = p.src ? byId.get(p.src) : undefined;
      if (!s || (s.key !== SELECTION && s.key !== INDENT)) continue;
      const indentLineId = s.key === SELECTION ? s.indent_line : null;
      out.set(p.id, {
        poLineId: p.id, sourceLineId: s.id, sourceDocId: s.document_id, sourceKind: s.key === SELECTION ? 'selection' : 'indent',
        indentLineId, indentDocId: indentLineId ? indents.get(indentLineId) ?? null : null,
      });
    }
    return out;
  }

  /** Creates (if missing) and locks the summary rows of `lineIds` in line-id order; returns them by line id. */
  private async lock(tx: Tx, tenantId: string, lines: { id: string; documentId: string }[]) {
    const uniq = [...new Map(lines.map(l => [l.id, l])).values()];
    if (!uniq.length) return new Map<string, Record<string, unknown>>();
    await tx.insertInto('app.line_qty_summary').values(uniq.map(l => ({ line_id: l.id, tenant_id: tenantId, document_id: l.documentId })))
      .onConflict(oc => oc.column('line_id').doNothing()).execute();
    const rows = await tx.selectFrom('app.line_qty_summary').selectAll().where('tenant_id', '=', tenantId).where('line_id', 'in', uniq.map(l => l.id))
      .orderBy('line_id').forUpdate().execute();
    return new Map(rows.map(r => [r.line_id, r as unknown as Record<string, unknown>]));
  }

  private async recordGrouped(tx: Tx, tenantId: string, events: (LedgerEvent & { documentId: string })[], actorId: string | null) {
    const byDoc = new Map<string, LedgerEvent[]>();
    for (const { documentId, ...e } of events) byDoc.set(documentId, [...(byDoc.get(documentId) ?? []), e]);
    for (const [docId, evs] of [...byDoc.entries()].sort(([a], [b]) => a.localeCompare(b))) await this.store.record(tx, tenantId, docId, evs, actorId);
  }

  /**
   * `ordered` on the sources of PO lines. With `check`, the source's remaining orderable qty must cover the total
   * asked from it in this call (409 QTY_EXCEEDS_REMAINING otherwise).
   */
  async order(tx: Tx, tenantId: string, picks: { poLineId: string; qty: bigint }[], actorId: string | null, opts: { check: boolean; reason?: string }) {
    const live = picks.filter(p => p.qty > 0n);
    const refs = await this.sources(tx, tenantId, live.map(p => p.poLineId));
    const used = live.filter(p => refs.has(p.poLineId));
    if (!used.length) return;
    const lockList = used.flatMap(p => {
      const r = refs.get(p.poLineId)!;
      return [{ id: r.sourceLineId, documentId: r.sourceDocId }, ...(r.indentLineId && r.indentDocId ? [{ id: r.indentLineId, documentId: r.indentDocId }] : [])];
    });
    const sums = await this.lock(tx, tenantId, lockList);
    if (opts.check) {
      const asked = new Map<string, bigint>();
      for (const p of used) {
        const src = refs.get(p.poLineId)!.sourceLineId;
        asked.set(src, (asked.get(src) ?? 0n) + p.qty);
      }
      for (const [src, q] of asked) {
        const left = orderableUnits(sums.get(src));
        if (q > left) {
          const poLine = used.find(p => refs.get(p.poLineId)!.sourceLineId === src)!.poLineId;
          throw qtyExceedsRemaining(`Only ${fromUnits(left)} is left to order on the source line; this order asks for ${fromUnits(q)}.`, { lineId: poLine, sourceLineId: src, remaining: fromUnits(left), asked: fromUnits(q) });
        }
      }
    }
    const events: (LedgerEvent & { documentId: string })[] = [];
    for (const p of used) {
      const r = refs.get(p.poLineId)!;
      const qty = fromUnits(p.qty);
      events.push({ documentId: r.sourceDocId, lineId: r.sourceLineId, type: 'ordered', qty, refLineId: p.poLineId, reason: opts.reason ?? null });
      if (r.indentLineId && r.indentDocId) events.push({ documentId: r.indentDocId, lineId: r.indentLineId, type: 'ordered', qty, refLineId: p.poLineId, reason: opts.reason ?? null });
    }
    await this.recordGrouped(tx, tenantId, events, actorId);
    const links = used.flatMap(p => {
      const r = refs.get(p.poLineId)!;
      const qty = fromUnits(p.qty);
      return [r.sourceLineId, ...(r.indentLineId ? [r.indentLineId] : [])].map(from => ({ tenant_id: tenantId, from_line_id: from, to_line_id: p.poLineId, link_type: 'ordered', qty, created_by: actorId }));
    });
    if (links.length) await tx.insertInto('app.line_link').values(links).execute();
  }

  /**
   * QA47-BUG-003: dry-run of an amendment's ledger deltas: per source line, (qty added − qty released) must fit in what
   * the source has left to order (409 QTY_EXCEEDS_REMAINING otherwise). Locks the source summaries; records nothing.
   */
  async checkDeltas(tx: Tx, tenantId: string, plus: { poLineId: string; qty: bigint }[], minus: { poLineId: string; qty: bigint }[]) {
    const live = plus.filter(p => p.qty > 0n);
    if (!live.length) return;
    const refs = await this.sources(tx, tenantId, [...live, ...minus].map(p => p.poLineId));
    const asked = new Map<string, { q: bigint; poLineId: string | null; documentId: string }>();
    for (const [list, sign] of [[live, 1n], [minus.filter(p => p.qty > 0n), -1n]] as const) {
      for (const p of list) {
        const r = refs.get(p.poLineId);
        if (!r) continue;
        const cur = asked.get(r.sourceLineId) ?? { q: 0n, poLineId: null, documentId: r.sourceDocId };
        cur.q += sign * p.qty;
        if (sign > 0n && !cur.poLineId) cur.poLineId = p.poLineId;
        asked.set(r.sourceLineId, cur);
      }
    }
    const need = [...asked.entries()].filter(([, a]) => a.q > 0n);
    if (!need.length) return;
    const sums = await this.lock(tx, tenantId, need.map(([id, a]) => ({ id, documentId: a.documentId })));
    for (const [src, a] of need) {
      const left = orderableUnits(sums.get(src));
      if (a.q > left) {
        throw qtyExceedsRemaining(`Only ${fromUnits(left)} more can be ordered on the source line; this amendment adds ${fromUnits(a.q)}.`,
          { lineId: a.poLineId, sourceLineId: src, remaining: fromUnits(left), asked: fromUnits(a.q) });
      }
    }
  }

  /** `order_cancelled` back on the sources (capped at what is still ordered there; never fails on a source). */
  async unorder(tx: Tx, tenantId: string, picks: { poLineId: string; qty: bigint }[], actorId: string | null, reason: string | null) {
    const live = picks.filter(p => p.qty > 0n);
    const refs = await this.sources(tx, tenantId, live.map(p => p.poLineId));
    const used = live.filter(p => refs.has(p.poLineId));
    if (!used.length) return;
    const lockList = used.flatMap(p => {
      const r = refs.get(p.poLineId)!;
      return [{ id: r.sourceLineId, documentId: r.sourceDocId }, ...(r.indentLineId && r.indentDocId ? [{ id: r.indentLineId, documentId: r.indentDocId }] : [])];
    });
    const sums = await this.lock(tx, tenantId, lockList);
    const left = new Map([...sums].map(([id, s]) => [id, toUnits(String(s.ordered ?? 0))]));
    const events: (LedgerEvent & { documentId: string })[] = [];
    const take = (lineId: string, documentId: string, q: bigint, poLineId: string) => {
      const have = left.get(lineId) ?? 0n;
      const n = q > have ? have : q;
      if (n <= 0n) return;
      left.set(lineId, have - n);
      events.push({ documentId, lineId, type: 'order_cancelled', qty: fromUnits(n), refLineId: poLineId, reason });
    };
    for (const p of used) {
      const r = refs.get(p.poLineId)!;
      take(r.sourceLineId, r.sourceDocId, p.qty, p.poLineId);
      if (r.indentLineId && r.indentDocId) take(r.indentLineId, r.indentDocId, p.qty, p.poLineId);
    }
    await this.recordGrouped(tx, tenantId, events, actorId);
  }
}

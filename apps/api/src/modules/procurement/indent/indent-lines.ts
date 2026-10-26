import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { type DocActor, DocStore, fromUnits, toUnits } from '../../documents';
import { INDENT } from '../installer/a-steps';

export const QTY_BUCKETS = ['requested', 'approved', 'held', 'rejected', 'cancelled', 'short_closed', 'over_approved', 'selected', 'ordered'] as const;
export type QtyBucket = (typeof QTY_BUCKETS)[number];
export type LineBuckets = Record<QtyBucket, bigint>;

export interface IndentLine {
  id: string; documentId: string; number: string | null; lineNo: number; itemId: string | null; uomId: string | null; qty: string;
  requiredDate: string | null; statusKey: string; locationId: string; locationName: string; locPath: string;
  docClosed: boolean; docCancelled: boolean; docStatus: string; buckets: LineBuckets;
}

/** Selectable for vendor selection: approved + over_approved − selected (net of selection_cancelled) − short_closed. */
export const selectable = (b: LineBuckets): bigint => {
  const v = b.approved + b.over_approved - b.selected - b.short_closed;
  return v < 0n ? 0n : v;
};
/** Orderable straight from the indent (vendor selection off): approved + over_approved − ordered − short_closed. */
export const orderableFromIndent = (b: LineBuckets): bigint => {
  const v = b.approved + b.over_approved - b.ordered - b.short_closed;
  return v < 0n ? 0n : v;
};
export const isOpen = (l: IndentLine) => !l.docClosed && !l.docCancelled && !['closed', 'cancelled', 'rejected', 'draft', 'submitted'].includes(l.statusKey);

export const qtyExceeds = (message: string, meta: Record<string, unknown>) => new AppError(409, 'QTY_EXCEEDS_REMAINING', message, meta);

/** Loads indent lines (with document, location and ledger buckets) by id; out-of-scope or unknown lines are 404. */
@Injectable()
export class IndentLines {
  constructor(private readonly store: DocStore) {}

  async load(tx: Tx, actor: DocActor, ids: string[], opts: { lockSummaries?: boolean; scopeCheck?: boolean; scopeType?: string } = {}): Promise<Map<string, IndentLine>> {
    const uniq = [...new Set(ids)];
    const out = new Map<string, IndentLine>();
    if (!uniq.length) return out;
    const rows = await tx.selectFrom('app.document_line as l')
      .innerJoin('app.document as d', 'd.id', 'l.document_id')
      .innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id')
      .innerJoin('app.location_node as n', 'n.id', 'd.location_node_id')
      .select(['l.id', 'l.document_id', 'd.number', 'l.line_no', 'l.item_id', 'l.uom_id', 'l.qty', 'l.required_date', 'l.status_key', 'd.location_node_id',
        'n.name as loc_name', sql<string>`n.path::text`.as('loc_path'), 'd.closed_at', 'd.cancelled_at', 'd.status_key as doc_status'])
      .where('l.tenant_id', '=', actor.tenantId).where('l.id', 'in', uniq).where('l.is_deleted', '=', false).where('d.is_deleted', '=', false)
      .where('t.key', '=', INDENT).execute();
    if (opts.lockSummaries) {
      await tx.insertInto('app.line_qty_summary').values(rows.map(r => ({ line_id: r.id, tenant_id: actor.tenantId, document_id: r.document_id })))
        .onConflict(oc => oc.column('line_id').doNothing()).execute();
    }
    let q = tx.selectFrom('app.line_qty_summary').selectAll().where('tenant_id', '=', actor.tenantId).where('line_id', 'in', uniq).orderBy('line_id');
    if (opts.lockSummaries) q = q.forUpdate();
    const sums = new Map((await q.execute()).map(s => [s.line_id, s as unknown as Record<string, string>]));
    for (const r of rows) {
      if (opts.scopeCheck !== false && !this.store.inScope(actor, opts.scopeType ?? INDENT, r.loc_path)) continue;
      const s = sums.get(r.id);
      const buckets = Object.fromEntries(QTY_BUCKETS.map(k => [k, toUnits(s?.[k] ?? '0')])) as LineBuckets;
      out.set(r.id, {
        id: r.id, documentId: r.document_id, number: r.number, lineNo: r.line_no, itemId: r.item_id, uomId: r.uom_id, qty: fromUnits(toUnits(r.qty)),
        requiredDate: r.required_date ? dateOnly(r.required_date) : null, statusKey: r.status_key, locationId: r.location_node_id, locationName: r.loc_name,
        locPath: r.loc_path, docClosed: !!r.closed_at, docCancelled: !!r.cancelled_at, docStatus: r.doc_status, buckets,
      });
    }
    return out;
  }

  async one(tx: Tx, actor: DocActor, id: string, opts: { lockSummaries?: boolean; scopeType?: string } = {}): Promise<IndentLine> {
    const l = (await this.load(tx, actor, [id], opts)).get(id);
    if (!l) throw AppError.notFound('Indent line');
    return l;
  }
}

export function dateOnly(v: unknown): string {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}

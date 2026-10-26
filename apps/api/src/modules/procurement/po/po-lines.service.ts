import { Injectable } from '@nestjs/common';
import type { DocumentRow, OrderableLine, Page, PoFromLines } from '@procure/schema';
import { Expression, sql, SqlBool } from 'kysely';
import { z } from 'zod';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { dateStr, docAction, DocActor, DocStore, DocumentsService, fromUnits, toUnits } from '../../documents';
import { decodeCursor, getTenantSetting, likePattern, toPage } from '../../identity';
import { scopeCondition } from '../../permissions';
import { INDENT, SELECTION } from '../installer/a-steps';
import { orderableUnits } from './po-ledger';
import { PO } from './po.type';

export const OrderableQuery = z.object({
  vendor: z.string().uuid().optional(),
  item: z.string().uuid().optional(),
  location: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

interface Row {
  id: string; document_id: string; created_at: Date; type_key: string; number: string | null; item_id: string | null; uom_id: string | null; rate: string | null;
  required_date: string | null; vendor_id: string | null; indent_line_id: string | null; indent_number: string | null; indent_required: string | null;
  loc_id: string; loc_name: string; item_code: string | null; item_name: string | null; vendor_code: string | null; vendor_name: string | null;
  uom_code: string | null; line_no: number; item_tax_code: string | null; approved: string; over_approved: string; ordered: string; short_closed: string;
}

/**
 * Orderable lines and "create POs from lines" (contract endpoints `/procurement/orderable-lines`,
 * `/procurement/po/from-lines`). Sources are approved vendor-selection lines, or approved indent lines when
 * `flow.vendor_selection.enabled` is off. Drafts reserve nothing; the remaining qty is consumed at PO submit.
 */
@Injectable()
export class PoLinesService {
  constructor(private readonly docs: DocumentsService, private readonly store: DocStore) {}

  private async query(tx: Tx, actor: DocActor, f: z.infer<typeof OrderableQuery> & { ids?: string[] }, selectionOn: boolean, applyScope: boolean): Promise<Row[]> {
    const typeKey = selectionOn ? SELECTION : INDENT;
    const conds: Expression<SqlBool>[] = [
      sql<SqlBool>`l.tenant_id = ${actor.tenantId}`, sql<SqlBool>`not l.is_deleted`, sql<SqlBool>`not d.is_deleted`, sql<SqlBool>`t.key = ${typeKey}`,
      sql<SqlBool>`d.closed_at is null`, sql<SqlBool>`d.cancelled_at is null`, sql<SqlBool>`d.status_key not in ('draft', 'submitted', 'cancelled', 'closed', 'rejected')`,
      sql<SqlBool>`l.status_key not in ('draft', 'submitted', 'cancelled', 'closed', 'rejected')`,
    ];
    if (!f.ids) conds.push(sql<SqlBool>`(coalesce(s.approved, 0) + coalesce(s.over_approved, 0) - coalesce(s.ordered, 0) - coalesce(s.short_closed, 0)) > 0`);
    if (f.ids) conds.push(sql<SqlBool>`l.id = any(${sql.val(f.ids)}::uuid[])`);
    if (applyScope) conds.push(scopeCondition(sql.ref('n.path'), this.store.scopeFilter(actor, PO)));
    if (f.item) conds.push(sql<SqlBool>`l.item_id = ${f.item}`);
    if (f.vendor) conds.push(selectionOn ? sql<SqlBool>`l.custom->>'vendor' = ${f.vendor}` : sql<SqlBool>`false`);
    if (f.location) conds.push(sql<SqlBool>`n.path <@ (select path from app.location_node where tenant_id = ${actor.tenantId} and id = ${f.location})`);
    if (f.q) {
      const p = likePattern(f.q);
      conds.push(sql<SqlBool>`(d.number ilike ${p} or ind.number ilike ${p} or it.name ilike ${p} or it.code::text ilike ${p} or ven.name ilike ${p})`);
    }
    const cur = decodeCursor(f.cursor);
    if (cur) conds.push(sql<SqlBool>`(l.created_at, l.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)`);
    const vendorExpr = selectionOn ? sql`nullif(l.custom->>'vendor', '')::uuid` : sql`null::uuid`;
    const indentLineExpr = selectionOn ? sql`nullif(l.custom->>'indent_line', '')::uuid` : sql`l.id`;
    const r = await sql<Row>`
      select l.id, l.document_id, l.created_at, coalesce(il.line_no, l.line_no) as line_no, nullif(it.data->>'tax_code', '') as item_tax_code, t.key as type_key, d.number, l.item_id, l.uom_id, l.rate::text as rate, l.required_date, ven.id as vendor_id,
        il.id as indent_line_id, ind.number as indent_number, il.required_date as indent_required, n.id as loc_id, n.name as loc_name,
        it.code as item_code, it.name as item_name, ven.code as vendor_code, ven.name as vendor_name, u.code as uom_code,
        coalesce(s.approved, 0)::text as approved, coalesce(s.over_approved, 0)::text as over_approved, coalesce(s.ordered, 0)::text as ordered,
        coalesce(s.short_closed, 0)::text as short_closed
      from app.document_line l
      join app.document d on d.id = l.document_id
      join app.doc_type t on t.id = d.doc_type_id
      join app.location_node n on n.id = d.location_node_id
      left join app.line_qty_summary s on s.line_id = l.id
      left join app.document_line il on il.id = ${indentLineExpr} and il.tenant_id = l.tenant_id
      left join app.document ind on ind.id = il.document_id
      left join app.master_record it on it.id = l.item_id
      left join app.master_record u on u.id = l.uom_id
      left join app.master_record ven on ven.id = ${vendorExpr} and ven.tenant_id = l.tenant_id
      where ${sql.join(conds, sql` and `)}
      order by l.created_at desc, l.id desc
      limit ${f.ids ? f.ids.length + 1 : f.limit + 1}`.execute(tx);
    return r.rows;
  }

  private toLine(r: Row): OrderableLine {
    return {
      sourceLineId: r.id, lineNo: r.line_no, sourceKind: r.type_key === SELECTION ? 'selection' : 'indent', indentLineId: r.indent_line_id ?? r.id, indentNumber: r.indent_number,
      item: r.item_id ? { id: r.item_id, code: r.item_code ?? '', name: r.item_name ?? '' } : null, uom: r.uom_code,
      vendor: r.vendor_id ? { id: r.vendor_id, code: r.vendor_code ?? '', name: r.vendor_name ?? '' } : null,
      rate: r.rate === null ? null : fromUnits(toUnits(r.rate)), location: { id: r.loc_id, name: r.loc_name },
      requiredDate: dateStr(r.indent_required ?? r.required_date), pendingOrder: fromUnits(orderableUnits(r as never)),
    };
  }

  async orderable(tx: Tx, actor: DocActor, f: z.infer<typeof OrderableQuery>): Promise<Page<OrderableLine>> {
    if (actor.perms && !actor.perms.keys.includes(docAction(PO, 'add'))) throw AppError.forbidden();
    const selectionOn = await getTenantSetting(tx, 'flow.vendor_selection.enabled');
    const rows = await this.query(tx, actor, f, selectionOn, true);
    return toPage(rows, f.limit, r => ({ t: r.created_at, id: r.id }), r => this.toLine(r));
  }

  /** Current quote rate of (indent line, vendor), when vendor selection is off and the buyer gave no rate. */
  private async quoteRate(tx: Tx, tenantId: string, indentLineId: string, vendorId: string): Promise<string | null> {
    const q = await tx.selectFrom('app.vendor_quote').select('quoted_rate').where('tenant_id', '=', tenantId).where('indent_line_id', '=', indentLineId)
      .where('vendor_id', '=', vendorId).where('is_current', '=', true).orderBy('created_at', 'desc').executeTakeFirst();
    return q ? fromUnits(toUnits(q.quoted_rate)) : null;
  }

  /** Groups picks by vendor (and ship-to location unless the caller fixes it) → one draft PO per group. */
  async fromLines(tx: Tx, actor: DocActor, input: z.infer<typeof PoFromLines>): Promise<DocumentRow[]> {
    if (actor.perms && !actor.perms.keys.includes(docAction(PO, 'add'))) throw AppError.forbidden();
    const selectionOn = await getTenantSetting(tx, 'flow.vendor_selection.enabled');
    const ids = [...new Set(input.picks.map(p => p.sourceLineId))];
    if (ids.length !== input.picks.length) throw new AppError(400, 'VALIDATION_FAILED', 'Each source line can be picked once.', undefined, [{ path: 'picks', message: 'Duplicate source line.' }]);
    const rows = new Map((await this.query(tx, actor, { ids, limit: ids.length }, selectionOn, true)).map(r => [r.id, r]));
    const errors: { path: string; message: string }[] = [];
    const groups = new Map<string, { vendorId: string; location: string; lines: { values: Record<string, unknown> }[] }>();
    const fixedLocation = typeof input.values.location === 'string' ? input.values.location : null;
    for (const [i, p] of input.picks.entries()) {
      const r = rows.get(p.sourceLineId);
      if (!r) { errors.push({ path: `picks.${i}.sourceLineId`, message: 'This line is not available to order.' }); continue; }
      const left = orderableUnits(r as never);
      const qty = toUnits(p.qty);
      if (qty <= 0n) { errors.push({ path: `picks.${i}.qty`, message: 'Quantity must be greater than 0.' }); continue; }
      if (qty > left) { errors.push({ path: `picks.${i}.qty`, message: `Only ${fromUnits(left)} is left to order on this line.` }); continue; }
      const vendorId = r.vendor_id ?? p.vendorId ?? null;
      if (!vendorId) { errors.push({ path: `picks.${i}.vendorId`, message: 'Choose the vendor for this line.' }); continue; }
      if (r.vendor_id && p.vendorId && p.vendorId !== r.vendor_id) { errors.push({ path: `picks.${i}.vendorId`, message: 'The vendor of a selected line cannot be changed.' }); continue; }
      const rate = p.rate ?? (r.rate !== null ? fromUnits(toUnits(r.rate)) : await this.quoteRate(tx, actor.tenantId, r.indent_line_id ?? r.id, vendorId));
      const location = fixedLocation ?? r.loc_id;
      const key = `${vendorId}|${location}`;
      const g = groups.get(key) ?? { vendorId, location, lines: [] };
      const required = dateStr(r.indent_required ?? r.required_date);
      g.lines.push({
        values: {
          item: r.item_id, uom: r.uom_id, ...(r.item_tax_code ? { tax_code: r.item_tax_code } : {}), qty: p.qty, ...(rate !== null ? { rate } : {}), source_line: r.id,
          ...(required ? { required_date: required, schedule: [{ date: required, qty: p.qty }] } : {}),
        },
      });
      groups.set(key, g);
    }
    if (errors.length) throw new AppError(400, 'VALIDATION_FAILED', 'Some picks cannot be ordered', undefined, errors);
    const out: DocumentRow[] = [];
    for (const g of groups.values()) {
      const values = { ...input.values, party: g.vendorId, location: g.location };
      out.push(await this.docs.create(tx, actor, PO, { values, lines: g.lines }));
    }
    await this.store.emit(tx, 'po.created_from_lines', { kind: 'document', id: null }, {
      docTypeKey: PO, documentIds: out.map(d => d.id), sourceLineIds: ids, createdBy: actor.userId,
    });
    return out;
  }
}

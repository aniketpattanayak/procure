import { Injectable } from '@nestjs/common';
import { DocumentRow, GrnFromPo, Page, ReceivablePoLine } from '@procure/schema';
import { Expression, sql, SqlBool } from 'kysely';
import { z } from 'zod';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { dateStr, docAction, DocActor, DocStore, DocumentsService } from '../../documents';
import { decodeCursor, getTenantSetting, likePattern, toPage } from '../../identity';
import { scopeCondition } from '../../permissions';
import { needKey, q, units, withTolerance } from '../common';
import { GRN, GRN_LINE } from './grn.types';
import { poNetRate } from './po-lines';

export const ReceivableQuery = z.object({
  vendor: z.string().uuid().optional(),
  po: z.string().uuid().optional(),
  item: z.string().uuid().optional(),
  location: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

interface Row {
  id: string; document_id: string; created_at: Date; number: string | null; line_no: number; vendor_id: string; vendor_code: string | null; vendor_name: string;
  item_id: string | null; item_code: string | null; item_name: string | null; uom_id: string | null; uom_code: string | null; rate: string | null; discount_pct: string | null;
  expected: string | null; loc_id: string; loc_name: string; ordered: string; received: string; rar: string; returned: string; pending: string;
}

/**
 * Receivable PO lines and "GRN from PO" (contract `/inventory/receivable-po-lines`, `/inventory/grn/from-po`).
 * Drafts reserve nothing; the quantity is checked under row locks at GRN submit.
 */
@Injectable()
export class GrnLinesService {
  constructor(private readonly docs: DocumentsService, private readonly store: DocStore) {}

  private async query(tx: Tx, actor: DocActor, f: z.infer<typeof ReceivableQuery> & { ids?: string[] }): Promise<Row[]> {
    const reopens = await getTenantSetting(tx, 'rtv.reopens_po');
    const net = sql`(coalesce(s.received, 0) - coalesce(s.rejected_at_receipt, 0) - ${reopens ? sql`coalesce(s.returned, 0)` : sql`0`})`;
    const pending = sql`greatest(coalesce(s.ordered, 0) - ${net}, 0)`;
    const conds: Expression<SqlBool>[] = [
      sql<SqlBool>`l.tenant_id = ${actor.tenantId}`, sql<SqlBool>`not l.is_deleted`, sql<SqlBool>`not d.is_deleted`, sql<SqlBool>`t.key = 'po'`,
      sql<SqlBool>`d.closed_at is null`, sql<SqlBool>`d.cancelled_at is null`,
      sql<SqlBool>`d.status_key in ('approved', 'partially_approved', 'partially_received', 'received', 'on_hold')`,
      sql<SqlBool>`l.status_key not in ('draft', 'submitted', 'cancelled', 'closed', 'rejected')`,
      scopeCondition(sql.ref('n.path'), this.store.scopeFilter(actor, GRN)),
    ];
    if (f.ids) conds.push(sql<SqlBool>`l.id = any(${sql.val(f.ids)}::uuid[])`);
    else conds.push(sql<SqlBool>`${pending} > 0`);
    if (f.vendor) conds.push(sql<SqlBool>`d.party_id = ${f.vendor}`);
    if (f.po) conds.push(sql<SqlBool>`d.id = ${f.po}`);
    if (f.item) conds.push(sql<SqlBool>`l.item_id = ${f.item}`);
    if (f.location) conds.push(sql<SqlBool>`n.path <@ (select path from app.location_node where tenant_id = ${actor.tenantId} and id = ${f.location})`);
    if (f.q) {
      const p = likePattern(f.q);
      conds.push(sql<SqlBool>`(d.number ilike ${p} or it.name ilike ${p} or it.code::text ilike ${p} or ven.name ilike ${p} or ven.code::text ilike ${p})`);
    }
    const cur = decodeCursor(f.cursor);
    if (cur) conds.push(sql<SqlBool>`(l.created_at, l.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)`);
    const r = await sql<Row>`
      select l.id, l.document_id, l.created_at, d.number, l.line_no, ven.id as vendor_id, ven.code::text as vendor_code, ven.name as vendor_name,
        l.item_id, it.code::text as item_code, it.name as item_name, l.uom_id, u.code::text as uom_code, l.rate::text as rate,
        nullif(l.custom->>'discount_pct', '') as discount_pct, nullif(l.custom->>'expected_date', '') as expected, n.id as loc_id, n.name as loc_name,
        coalesce(s.ordered, 0)::text as ordered, ${net}::text as received, coalesce(s.rejected_at_receipt, 0)::text as rar,
        coalesce(s.returned, 0)::text as returned, ${pending}::text as pending
      from app.document_line l
      join app.document d on d.id = l.document_id
      join app.doc_type t on t.id = d.doc_type_id
      join app.location_node n on n.id = d.location_node_id
      join app.master_record ven on ven.id = d.party_id
      left join app.line_qty_summary s on s.line_id = l.id
      left join app.master_record it on it.id = l.item_id
      left join app.master_record u on u.id = l.uom_id
      where ${sql.join(conds, sql` and `)}
      order by l.created_at desc, l.id desc
      limit ${f.ids ? f.ids.length + 1 : f.limit + 1}`.execute(tx);
    return r.rows;
  }

  private toLine(r: Row, pct: number): ReceivablePoLine {
    const pending = units(r.pending);
    return {
      poLineId: r.id, poId: r.document_id, poNumber: r.number, lineNo: r.line_no, vendor: { id: r.vendor_id, code: r.vendor_code ?? '', name: r.vendor_name },
      item: r.item_id ? { id: r.item_id, code: r.item_code ?? '', name: r.item_name ?? '' } : null, uom: r.uom_code,
      ordered: q(units(r.ordered)), received: q(units(r.received)), pendingReceipt: q(pending), maxReceivable: q(withTolerance(pending, pct)),
      rate: poNetRate(r), expectedDate: dateStr(r.expected), location: { id: r.loc_id, name: r.loc_name },
    };
  }

  async receivable(tx: Tx, actor: DocActor, f: z.infer<typeof ReceivableQuery>): Promise<Page<ReceivablePoLine>> {
    needKey(actor, docAction(GRN, 'add'));
    const pct = await getTenantSetting(tx, 'grn.over_receipt_pct');
    const rows = await this.query(tx, actor, f);
    return toPage(rows, f.limit, r => ({ t: r.created_at, id: r.id }), r => this.toLine(r, pct));
  }

  /** One draft GRN per PO (per vendor when `grn.multi_po`); each line copies item, unit, PO rate and location. */
  async fromPo(tx: Tx, actor: DocActor, input: z.infer<typeof GrnFromPo>): Promise<DocumentRow[]> {
    needKey(actor, docAction(GRN, 'add'));
    if (input.submit) needKey(actor, docAction(GRN, 'submit'));
    const ids = [...new Set(input.lines.map(p => p.poLineId))];
    if (ids.length !== input.lines.length) throw new AppError(400, 'VALIDATION_FAILED', 'Each PO line can be received once per request.', undefined, [{ path: 'lines', message: 'Duplicate PO line.' }]);
    const [pct, multi] = [await getTenantSetting(tx, 'grn.over_receipt_pct'), await getTenantSetting(tx, 'grn.multi_po')];
    const rows = new Map((await this.query(tx, actor, { ids, limit: ids.length })).map(r => [r.id, r]));
    const errors: { path: string; message: string }[] = [];
    const groups = new Map<string, { vendorId: string; location: string; lines: { values: Record<string, unknown> }[] }>();
    const vendors = new Set<string>();
    for (const [i, p] of input.lines.entries()) {
      const r = rows.get(p.poLineId);
      if (!r) { errors.push({ path: `lines.${i}.poLineId`, message: 'This PO line is not open for receipt.' }); continue; }
      const qty = units(p.qty);
      const max = withTolerance(units(r.pending), pct);
      if (qty <= 0n) { errors.push({ path: `lines.${i}.qty`, message: 'Quantity must be greater than 0.' }); continue; }
      if (qty > max) { errors.push({ path: `lines.${i}.qty`, message: `At most ${q(max)} can be received on this line (pending ${q(units(r.pending))} + ${pct}% tolerance).` }); continue; }
      const acc = p.acceptedQty !== undefined ? units(p.acceptedQty) : null;
      const rej = p.rejectedQty !== undefined ? units(p.rejectedQty) : null;
      if ((acc ?? 0n) + (rej ?? 0n) > qty) { errors.push({ path: `lines.${i}.rejectedQty`, message: 'Accepted + rejected cannot exceed the received quantity.' }); continue; }
      if (p.mfgDate && p.expiryDate && p.expiryDate < p.mfgDate) { errors.push({ path: `lines.${i}.expiryDate`, message: 'The expiry date is before the manufacturing date.' }); continue; }
      vendors.add(r.vendor_id);
      const location = typeof input.values.location === 'string' ? input.values.location : r.loc_id;
      const key = multi ? `${r.vendor_id}|${location}` : r.document_id;
      const g = groups.get(key) ?? { vendorId: r.vendor_id, location, lines: [] };
      const ratio = (n: bigint | null) => (n === null ? undefined : q(n));
      g.lines.push({
        values: {
          ...p.values, item: r.item_id, uom: r.uom_id, qty: p.qty, rate: poNetRate(r) ?? undefined, location: (p.values.location as string | undefined) ?? location,
          [GRN_LINE.poLine]: r.id, [GRN_LINE.accepted]: ratio(acc ?? (rej !== null ? qty - rej : null)), [GRN_LINE.rejected]: ratio(rej),
          ...(p.rejectReason ? { [GRN_LINE.rejectReason]: p.rejectReason } : {}),
          ...(p.batchNo ? { [GRN_LINE.batchNo]: p.batchNo } : {}), ...(p.mfgDate ? { [GRN_LINE.mfgDate]: p.mfgDate } : {}), ...(p.expiryDate ? { [GRN_LINE.expiryDate]: p.expiryDate } : {}),
        },
      });
      groups.set(key, g);
    }
    if (vendors.size > 1) errors.push({ path: 'lines', message: 'All lines of a GRN must be from the same vendor.' });
    if (errors.length) throw new AppError(400, 'VALIDATION_FAILED', 'Some lines cannot be received', undefined, errors);
    const out: DocumentRow[] = [];
    for (const g of groups.values()) {
      const created = await this.docs.create(tx, actor, GRN, { values: { ...input.values, party: g.vendorId, location: g.location }, lines: g.lines });
      out.push(input.submit ? await this.docs.submit(tx, actor, GRN, created.id, created.version) : created);
    }
    await this.store.emit(tx, 'grn.created_from_po', { kind: 'document', id: null }, { docTypeKey: GRN, documentIds: out.map(d => d.id), poLineIds: ids, createdBy: actor.userId });
    return out;
  }
}

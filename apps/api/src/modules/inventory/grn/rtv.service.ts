import { Injectable, OnModuleInit } from '@nestjs/common';
import type { DocumentRow, Page } from '@procure/schema';
import { Expression, sql, SqlBool } from 'kysely';
import { z } from 'zod';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { docAction, DocActor, DocStore, DocumentHooks, DocumentsService, type SaveHookCtx, type SubmitHookCtx } from '../../documents';
import { validationFailed } from '../../forms';
import { decodeCursor, likePattern, toPage } from '../../identity';
import { scopeCondition } from '../../permissions';
import { isUuid, lockSummaries, needKey, q, qtyExceeds, units } from '../common';
import { GRN, GRN_LINE, RTV, RTV_LINE } from './grn.types';

const Dec = z.string().regex(/^\d+(\.\d+)?$/, 'Decimal string');
export const ReturnableGrnQuery = z.object({
  vendor: z.string().uuid().optional(), grn: z.string().uuid().optional(), item: z.string().uuid().optional(), q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const RtvFromGrn = z.object({
  lines: z.array(z.object({
    grnLineId: z.string().uuid(), qty: Dec, fromStatus: z.enum(['available', 'quarantine', 'rejected']).optional(), reason: z.string().max(500).optional(),
  })).min(1).max(500),
  values: z.record(z.string(), z.unknown()).default({}),
  submit: z.boolean().default(false),
});

/** GET /inventory/returnable-grn-lines row: GRN lines with stock that can still go back to the vendor. */
export interface ReturnableGrnLine {
  grnLineId: string; grnId: string; grnNumber: string | null; lineNo: number; vendor: { id: string; code: string; name: string };
  item: { id: string; code: string; name: string } | null; uom: string | null; accepted: string; returned: string; inReturn: string; returnable: string;
  rate: string | null; batchNo: string | null; location: { id: string; name: string };
}

interface Row {
  id: string; document_id: string; created_at: Date; number: string | null; line_no: number; vendor_id: string; vendor_code: string | null; vendor_name: string;
  item_id: string | null; item_code: string | null; item_name: string | null; uom_id: string | null; uom_code: string | null; rate: string | null; batch_no: string | null;
  loc_id: string; loc_name: string; accepted: string; returned: string; in_return: string;
}

/** Qty of open RTV lines (still in approval) per GRN line, excluding the RTV `exceptDoc`. */
async function inReturn(tx: Tx, tenantId: string, grnLineIds: string[], exceptDoc: string | null): Promise<Map<string, bigint>> {
  if (!grnLineIds.length) return new Map();
  const r = await sql<{ ref: string; qty: string }>`
    select l.custom->>${RTV_LINE.grnLine} as ref, sum(greatest(s.requested - s.approved - s.rejected - s.cancelled, 0))::text as qty
    from app.document_line l join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id
    join app.line_qty_summary s on s.line_id = l.id
    where l.tenant_id = ${tenantId} and t.key = ${RTV} and not l.is_deleted and not d.is_deleted and d.status_key <> 'draft'
      and l.custom->>${RTV_LINE.grnLine} = any(${sql.val(grnLineIds)}::text[]) ${exceptDoc ? sql`and d.id <> ${exceptDoc}` : sql``}
    group by 1`.execute(tx);
  return new Map(r.rows.map(x => [x.ref, units(x.qty)]));
}

/**
 * RTV behaviour: lines must reference GRN lines of the RTV's vendor with stock still returnable (accepted − returned
 * − open RTVs), checked again under row locks at submit. Also `/inventory/returnable-grn-lines` and
 * `/inventory/rtv/from-grn` (manual returns after acceptance; the workflow effect `return_to_vendor` drafts the rest).
 */
@Injectable()
export class RtvService implements OnModuleInit {
  constructor(private readonly hooks: DocumentHooks, private readonly store: DocStore, private readonly docs: DocumentsService) {}

  onModuleInit() {
    this.hooks.onSave(RTV, (tx, ctx) => this.onSave(tx, ctx));
    this.hooks.onSubmit(RTV, (tx, ctx) => this.onSubmit(tx, ctx));
  }

  private async grnLines(tx: Tx, tenantId: string, ids: string[]) {
    if (!ids.length) return new Map<string, { id: string; document_id: string; item_id: string | null; party_id: string | null; type_key: string; doc_status: string }>();
    const r = await sql<{ id: string; document_id: string; item_id: string | null; party_id: string | null; type_key: string; doc_status: string }>`
      select l.id, l.document_id, l.item_id, d.party_id, t.key as type_key, d.status_key as doc_status
      from app.document_line l join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id
      where l.tenant_id = ${tenantId} and l.id = any(${sql.val([...new Set(ids)])}::uuid[]) and not l.is_deleted and not d.is_deleted`.execute(tx);
    return new Map(r.rows.map(x => [x.id, x]));
  }

  async onSave(tx: Tx, ctx: SaveHookCtx): Promise<void> {
    if (ctx.mode === 'line_edits') return;
    const doc = await tx.selectFrom('app.document').select(['party_id']).where('tenant_id', '=', ctx.tenantId).where('id', '=', ctx.documentId).executeTakeFirstOrThrow();
    const lines = await this.store.loadLines(tx, ctx.tenantId, ctx.documentId);
    const refs = await this.grnLines(tx, ctx.tenantId, lines.map(l => l.custom[RTV_LINE.grnLine]).filter(isUuid));
    const errors: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    for (const l of lines) {
      const at = `lines.${l.line_no - 1}`;
      const ref = l.custom[RTV_LINE.grnLine];
      if (!isUuid(ref)) {
        if (ctx.mode === 'submit') errors.push({ path: `${at}.${RTV_LINE.grnLine}`, message: 'Return against a GRN line.' });
        continue;
      }
      const g = refs.get(ref);
      if (!g || g.type_key !== GRN || g.doc_status === 'draft') { errors.push({ path: `${at}.${RTV_LINE.grnLine}`, message: 'The GRN line does not exist.' }); continue; }
      if (seen.has(ref)) errors.push({ path: `${at}.${RTV_LINE.grnLine}`, message: 'The same GRN line is used twice on this return.' });
      seen.add(ref);
      if (doc.party_id && g.party_id !== doc.party_id) errors.push({ path: 'party', message: 'The vendor must be the vendor of the GRN.' });
      if (g.item_id && l.item_id !== g.item_id) errors.push({ path: `${at}.item`, message: 'The item must be the item of the GRN line.' });
    }
    if (errors.length) throw validationFailed(errors);
  }

  /** Locks the GRN line summaries and checks qty ≤ accepted − returned − other open returns (409 otherwise). */
  async onSubmit(tx: Tx, ctx: SubmitHookCtx): Promise<void> {
    const lines = (await this.store.loadLines(tx, ctx.tenantId, ctx.documentId)).filter(l => isUuid(l.custom[RTV_LINE.grnLine]));
    if (!lines.length) return;
    const refs = await this.grnLines(tx, ctx.tenantId, lines.map(l => String(l.custom[RTV_LINE.grnLine])));
    const sums = await lockSummaries(tx, ctx.tenantId, [...refs.values()].map(g => ({ id: g.id, documentId: g.document_id })));
    const open = await inReturn(tx, ctx.tenantId, [...refs.keys()], ctx.documentId);
    for (const l of lines) {
      const ref = String(l.custom[RTV_LINE.grnLine]);
      const s = sums.get(ref);
      const left = units(s?.accepted) - units(s?.returned) - (open.get(ref) ?? 0n);
      if (units(l.qty) > left) {
        throw qtyExceeds(`Only ${q(left)} of GRN line can still be returned; line ${l.line_no} returns ${q(units(l.qty))}.`, { lineId: l.id, grnLineId: ref, returnable: q(left), asked: q(units(l.qty)) });
      }
    }
  }

  // ------------------------------------------------------------------ returnable GRN lines / RTV from GRN
  private async query(tx: Tx, actor: DocActor, f: z.infer<typeof ReturnableGrnQuery> & { ids?: string[] }): Promise<Row[]> {
    const conds: Expression<SqlBool>[] = [
      sql<SqlBool>`l.tenant_id = ${actor.tenantId}`, sql<SqlBool>`not l.is_deleted`, sql<SqlBool>`not d.is_deleted`, sql<SqlBool>`t.key = ${GRN}`,
      sql<SqlBool>`d.cancelled_at is null`, scopeCondition(sql.ref('n.path'), this.store.scopeFilter(actor, RTV)),
    ];
    if (f.ids) conds.push(sql<SqlBool>`l.id = any(${sql.val(f.ids)}::uuid[])`);
    else conds.push(sql<SqlBool>`coalesce(s.accepted, 0) - coalesce(s.returned, 0) > 0`);
    if (f.vendor) conds.push(sql<SqlBool>`d.party_id = ${f.vendor}`);
    if (f.grn) conds.push(sql<SqlBool>`d.id = ${f.grn}`);
    if (f.item) conds.push(sql<SqlBool>`l.item_id = ${f.item}`);
    if (f.q) {
      const p = likePattern(f.q);
      conds.push(sql<SqlBool>`(d.number ilike ${p} or it.name ilike ${p} or it.code::text ilike ${p} or ven.name ilike ${p})`);
    }
    const cur = decodeCursor(f.cursor);
    if (cur) conds.push(sql<SqlBool>`(l.created_at, l.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)`);
    const r = await sql<Row>`
      select l.id, l.document_id, l.created_at, d.number, l.line_no, ven.id as vendor_id, ven.code::text as vendor_code, ven.name as vendor_name,
        l.item_id, it.code::text as item_code, it.name as item_name, l.uom_id, u.code::text as uom_code, l.rate::text as rate,
        nullif(l.custom->>${GRN_LINE.batchNo}, '') as batch_no, ln.id as loc_id, ln.name as loc_name,
        coalesce(s.accepted, 0)::text as accepted, coalesce(s.returned, 0)::text as returned, '0' as in_return
      from app.document_line l
      join app.document d on d.id = l.document_id
      join app.doc_type t on t.id = d.doc_type_id
      join app.location_node n on n.id = d.location_node_id
      join app.location_node ln on ln.id = l.location_node_id
      join app.master_record ven on ven.id = d.party_id
      left join app.line_qty_summary s on s.line_id = l.id
      left join app.master_record it on it.id = l.item_id
      left join app.master_record u on u.id = l.uom_id
      where ${sql.join(conds, sql` and `)}
      order by l.created_at desc, l.id desc
      limit ${f.ids ? f.ids.length + 1 : f.limit + 1}`.execute(tx);
    const open = await inReturn(tx, actor.tenantId, r.rows.map(x => x.id), null);
    for (const x of r.rows) x.in_return = q(open.get(x.id) ?? 0n);
    return r.rows;
  }

  private toLine(r: Row): ReturnableGrnLine {
    const left = units(r.accepted) - units(r.returned) - units(r.in_return);
    return {
      grnLineId: r.id, grnId: r.document_id, grnNumber: r.number, lineNo: r.line_no, vendor: { id: r.vendor_id, code: r.vendor_code ?? '', name: r.vendor_name },
      item: r.item_id ? { id: r.item_id, code: r.item_code ?? '', name: r.item_name ?? '' } : null, uom: r.uom_code,
      accepted: q(units(r.accepted)), returned: q(units(r.returned)), inReturn: q(units(r.in_return)), returnable: q(left), rate: r.rate === null ? null : q(units(r.rate)),
      batchNo: r.batch_no, location: { id: r.loc_id, name: r.loc_name },
    };
  }

  async returnable(tx: Tx, actor: DocActor, f: z.infer<typeof ReturnableGrnQuery>): Promise<Page<ReturnableGrnLine>> {
    needKey(actor, docAction(RTV, 'add'));
    const rows = await this.query(tx, actor, f);
    return toPage(rows, f.limit, r => ({ t: r.created_at, id: r.id }), r => this.toLine(r));
  }

  /** One draft RTV per vendor for the picked GRN lines (stock already accepted). */
  async fromGrn(tx: Tx, actor: DocActor, input: z.infer<typeof RtvFromGrn>): Promise<DocumentRow> {
    needKey(actor, docAction(RTV, 'add'));
    if (input.submit) needKey(actor, docAction(RTV, 'submit'));
    const ids = [...new Set(input.lines.map(l => l.grnLineId))];
    if (ids.length !== input.lines.length) throw new AppError(400, 'VALIDATION_FAILED', 'Each GRN line can be returned once per request.', undefined, [{ path: 'lines', message: 'Duplicate GRN line.' }]);
    const rows = new Map((await this.query(tx, actor, { ids, limit: ids.length })).map(r => [r.id, r]));
    const errors: { path: string; message: string }[] = [];
    const vendors = new Set<string>();
    const lines: { values: Record<string, unknown> }[] = [];
    let first: Row | null = null;
    for (const [i, p] of input.lines.entries()) {
      const r = rows.get(p.grnLineId);
      if (!r) { errors.push({ path: `lines.${i}.grnLineId`, message: 'This GRN line cannot be returned.' }); continue; }
      const left = units(r.accepted) - units(r.returned) - units(r.in_return);
      const n = units(p.qty);
      if (n <= 0n || n > left) { errors.push({ path: `lines.${i}.qty`, message: `Between 0 and ${q(left)} can be returned on this line.` }); continue; }
      vendors.add(r.vendor_id);
      first ??= r;
      lines.push({
        values: {
          item: r.item_id, uom: r.uom_id, qty: p.qty, rate: r.rate ?? undefined, location: r.loc_id, [RTV_LINE.grnLine]: r.id, [RTV_LINE.fromStatus]: p.fromStatus ?? 'available',
          ...(r.batch_no ? { [RTV_LINE.batchNo]: r.batch_no } : {}), ...(p.reason ? { [RTV_LINE.reason]: p.reason } : {}),
        },
      });
    }
    if (vendors.size > 1) errors.push({ path: 'lines', message: 'All lines of a return must be from the same vendor.' });
    if (errors.length || !first) throw new AppError(400, 'VALIDATION_FAILED', 'Some lines cannot be returned', undefined, errors);
    const values = { location: first.loc_id, grn: first.document_id, ...input.values, party: first.vendor_id };
    const created = await this.docs.create(tx, actor, RTV, { values, lines });
    return input.submit ? this.docs.submit(tx, actor, RTV, created.id, created.version) : created;
  }
}

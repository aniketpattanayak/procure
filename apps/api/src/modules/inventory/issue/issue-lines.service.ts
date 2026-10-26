import { Injectable } from '@nestjs/common';
import type { DocumentRow, IssuableLine, Page, ReturnableLine } from '@procure/schema';
import { Expression, sql, SqlBool } from 'kysely';
import { z } from 'zod';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { docAction, DocActor, DocStore, DocumentsService } from '../../documents';
import { decodeCursor, likePattern, toPage } from '../../identity';
import { scopeCondition } from '../../permissions';
import { needKey, q, units } from '../common';
import { availableAt, openRefQty } from './issue-hooks';
import { ISSUE_LINE, ISSUE_REQUEST, RETURN_LINE, STORE_ISSUE, STORE_RETURN } from './issue.types';

const Dec = z.string().regex(/^\d+(\.\d+)?$/, 'Decimal string');

export const IssuableQuery = z.object({
  node: z.string().uuid().optional(), item: z.string().uuid().optional(), request: z.string().uuid().optional(), department: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const ReturnableQuery = z.object({
  issue: z.string().uuid().optional(), item: z.string().uuid().optional(), department: z.string().uuid().optional(), node: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
});
/** POST /inventory/issues/from-requests — one store issue from approved request lines (issuing location = values.location
 *  or the first request's location; a line may override it). */
export const IssueFromRequests = z.object({
  lines: z.array(z.object({ requestLineId: z.string().uuid(), qty: Dec, batchNo: z.string().max(60).optional(), location: z.string().uuid().optional(), values: z.record(z.string(), z.unknown()).default({}) })).min(1).max(500),
  values: z.record(z.string(), z.unknown()).default({}),
  submit: z.boolean().default(false),
});
/** POST /inventory/returns/from-issues — one store return from issue lines. */
export const ReturnFromIssues = z.object({
  lines: z.array(z.object({
    issueLineId: z.string().uuid(), qty: Dec, status: z.enum(['available', 'quarantine']).default('available'), location: z.string().uuid().optional(),
    reason: z.string().max(500).optional(), values: z.record(z.string(), z.unknown()).default({}),
  })).min(1).max(500),
  values: z.record(z.string(), z.unknown()).default({}),
  submit: z.boolean().default(false),
});

interface ReqRow {
  id: string; document_id: string; created_at: Date; number: string | null; line_no: number; item_id: string; item_code: string | null; item_name: string | null;
  uom_id: string | null; uom_code: string | null; requested: string; approved: string; issued: string; short_closed: string; loc_id: string; loc_name: string; requested_by: string | null;
  department: string | null;
}
interface IssRow {
  id: string; document_id: string; created_at: Date; number: string | null; line_no: number; item_id: string; item_code: string | null; item_name: string | null;
  uom_id: string | null; uom_code: string | null; issued: string; returned: string; batch_no: string | null; loc_id: string; department: string | null;
}

/**
 * Issuable request lines → store issues, returnable issue lines → store returns (contract "Issue and return").
 * Drafts reserve nothing; quantities are checked under row locks at submit (IssueHooks).
 */
@Injectable()
export class IssueLinesService {
  constructor(private readonly docs: DocumentsService, private readonly store: DocStore) {}

  // ------------------------------------------------------------------ issuable
  private async requestRows(tx: Tx, actor: DocActor, f: z.infer<typeof IssuableQuery> & { ids?: string[] }): Promise<ReqRow[]> {
    const conds: Expression<SqlBool>[] = [
      sql<SqlBool>`l.tenant_id = ${actor.tenantId}`, sql<SqlBool>`not l.is_deleted`, sql<SqlBool>`not d.is_deleted`, sql<SqlBool>`t.key = ${ISSUE_REQUEST}`,
      sql<SqlBool>`d.closed_at is null`, sql<SqlBool>`d.cancelled_at is null`, sql<SqlBool>`l.item_id is not null`,
      sql<SqlBool>`l.status_key not in ('draft', 'submitted', 'cancelled', 'closed', 'rejected')`,
      scopeCondition(sql.ref('n.path'), this.store.scopeFilter(actor, STORE_ISSUE)),
    ];
    if (f.ids) conds.push(sql<SqlBool>`l.id = any(${sql.val(f.ids)}::uuid[])`);
    else conds.push(sql<SqlBool>`coalesce(s.approved, 0) - coalesce(s.issued, 0) - coalesce(s.short_closed, 0) > 0`);
    if (f.item) conds.push(sql<SqlBool>`l.item_id = ${f.item}`);
    if (f.request) conds.push(sql<SqlBool>`d.id = ${f.request}`);
    if (f.department) conds.push(sql<SqlBool>`d.custom->>'department' = ${f.department}`);
    if (f.q) {
      const p = likePattern(f.q);
      conds.push(sql<SqlBool>`(d.number ilike ${p} or it.name ilike ${p} or it.code::text ilike ${p})`);
    }
    const cur = decodeCursor(f.cursor);
    if (cur) conds.push(sql<SqlBool>`(l.created_at, l.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)`);
    const r = await sql<ReqRow>`
      select l.id, l.document_id, l.created_at, d.number, l.line_no, l.item_id, it.code::text as item_code, it.name as item_name, l.uom_id, u.code::text as uom_code,
        coalesce(s.requested, 0)::text as requested, coalesce(s.approved, 0)::text as approved, coalesce(s.issued, 0)::text as issued, coalesce(s.short_closed, 0)::text as short_closed,
        n.id as loc_id, n.name as loc_name, us.name as requested_by, nullif(d.custom->>'department', '') as department
      from app.document_line l
      join app.document d on d.id = l.document_id
      join app.doc_type t on t.id = d.doc_type_id
      join app.location_node n on n.id = d.location_node_id
      left join app.line_qty_summary s on s.line_id = l.id
      left join app.master_record it on it.id = l.item_id
      left join app.master_record u on u.id = l.uom_id
      left join app.tenant_user us on us.id = coalesce(d.submitted_by, d.created_by)
      where ${sql.join(conds, sql` and `)}
      order by l.created_at desc, l.id desc
      limit ${f.ids ? f.ids.length + 1 : f.limit + 1}`.execute(tx);
    return r.rows;
  }

  async issuable(tx: Tx, actor: DocActor, f: z.infer<typeof IssuableQuery>): Promise<Page<IssuableLine>> {
    needKey(actor, docAction(STORE_ISSUE, 'add'));
    const rows = await this.requestRows(tx, actor, f);
    const open = await openRefQty(tx, actor.tenantId, STORE_ISSUE, ISSUE_LINE.requestLine, rows.map(r => r.id), null);
    const avail = new Map<string, bigint>();
    for (const r of rows) {
      const k = `${r.item_id}|${f.node ?? r.loc_id}`;
      if (!avail.has(k)) avail.set(k, await availableAt(tx, actor.tenantId, r.item_id, f.node ?? r.loc_id));
    }
    return toPage(rows, f.limit, r => ({ t: r.created_at, id: r.id }), (r): IssuableLine => {
      const pending = units(r.approved) - units(r.issued) - units(r.short_closed) - (open.get(r.id) ?? 0n);
      return {
        requestLineId: r.id, requestId: r.document_id, requestNumber: r.number, lineNo: r.line_no, item: { id: r.item_id, code: r.item_code ?? '', name: r.item_name ?? '' },
        uom: r.uom_code, requested: q(units(r.requested)), issued: q(units(r.issued)), pendingIssue: q(pending), available: q(avail.get(`${r.item_id}|${f.node ?? r.loc_id}`) ?? 0n),
        location: { id: r.loc_id, name: r.loc_name }, requestedBy: r.requested_by,
      };
    });
  }

  async fromRequests(tx: Tx, actor: DocActor, input: z.infer<typeof IssueFromRequests>): Promise<DocumentRow> {
    needKey(actor, docAction(STORE_ISSUE, 'add'));
    if (input.submit) needKey(actor, docAction(STORE_ISSUE, 'submit'));
    const ids = [...new Set(input.lines.map(l => l.requestLineId))];
    if (ids.length !== input.lines.length) throw new AppError(400, 'VALIDATION_FAILED', 'Each request line can be issued once per request.', undefined, [{ path: 'lines', message: 'Duplicate request line.' }]);
    const rows = new Map((await this.requestRows(tx, actor, { ids, limit: ids.length })).map(r => [r.id, r]));
    const open = await openRefQty(tx, actor.tenantId, STORE_ISSUE, ISSUE_LINE.requestLine, ids, null);
    const errors: { path: string; message: string }[] = [];
    const lines: { values: Record<string, unknown> }[] = [];
    let first: ReqRow | null = null;
    const location = typeof input.values.location === 'string' ? input.values.location : null;
    for (const [i, p] of input.lines.entries()) {
      const r = rows.get(p.requestLineId);
      if (!r) { errors.push({ path: `lines.${i}.requestLineId`, message: 'This request line is not open for issue.' }); continue; }
      const pending = units(r.approved) - units(r.issued) - units(r.short_closed) - (open.get(r.id) ?? 0n);
      const n = units(p.qty);
      if (n <= 0n) { errors.push({ path: `lines.${i}.qty`, message: 'Quantity must be greater than 0.' }); continue; }
      if (n > pending) { errors.push({ path: `lines.${i}.qty`, message: `Only ${q(pending)} is pending issue on this line.` }); continue; }
      first ??= r;
      lines.push({
        values: {
          ...p.values, item: r.item_id, uom: r.uom_id, qty: p.qty, [ISSUE_LINE.requestLine]: r.id, ...(p.batchNo ? { [ISSUE_LINE.batchNo]: p.batchNo } : {}),
          ...(p.location ?? location ? { location: p.location ?? location } : {}),
        },
      });
    }
    if (errors.length || !first) throw new AppError(400, 'VALIDATION_FAILED', 'Some lines cannot be issued', undefined, errors);
    const values = { ...(first.department ? { department: first.department } : {}), request: first.document_id, ...input.values, location: location ?? first.loc_id };
    const created = await this.docs.create(tx, actor, STORE_ISSUE, { values, lines });
    return input.submit ? this.docs.submit(tx, actor, STORE_ISSUE, created.id, created.version) : created;
  }

  // ------------------------------------------------------------------ returnable
  private async issueRows(tx: Tx, actor: DocActor, f: z.infer<typeof ReturnableQuery> & { ids?: string[] }): Promise<IssRow[]> {
    const conds: Expression<SqlBool>[] = [
      sql<SqlBool>`l.tenant_id = ${actor.tenantId}`, sql<SqlBool>`not l.is_deleted`, sql<SqlBool>`not d.is_deleted`, sql<SqlBool>`t.key = ${STORE_ISSUE}`,
      sql<SqlBool>`d.cancelled_at is null`, sql<SqlBool>`l.item_id is not null`, scopeCondition(sql.ref('n.path'), this.store.scopeFilter(actor, STORE_RETURN)),
    ];
    if (f.ids) conds.push(sql<SqlBool>`l.id = any(${sql.val(f.ids)}::uuid[])`);
    else conds.push(sql<SqlBool>`coalesce(s.issued, 0) - coalesce(s.returned, 0) > 0`);
    if (f.issue) conds.push(sql<SqlBool>`d.id = ${f.issue}`);
    if (f.item) conds.push(sql<SqlBool>`l.item_id = ${f.item}`);
    if (f.department) conds.push(sql<SqlBool>`d.custom->>'department' = ${f.department}`);
    if (f.node) conds.push(sql<SqlBool>`ln.path <@ (select path from app.location_node where tenant_id = ${actor.tenantId} and id = ${f.node})`);
    if (f.q) {
      const p = likePattern(f.q);
      conds.push(sql<SqlBool>`(d.number ilike ${p} or it.name ilike ${p} or it.code::text ilike ${p})`);
    }
    const cur = decodeCursor(f.cursor);
    if (cur) conds.push(sql<SqlBool>`(l.created_at, l.id) < (${cur.t}::timestamptz, ${cur.id}::uuid)`);
    const r = await sql<IssRow>`
      select l.id, l.document_id, l.created_at, d.number, l.line_no, l.item_id, it.code::text as item_code, it.name as item_name, l.uom_id, u.code::text as uom_code,
        coalesce(s.issued, 0)::text as issued, coalesce(s.returned, 0)::text as returned, nullif(l.custom->>${ISSUE_LINE.batchNo}, '') as batch_no,
        l.location_node_id as loc_id, nullif(d.custom->>'department', '') as department
      from app.document_line l
      join app.document d on d.id = l.document_id
      join app.doc_type t on t.id = d.doc_type_id
      join app.location_node n on n.id = d.location_node_id
      join app.location_node ln on ln.id = l.location_node_id
      left join app.line_qty_summary s on s.line_id = l.id
      left join app.master_record it on it.id = l.item_id
      left join app.master_record u on u.id = l.uom_id
      where ${sql.join(conds, sql` and `)}
      order by l.created_at desc, l.id desc
      limit ${f.ids ? f.ids.length + 1 : f.limit + 1}`.execute(tx);
    return r.rows;
  }

  async returnable(tx: Tx, actor: DocActor, f: z.infer<typeof ReturnableQuery>): Promise<Page<ReturnableLine>> {
    needKey(actor, docAction(STORE_RETURN, 'add'));
    const rows = await this.issueRows(tx, actor, f);
    const open = await openRefQty(tx, actor.tenantId, STORE_RETURN, RETURN_LINE.issueLine, rows.map(r => r.id), null);
    return toPage(rows, f.limit, r => ({ t: r.created_at, id: r.id }), (r): ReturnableLine => ({
      issueLineId: r.id, issueId: r.document_id, issueNumber: r.number, lineNo: r.line_no, item: { id: r.item_id, code: r.item_code ?? '', name: r.item_name ?? '' },
      uom: r.uom_code, issued: q(units(r.issued)), returned: q(units(r.returned)), returnable: q(units(r.issued) - units(r.returned) - (open.get(r.id) ?? 0n)), batchNo: r.batch_no,
    }));
  }

  async fromIssues(tx: Tx, actor: DocActor, input: z.infer<typeof ReturnFromIssues>): Promise<DocumentRow> {
    needKey(actor, docAction(STORE_RETURN, 'add'));
    if (input.submit) needKey(actor, docAction(STORE_RETURN, 'submit'));
    const ids = [...new Set(input.lines.map(l => l.issueLineId))];
    if (ids.length !== input.lines.length) throw new AppError(400, 'VALIDATION_FAILED', 'Each issue line can be returned once per request.', undefined, [{ path: 'lines', message: 'Duplicate issue line.' }]);
    const rows = new Map((await this.issueRows(tx, actor, { ids, limit: ids.length })).map(r => [r.id, r]));
    const open = await openRefQty(tx, actor.tenantId, STORE_RETURN, RETURN_LINE.issueLine, ids, null);
    const errors: { path: string; message: string }[] = [];
    const lines: { values: Record<string, unknown> }[] = [];
    let first: IssRow | null = null;
    for (const [i, p] of input.lines.entries()) {
      const r = rows.get(p.issueLineId);
      if (!r) { errors.push({ path: `lines.${i}.issueLineId`, message: 'This issue line cannot be returned.' }); continue; }
      const left = units(r.issued) - units(r.returned) - (open.get(r.id) ?? 0n);
      const n = units(p.qty);
      if (n <= 0n || n > left) { errors.push({ path: `lines.${i}.qty`, message: `Between 0 and ${q(left)} can be returned on this line.` }); continue; }
      first ??= r;
      lines.push({
        values: {
          ...p.values, item: r.item_id, uom: r.uom_id, qty: p.qty, location: p.location ?? r.loc_id, [RETURN_LINE.issueLine]: r.id, [RETURN_LINE.status]: p.status,
          ...(r.batch_no ? { [RETURN_LINE.batchNo]: r.batch_no } : {}), ...(p.reason ? { reason: p.reason } : {}),
        },
      });
    }
    if (errors.length || !first) throw new AppError(400, 'VALIDATION_FAILED', 'Some lines cannot be returned', undefined, errors);
    const values = { ...(first.department ? { department: first.department } : {}), location: first.loc_id, ...input.values };
    const created = await this.docs.create(tx, actor, STORE_RETURN, { values, lines });
    return input.submit ? this.docs.submit(tx, actor, STORE_RETURN, created.id, created.version) : created;
  }
}

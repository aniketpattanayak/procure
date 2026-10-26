import { Injectable } from '@nestjs/common';
import { ErrorCode, LedgerQuery, MyPermissions, Page, StockBalanceRow, StockLedgerRow, StockPost, StockQuery, StockStatus } from '@procure/schema';
import { RawBuilder, sql } from 'kysely';
import type { z } from 'zod';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { fromUnits, pendingReceiptUnits, toUnits } from '../../documents';
import { decodeCursor, getTenantSetting } from '../../identity';
import { scopeCondition, ScopeService } from '../../permissions';
import { canon, dec, q4 } from '../ledger/decimal';
import { NO_BATCH } from '../ledger/types';

/** Who reads stock. `perms: null` = the engine (seed, jobs): everything, values included. */
export interface StockActor { tenantId: string; userId: string | null; perms: MyPermissions | null }

export const STOCK_TAB = 'stock';
export const VIEW_VALUE = 'stock:action.view_value';
const STATUSES: StockStatus[] = ['available', 'quarantine', 'rejected'];

export const canSeeValue = (a: StockActor) => a.perms === null || a.perms.keys.includes(VIEW_VALUE);
/** Stock statuses whose view key the actor holds (`stock:view.<status>`). */
export const heldStatuses = (a: StockActor): StockStatus[] => (a.perms === null ? STATUSES : STATUSES.filter(s => a.perms!.keys.includes(`stock:view.${s}`)));

const offsetCursor = (o: number) => Buffer.from(JSON.stringify({ o })).toString('base64url');
function readOffset(c: string | undefined): number {
  if (!c) return 0;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof v.o === 'number' && Number.isInteger(v.o) && v.o >= 0) return v.o;
  } catch { /* fall through */ }
  throw new AppError(400, ErrorCode.VALIDATION, 'The page cursor is invalid. Start again from the first page.');
}
const encodeCursor = (t: Date | string, id: string) => Buffer.from(JSON.stringify({ t: new Date(t).toISOString(), id })).toString('base64url');
const nz = (v: string | null | undefined) => canon(v ?? '0');

/** Read side of the stock ledger: balances, ledger, item summary, valuation. Data scope on the node (tab `stock`). */
@Injectable()
export class StockQueryService {
  constructor(private readonly scope: ScopeService) {}

  /** SQL condition: node path (ltree column) inside the actor's stock scope. */
  scopeSql(a: StockActor, pathCol: string): RawBuilder<boolean> {
    if (a.perms === null) return sql<boolean>`true`;
    return sql<boolean>`${scopeCondition(pathCol, this.scope.nodeFilter(a.perms, STOCK_TAB))}`;
  }

  /** 404 unless the node exists and is in the actor's scope. Returns its path. */
  async nodeInScope(tx: Tx, a: StockActor, nodeId: string): Promise<{ id: string; path: string; name: string }> {
    const n = await tx.selectFrom('app.location_node').select(['id', 'name', sql<string>`path::text`.as('path')]).where('tenant_id', '=', a.tenantId).where('id', '=', nodeId).executeTakeFirst();
    if (!n || (a.perms !== null && !this.scope.contains(this.scope.nodeFilter(a.perms, STOCK_TAB), n.path))) throw AppError.notFound('Location');
    return n;
  }

  private nodeFilter(nodeId: string | undefined, includeChildren: boolean, pathCol: string): RawBuilder<boolean> {
    if (!nodeId) return sql<boolean>`true`;
    return includeChildren
      ? sql<boolean>`${sql.ref(pathCol)} <@ (select path from app.location_node where id = ${nodeId})`
      : sql<boolean>`${sql.ref(pathCol)} = (select path from app.location_node where id = ${nodeId})`;
  }

  // ------------------------------------------------------------------ balances

  async balances(tx: Tx, a: StockActor, q: z.infer<typeof StockQuery>): Promise<Page<StockBalanceRow>> {
    const held = heldStatuses(a);
    if (q.status && !held.includes(q.status)) throw AppError.forbidden();
    if (!held.length) return { data: [], nextCursor: null };
    if (q.node) await this.nodeInScope(tx, a, q.node);
    const byBatch = q.byBatch || q.expiringWithinDays !== undefined;
    const offset = readOffset(q.cursor);
    const showValue = canSeeValue(a);
    const s = (st: StockStatus) => (held.includes(st) ? sql`coalesce(sum(b.qty) filter (where b.stock_status = ${st}), 0)` : sql`0`);
    const T = a.tenantId;
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, m => `\\${m}`)}%` : null;
    // QA5-BUG-006: group the balance rows, page, and only then decorate the page (UoM, path names, avg cost, re-order
    // rule). The UoM is joined by uuid (the old `u.id::text = i.data->>'uom'` join ran a master_record scan per
    // grouped row under RLS). belowMin is resolved from the (few) active rules first, not per balance row.
    const rows = await sql<{
      item_id: string; node_id: string; bk: string; available: string; quarantine: string; rejected: string; value: string;
      item_code: string; item_name: string; uom: string | null; node_code: string; node_name: string; node_names: string[];
      batch_no: string | null; expiry_date: string | null; avg_cost: string | null; min_qty: string | null; reorder_qty: string | null; subtree_available: string | null;
    }>`
      with ${q.belowMin ? sql`below as materialized (
        select r.item_id, r.node_id from app.reorder_rule r join app.location_node rn on rn.id = r.node_id
         where r.tenant_id = ${T} and r.is_active
           and (select coalesce(sum(x.qty), 0) from app.stock_balance x join app.location_node xn on xn.id = x.node_id
                 where x.tenant_id = ${T} and x.item_id = r.item_id and x.stock_status = 'available' and xn.path <@ rn.path) < r.min_qty
      ),` : sql``}
      bal as materialized (
        select b.item_id, b.node_id, ${byBatch ? sql`b.batch_key` : sql`${NO_BATCH}::uuid`} as bk,
               ${s('available')} as available, ${s('quarantine')} as quarantine, ${s('rejected')} as rejected,
               coalesce(sum(b.value) filter (where b.stock_status = any(${sql.val(held)}::text[])), 0) as value
          from app.stock_balance b
          join app.location_node n on n.id = b.node_id
          ${like ? sql`join app.master_record i on i.id = b.item_id` : sql``}
         where b.tenant_id = ${T}
           and ${this.nodeFilter(q.node, q.includeChildren, 'n.path')}
           and ${this.scopeSql(a, 'n.path')}
           ${q.item ? sql`and b.item_id = ${q.item}` : sql``}
           ${like ? sql`and (i.code::text ilike ${like} or i.name ilike ${like})` : sql``}
           ${q.belowMin ? sql`and (b.item_id, b.node_id) in (select item_id, node_id from below)` : sql``}
         group by 1, 2, 3
        having coalesce(sum(abs(b.qty)) filter (where b.stock_status = any(${sql.val(held)}::text[])), 0) <> 0
            ${q.status ? sql`and coalesce(sum(b.qty) filter (where b.stock_status = ${q.status}), 0) <> 0` : sql``}
      ),
      page as materialized (
        select bal.*, i.code as code_ord, i.code::text as item_code, i.name as item_name, i.data->>'uom' as uom_ref,
               n.code::text as node_code, n.name as node_name, n.path, sb.batch_no, sb.expiry_date
          from bal
          join app.master_record i on i.id = bal.item_id
          join app.location_node n on n.id = bal.node_id
          left join app.stock_batch sb on sb.id = bal.bk
         where true
           ${q.expiringWithinDays !== undefined ? sql`and sb.expiry_date is not null and sb.expiry_date <= current_date + ${q.expiringWithinDays}::int` : sql``}
         order by i.code, n.path, sb.batch_no nulls first, bal.bk
         limit ${q.limit + 1} offset ${offset}
      )
      select p.item_id, p.node_id, p.bk::text as bk, p.available::text as available, p.quarantine::text as quarantine, p.rejected::text as rejected,
             p.value::text as value, p.item_code, p.item_name, u.code::text as uom, p.node_code, p.node_name,
             (select array_agg(x.name order by x.depth) from app.location_node x where x.tenant_id = ${T} and x.path @> p.path) as node_names,
             p.batch_no, p.expiry_date::text as expiry_date, ac.avg_cost::text as avg_cost,
             r.min_qty::text as min_qty, r.reorder_qty::text as reorder_qty,
             case when r.id is null then null else (select coalesce(sum(x.qty), 0) from app.stock_balance x join app.location_node xn on xn.id = x.node_id
                where x.tenant_id = ${T} and x.item_id = p.item_id and x.stock_status = 'available' and xn.path <@ p.path)::text end as subtree_available
        from page p
        left join app.master_record u on u.tenant_id = ${T}
             and u.id = case when p.uom_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p.uom_ref::uuid end
        left join app.item_avg_cost ac on ac.tenant_id = ${T} and ac.item_id = p.item_id and ac.node_id = p.node_id
        left join app.reorder_rule r on r.tenant_id = ${T} and r.item_id = p.item_id and r.node_id = p.node_id and r.is_active
       order by p.code_ord, p.path, p.batch_no nulls first, p.bk`.execute(tx);
    const more = rows.rows.length > q.limit;
    const data = rows.rows.slice(0, q.limit).map((r): StockBalanceRow => {
      const total = dec(r.available).plus(dec(r.quarantine)).plus(dec(r.rejected));
      return {
        item: { id: r.item_id, code: r.item_code, name: r.item_name, uom: r.uom },
        node: { id: r.node_id, code: r.node_code, name: r.node_name, path: r.node_names ?? [r.node_name] },
        batch: r.bk !== NO_BATCH && r.batch_no !== null ? { id: r.bk, batchNo: r.batch_no, expiryDate: r.expiry_date } : null,
        available: nz(r.available), quarantine: nz(r.quarantine), rejected: nz(r.rejected), total: q4(total),
        value: showValue ? nz(r.value) : null,
        avgCost: showValue ? (r.avg_cost === null ? null : canon(r.avg_cost)) : null,
        reorder: r.min_qty === null ? null : { minQty: canon(r.min_qty), reorderQty: canon(r.reorder_qty), belowMin: dec(r.subtree_available).lt(dec(r.min_qty)) },
      };
    });
    return { data, nextCursor: more ? offsetCursor(offset + q.limit) : null };
  }

  // ------------------------------------------------------------------ ledger

  async ledger(tx: Tx, a: StockActor, q: z.infer<typeof LedgerQuery>): Promise<Page<StockLedgerRow>> {
    const held = heldStatuses(a);
    if (!held.length) return { data: [], nextCursor: null };
    if (q.node) await this.nodeInScope(tx, a, q.node);
    const cur = decodeCursor(q.cursor);
    const types = q.movementType ? q.movementType.split(',').map(t => t.trim()).filter(Boolean) : [];
    const showValue = canSeeValue(a);
    const T = a.tenantId;
    // QA5-BUG-007: page first (keyset on (at, id), stock_movement_at / stock_movement_item), then decorate only the page.
    // The running balance of a page row = the balance row's qty now − the qty of later movements of the same
    // item × node × batch × status (an index range over that key), instead of a window over the whole tenant.
    const rows = await sql<{
      id: string; at: Date; movement_type: StockPost['movementType']; item_id: string; item_code: string; item_name: string; node_id: string; node_name: string;
      batch_no: string | null; stock_status: StockStatus; qty_in: string; qty_out: string; bal_after: string; unit_cost: string; value: string;
      document_id: string | null; doc_type_key: string | null; doc_number: string | null; line_no: number | null; reason: string | null; actor: string | null;
    }>`
      select m.id::text as id, m.at, m.movement_type, m.item_id, i.code::text as item_code, i.name as item_name, m.node_id, n.name as node_name,
             sb.batch_no, m.stock_status, m.qty_in::text as qty_in, m.qty_out::text as qty_out,
             (coalesce(bl.qty, 0) - coalesce(later.qty, 0))::text as bal_after,
             m.unit_cost::text as unit_cost, m.value::text as value, m.document_id, dt.key as doc_type_key, d.number as doc_number, l.line_no,
             m.reason, coalesce(u.name, case when m.actor_id is null then null else 'User' end) as actor
        from (
          select m.* from app.stock_movement m
            join app.location_node mn on mn.id = m.node_id
           where m.tenant_id = ${T}
             and m.stock_status = any(${sql.val(held)}::text[])
             ${q.item ? sql`and m.item_id = ${q.item}` : sql``}
             and ${this.nodeFilter(q.node, q.includeChildren, 'mn.path')}
             and ${this.scopeSql(a, 'mn.path')}
             ${q.from ? sql`and m.at >= ${q.from}::date` : sql``}
             ${q.to ? sql`and m.at < ${q.to}::date + 1` : sql``}
             ${types.length ? sql`and m.movement_type = any(${sql.val(types)}::text[])` : sql``}
             ${q.document ? sql`and m.document_id = ${q.document}` : sql``}
             ${cur ? sql`and (m.at, m.id) < (${new Date(cur.t)}::timestamptz, ${cur.id}::bigint)` : sql``}
           order by m.at desc, m.id desc
           limit ${q.limit + 1}
        ) m
        join app.master_record i on i.id = m.item_id
        join app.location_node n on n.id = m.node_id
        left join app.stock_batch sb on sb.id = m.batch_id
        left join app.document d on d.id = m.document_id
        left join app.doc_type dt on dt.id = d.doc_type_id
        left join app.document_line l on l.id = m.line_id
        left join app.tenant_user u on u.id = m.actor_id
        left join app.stock_balance bl on bl.tenant_id = ${T} and bl.item_id = m.item_id and bl.node_id = m.node_id
             and bl.batch_key = coalesce(m.batch_id, ${NO_BATCH}::uuid) and bl.stock_status = m.stock_status
        left join lateral (
          select sum(x.qty_in - x.qty_out) as qty from app.stock_movement x
           where x.tenant_id = ${T} and x.item_id = m.item_id and x.node_id = m.node_id and x.at >= m.at and (x.at, x.id) > (m.at, m.id)
             and x.batch_id is not distinct from m.batch_id and x.stock_status = m.stock_status
        ) later on true
       order by m.at desc, m.id desc`.execute(tx);
    const more = rows.rows.length > q.limit;
    const page = rows.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      data: page.map((r): StockLedgerRow => ({
        id: r.id, at: new Date(r.at).toISOString(), movementType: r.movement_type, item: { id: r.item_id, code: r.item_code, name: r.item_name },
        node: { id: r.node_id, name: r.node_name }, batchNo: r.batch_no, status: r.stock_status, qtyIn: canon(r.qty_in), qtyOut: canon(r.qty_out),
        balanceAfter: canon(r.bal_after), unitCost: showValue ? canon(r.unit_cost) : null, value: showValue ? canon(r.value) : null,
        document: r.document_id ? { id: r.document_id, docTypeKey: r.doc_type_key ?? '', number: r.doc_number } : null, lineNo: r.line_no, reason: r.reason, actor: r.actor,
      })),
      nextCursor: more && last ? encodeCursor(last.at, last.id) : null,
    };
  }

  // ------------------------------------------------------------------ item summary

  async itemSummary(tx: Tx, a: StockActor, itemId: string) {
    const item = await sql<{ id: string; code: string; name: string; uom: string | null }>`
      select i.id, i.code::text as code, i.name, u.code::text as uom from app.master_record i join app.master_def m on m.id = i.master_id
        left join app.master_record u on u.tenant_id = ${a.tenantId} and u.id::text = i.data->>'uom'
       where i.tenant_id = ${a.tenantId} and i.id = ${itemId} and m.key = 'item'`.execute(tx);
    if (!item.rows[0]) throw AppError.notFound('Item');
    const held = heldStatuses(a);
    const showValue = canSeeValue(a);
    const rows = await sql<{ node_id: string; node_code: string; node_name: string; available: string; quarantine: string; rejected: string; value: string; avg_cost: string | null; pending_issue: string }>`
      with nodes as (
        select node_id from app.stock_balance where tenant_id = ${a.tenantId} and item_id = ${itemId} and qty <> 0
        union select l.location_node_id from app.document_line l join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id
          where l.tenant_id = ${a.tenantId} and l.item_id = ${itemId} and t.key in ('po', 'issue_request') and not l.is_deleted and not d.is_deleted
      )
      select n.id as node_id, n.code::text as node_code, n.name as node_name,
             coalesce((select sum(qty) from app.stock_balance where tenant_id = ${a.tenantId} and item_id = ${itemId} and node_id = n.id and stock_status = 'available'), 0)::text as available,
             coalesce((select sum(qty) from app.stock_balance where tenant_id = ${a.tenantId} and item_id = ${itemId} and node_id = n.id and stock_status = 'quarantine'), 0)::text as quarantine,
             coalesce((select sum(qty) from app.stock_balance where tenant_id = ${a.tenantId} and item_id = ${itemId} and node_id = n.id and stock_status = 'rejected'), 0)::text as rejected,
             coalesce((select sum(value) from app.stock_balance where tenant_id = ${a.tenantId} and item_id = ${itemId} and node_id = n.id and stock_status = any(${sql.val(held)}::text[])), 0)::text as value,
             (select avg_cost::text from app.item_avg_cost where tenant_id = ${a.tenantId} and item_id = ${itemId} and node_id = n.id) as avg_cost,
             coalesce((select sum(greatest(s.approved - s.short_closed - s.issued, 0)) from app.document_line l
                join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id join app.line_qty_summary s on s.line_id = l.id
               where l.tenant_id = ${a.tenantId} and l.item_id = ${itemId} and l.location_node_id = n.id and t.key = 'issue_request' and not l.is_deleted and not d.is_deleted
                 and d.status_key not in ('draft', 'cancelled', 'closed')), 0)::text as pending_issue
        from nodes join app.location_node n on n.id = nodes.node_id
       where ${this.scopeSql(a, 'n.path')}
       order by n.path`.execute(tx);
    // QA5-BUG-011: open PO qty per node through the shared pending-receipt rule (documents/qty.ts), so it agrees with
    // receivable PO lines and the PO document (rejections at receipt and, per rtv.reopens_po, returns re-open it).
    const reopens = await getTenantSetting(tx, 'rtv.reopens_po');
    const po = await sql<{ node_id: string; ordered: string | null; received: string | null; rejected_at_receipt: string | null; returned: string | null }>`
      select l.location_node_id as node_id, s.ordered::text as ordered, s.received::text as received, s.rejected_at_receipt::text as rejected_at_receipt, s.returned::text as returned
        from app.document_line l join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id join app.line_qty_summary s on s.line_id = l.id
       where l.tenant_id = ${a.tenantId} and l.item_id = ${itemId} and t.key = 'po' and not l.is_deleted and not d.is_deleted
         and d.status_key not in ('draft', 'cancelled', 'closed')`.execute(tx);
    const openPo = new Map<string, bigint>();
    for (const r of po.rows) {
      const p = pendingReceiptUnits({ ordered: toUnits(r.ordered), received: toUnits(r.received), rejected_at_receipt: toUnits(r.rejected_at_receipt), returned: toUnits(r.returned) }, reopens);
      openPo.set(r.node_id, (openPo.get(r.node_id) ?? 0n) + p);
    }
    const h = (st: StockStatus, v: string) => (held.includes(st) ? canon(v) : '0');
    const nodes = rows.rows.map(r => ({
      node: { id: r.node_id, code: r.node_code, name: r.node_name },
      available: h('available', r.available), quarantine: h('quarantine', r.quarantine), rejected: h('rejected', r.rejected),
      value: showValue ? canon(r.value) : null, avgCost: showValue && r.avg_cost !== null ? canon(r.avg_cost) : null,
      openPoQty: fromUnits(openPo.get(r.node_id) ?? 0n), pendingIssueQty: canon(r.pending_issue),
    }));
    const sum = (k: 'available' | 'quarantine' | 'rejected' | 'openPoQty' | 'pendingIssueQty') => q4(nodes.reduce((t, n) => t.plus(dec(n[k])), dec(0)));
    return {
      item: item.rows[0],
      nodes,
      totals: {
        available: sum('available'), quarantine: sum('quarantine'), rejected: sum('rejected'), openPoQty: sum('openPoQty'), pendingIssueQty: sum('pendingIssueQty'),
        value: showValue ? q4(nodes.reduce((t, n) => t.plus(dec(n.value)), dec(0))) : null,
      },
    };
  }

  // ------------------------------------------------------------------ valuation

  /**
   * Value by item × node (as of the end of `asOf`, or now), paged (`limit`, offset `cursor`); `totalValue` covers all
   * pages. Caller holds view_value. QA5-BUG-008: read from stock_balance (= Σ movements, kept in the posting
   * transaction) instead of re-summing the ledger; `asOf` = balance now − movements after `asOf`.
   */
  async valuation(tx: Tx, a: StockActor, q: { node?: string; asOf?: string; cursor?: string; limit?: number }) {
    if (q.node) await this.nodeInScope(tx, a, q.node);
    // QA5-BUG-005: only the stock statuses the viewer may see (stock:view.<status>), as in balances / summary.
    const held = heldStatuses(a);
    const T = a.tenantId;
    const limit = q.limit ?? 1000;
    const offset = readOffset(q.cursor);
    // asOf: Σ movements up to asOf when that is the smaller part of the ledger, else balance now − movements after it.
    // Movements are aggregated per item × node first (no per-movement joins), then joined to the scoped balances.
    let mode: 'now' | 'before' | 'after' = 'now';
    if (q.asOf) {
      const span = await sql<{ first: Date | null }>`select min(at) as first from app.stock_movement where tenant_id = ${T}`.execute(tx);
      const first = span.rows[0]?.first ? new Date(span.rows[0].first).getTime() : Date.now();
      const cut = new Date(`${q.asOf}T23:59:59Z`).getTime();
      mode = cut - first < Date.now() - cut ? 'before' : 'after';
    }
    const statusOk = sql`m.stock_status = any(${sql.val(held)}::text[])`;
    const rows = await sql<{ item_id: string; item_code: string; item_name: string; node_id: string; node_code: string; node_name: string; qty: string; value: string; total: string; n: string }>`
      with cur as materialized (
        select b.item_id, b.node_id, sum(b.qty) as qty, sum(b.value) as value
          from app.stock_balance b join app.location_node n on n.id = b.node_id
         where b.tenant_id = ${T} and b.stock_status = any(${sql.val(held)}::text[])
           and ${this.nodeFilter(q.node, true, 'n.path')}
           and ${this.scopeSql(a, 'n.path')}
         group by 1, 2
      ),
      ${mode === 'now' ? sql`` : sql`mv as materialized (
        select m.item_id, m.node_id, sum(m.qty_in - m.qty_out) as qty, sum(m.value) as value
          from app.stock_movement m
         where m.tenant_id = ${T} and ${statusOk}
           and ${mode === 'before' ? sql`m.at < ${q.asOf}::date + 1` : sql`m.at >= ${q.asOf}::date + 1`}
         group by 1, 2
      ),`}
      v as (
        select cur.item_id, cur.node_id,
               ${mode === 'now' ? sql`cur.qty` : mode === 'before' ? sql`coalesce(mv.qty, 0)` : sql`cur.qty - coalesce(mv.qty, 0)`} as qty,
               ${mode === 'now' ? sql`cur.value` : mode === 'before' ? sql`coalesce(mv.value, 0)` : sql`cur.value - coalesce(mv.value, 0)`} as value
          from cur ${mode === 'now' ? sql`` : sql`left join mv on mv.item_id = cur.item_id and mv.node_id = cur.node_id`}
      )
      select v.item_id, i.code::text as item_code, i.name as item_name, v.node_id, n.code::text as node_code, n.name as node_name,
             v.qty::text as qty, v.value::text as value, (sum(v.value) over ())::text as total, (count(*) over ())::text as n
        from v join app.location_node n on n.id = v.node_id join app.master_record i on i.id = v.item_id
       where v.qty <> 0 or v.value <> 0
       order by n.path, i.code, v.item_id
       limit ${limit + 1} offset ${offset}`.execute(tx);
    const more = rows.rows.length > limit;
    const data = rows.rows.slice(0, limit).map(r => {
      const qty = dec(r.qty);
      return {
        item: { id: r.item_id, code: r.item_code, name: r.item_name }, node: { id: r.node_id, code: r.node_code, name: r.node_name },
        qty: canon(r.qty), value: canon(r.value), avgCost: qty.isZero() ? null : dec(r.value).div(qty).toDecimalPlaces(6).toFixed(),
      };
    });
    const first = rows.rows[0];
    return {
      asOf: q.asOf ?? null, rows: data, totalValue: first ? q4(dec(first.total)) : '0', totalRows: first ? Number(first.n) : offset,
      nextCursor: more ? offsetCursor(offset + limit) : null,
    };
  }
}

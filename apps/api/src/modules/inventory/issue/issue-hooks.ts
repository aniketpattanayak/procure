import { Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { DocStore, DocumentHooks, type SaveHookCtx, type SubmitHookCtx } from '../../documents';
import { tenantToday, validationFailed } from '../../forms';
import { getTenantSetting } from '../../identity';
import { isUuid, lockSummaries, q, qtyExceeds, units } from '../common';
import { ISSUE_LINE, ISSUE_REQUEST, ISSUE_WITHOUT_INDENT, RETURN_LINE, STORE_ISSUE, STORE_RETURN } from './issue.types';

export interface RefLine { id: string; document_id: string; item_id: string | null; status_key: string; doc_status: string; type_key: string; closed: boolean; location_node_id: string; batch_no: string | null; uom_id: string | null }

/** Lines (any type) by id with their document status and type. */
export async function refLines(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, RefLine>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const r = await sql<RefLine>`
    select l.id, l.document_id, l.item_id, l.uom_id, l.status_key, d.status_key as doc_status, t.key as type_key, l.location_node_id,
      (d.closed_at is not null or d.cancelled_at is not null) as closed, nullif(l.custom->>'batch_no', '') as batch_no
    from app.document_line l join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id
    where l.tenant_id = ${tenantId} and l.id = any(${sql.val(uniq)}::uuid[]) and not l.is_deleted and not d.is_deleted`.execute(tx);
  return new Map(r.rows.map(x => [x.id, x]));
}

/** Open quantity (still in approval) of documents of `typeKey` whose lines reference `refKey` ∈ ids, by referenced
 *  line id, excluding document `exceptDoc`. */
export async function openRefQty(tx: Tx, tenantId: string, typeKey: string, refKey: string, ids: string[], exceptDoc: string | null): Promise<Map<string, bigint>> {
  if (!ids.length) return new Map();
  const r = await sql<{ ref: string; qty: string }>`
    select l.custom->>${refKey} as ref, sum(greatest(s.requested - s.approved - s.rejected - s.cancelled, 0))::text as qty
    from app.document_line l join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id
    join app.line_qty_summary s on s.line_id = l.id
    where l.tenant_id = ${tenantId} and t.key = ${typeKey} and not l.is_deleted and not d.is_deleted and d.status_key <> 'draft'
      and l.custom->>${refKey} = any(${sql.val(ids)}::text[]) ${exceptDoc ? sql`and d.id <> ${exceptDoc}` : sql``}
    group by 1`.execute(tx);
  return new Map(r.rows.map(x => [x.ref, units(x.qty)]));
}

/** Available stock of an item at exactly this node (issues post at the line's node) [× batch; all batches when
 *  omitted — a batch-less issue is allocated FEFO across them]. */
export async function availableAt(tx: Tx, tenantId: string, itemId: string, nodeId: string, batchId?: string | null, notExpiredOn?: string | null): Promise<bigint> {
  const r = await sql<{ qty: string | null }>`
    select sum(b.qty)::text as qty from app.stock_balance b
    ${notExpiredOn ? sql`left join app.stock_batch sb on sb.id = b.batch_key` : sql``}
    where b.tenant_id = ${tenantId} and b.item_id = ${itemId} and b.stock_status = 'available' and b.node_id = ${nodeId}
      ${batchId !== undefined ? sql`and b.batch_key = ${batchId ?? '00000000-0000-0000-0000-000000000000'}` : sql``}
      ${notExpiredOn ? sql`and (sb.expiry_date is null or sb.expiry_date >= ${notExpiredOn}::date)` : sql``}`.execute(tx);
  return units(r.rows[0]?.qty ?? '0');
}

/** Available balances of an item at a node in FEFO order: batches by earliest expiry (no expiry last), then oldest
 *  batch; stock without a batch last. QA5-BUG-010: batches that expired before `notExpiredOn` (the issue date in the
 *  tenant's timezone) are skipped unless null is passed (setting `stock.allow_expired_issue`). */
export async function fefoBalances(tx: Tx, tenantId: string, itemId: string, nodeId: string, notExpiredOn: string | null): Promise<{ batchId: string | null; qty: bigint }[]> {
  const r = await sql<{ batch_id: string | null; qty: string }>`
    select nullif(b.batch_key, '00000000-0000-0000-0000-000000000000') as batch_id, b.qty::text as qty
    from app.stock_balance b left join app.stock_batch sb on sb.id = b.batch_key
    where b.tenant_id = ${tenantId} and b.item_id = ${itemId} and b.node_id = ${nodeId} and b.stock_status = 'available' and b.qty > 0
      ${notExpiredOn ? sql`and (sb.expiry_date is null or sb.expiry_date >= ${notExpiredOn}::date)` : sql``}
    order by (sb.id is null), sb.expiry_date asc nulls last, sb.created_at asc, sb.id`.execute(tx);
  return r.rows.map(x => ({ batchId: x.batch_id, qty: units(x.qty) }));
}

/**
 * QA5-BUG-010: the date expired batches are judged against — the tenant's today — or null when
 * `stock.allow_expired_issue` is on (no expiry check).
 */
export async function expiryCutoff(tx: Tx): Promise<string | null> {
  return (await getTenantSetting(tx, 'stock.allow_expired_issue')) ? null : tenantToday(tx);
}

/** 409 STOCK_BATCH_EXPIRED when the named batch expired before the cutoff. */
export async function assertNotExpired(tx: Tx, batch: string | null, cutoff: string | null, lineNo: number): Promise<void> {
  if (!batch || !cutoff) return;
  const r = await tx.selectFrom('app.stock_batch').select(['batch_no', sql<string | null>`expiry_date::text`.as('expiry')]).where('id', '=', batch).executeTakeFirst();
  if (r?.expiry && r.expiry < cutoff) {
    throw new AppError(409, 'STOCK_BATCH_EXPIRED', `Batch "${r.batch_no}" expired on ${r.expiry} and cannot be issued (line ${lineNo}).`, { batchId: batch, batchNo: r.batch_no, expiryDate: r.expiry });
  }
}

/** Store-issue qty still in approval for an item at a node [× batch] (other documents than `exceptDoc`). */
async function pendingIssues(tx: Tx, tenantId: string, itemId: string, nodeId: string, batchNo: string | null, exceptDoc: string): Promise<bigint> {
  const r = await sql<{ qty: string | null }>`
    select sum(greatest(s.requested - s.approved - s.rejected - s.cancelled, 0))::text as qty
    from app.document_line l join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id
    join app.line_qty_summary s on s.line_id = l.id
    where l.tenant_id = ${tenantId} and t.key = ${STORE_ISSUE} and not l.is_deleted and not d.is_deleted and d.status_key <> 'draft' and d.id <> ${exceptDoc}
      and l.item_id = ${itemId} and l.location_node_id = ${nodeId} ${batchNo ? sql`and l.custom->>${ISSUE_LINE.batchNo} = ${batchNo}` : sql``}`.execute(tx);
  return units(r.rows[0]?.qty ?? '0');
}

async function batchId(tx: Tx, itemId: string, batchNo: unknown): Promise<string | null | 'missing'> {
  const s = typeof batchNo === 'string' ? batchNo.trim() : '';
  if (!s) return null;
  const r = await tx.selectFrom('app.stock_batch').select('id').where('item_id', '=', itemId).where('batch_no', '=', s).executeTakeFirst();
  return r?.id ?? 'missing';
}

const OPEN_LINE = (s: string) => !['draft', 'submitted', 'cancelled', 'closed', 'rejected'].includes(s);

/**
 * Store issue / store return behaviour on the documents core:
 * - store_issue: lines reference approved issue-request lines (same item, once each) or are direct when
 *   `flow.issue.without_indent`; at submit, under row locks: qty ≤ approved − issued − other open issues of the
 *   request line, and ≤ available stock at the issuing location less other open issues (409 otherwise).
 * - store_return: lines reference store-issue lines (same item); at submit qty ≤ issued − returned − other open
 *   returns of the issue line.
 */
@Injectable()
export class IssueHooks implements OnModuleInit {
  constructor(private readonly hooks: DocumentHooks, private readonly store: DocStore) {}

  onModuleInit() {
    this.hooks.onSave(STORE_ISSUE, (tx, ctx) => this.issueSave(tx, ctx));
    this.hooks.onSubmit(STORE_ISSUE, (tx, ctx) => this.issueSubmit(tx, ctx));
    this.hooks.onSave(STORE_RETURN, (tx, ctx) => this.returnSave(tx, ctx));
    this.hooks.onSubmit(STORE_RETURN, (tx, ctx) => this.returnSubmit(tx, ctx));
  }

  // ------------------------------------------------------------------ store issue
  async issueSave(tx: Tx, ctx: SaveHookCtx): Promise<void> {
    if (ctx.mode === 'line_edits') return;
    const lines = await this.store.loadLines(tx, ctx.tenantId, ctx.documentId);
    const refs = await refLines(tx, ctx.tenantId, lines.map(l => l.custom[ISSUE_LINE.requestLine]).filter(isUuid));
    const direct = await getTenantSetting(tx, ISSUE_WITHOUT_INDENT);
    const errors: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    for (const l of lines) {
      const at = `lines.${l.line_no - 1}`;
      const ref = l.custom[ISSUE_LINE.requestLine];
      if (!isUuid(ref)) {
        if (!direct) errors.push({ path: `${at}.${ISSUE_LINE.requestLine}`, message: 'Issue against an approved issue request (direct issues are switched off).' });
      } else {
        const r = refs.get(ref);
        if (!r || r.type_key !== ISSUE_REQUEST) errors.push({ path: `${at}.${ISSUE_LINE.requestLine}`, message: 'The request line does not exist.' });
        else {
          if (r.closed || !OPEN_LINE(r.status_key)) errors.push({ path: `${at}.${ISSUE_LINE.requestLine}`, message: 'The request line is not approved (or is closed).' });
          if (r.item_id && l.item_id !== r.item_id) errors.push({ path: `${at}.item`, message: 'The item must be the item of the request line.' });
          if (seen.has(ref)) errors.push({ path: `${at}.${ISSUE_LINE.requestLine}`, message: 'The same request line is used twice on this issue.' });
          seen.add(ref);
        }
      }
      if (l.item_id && (await batchId(tx, l.item_id, l.custom[ISSUE_LINE.batchNo])) === 'missing') {
        errors.push({ path: `${at}.${ISSUE_LINE.batchNo}`, message: 'This batch does not exist for the item.' });
      }
    }
    if (errors.length) throw validationFailed(errors);
  }

  async issueSubmit(tx: Tx, ctx: SubmitHookCtx): Promise<void> {
    const lines = await this.store.loadLines(tx, ctx.tenantId, ctx.documentId);
    const withRef = lines.filter(l => isUuid(l.custom[ISSUE_LINE.requestLine]));
    if (withRef.length) {
      const refs = await refLines(tx, ctx.tenantId, withRef.map(l => String(l.custom[ISSUE_LINE.requestLine])));
      const sums = await lockSummaries(tx, ctx.tenantId, [...refs.values()].map(r => ({ id: r.id, documentId: r.document_id })));
      const open = await openRefQty(tx, ctx.tenantId, STORE_ISSUE, ISSUE_LINE.requestLine, [...refs.keys()], ctx.documentId);
      for (const l of withRef) {
        const ref = String(l.custom[ISSUE_LINE.requestLine]);
        const s = sums.get(ref);
        const left = units(s?.approved) - units(s?.issued) - units(s?.short_closed) - (open.get(ref) ?? 0n);
        if (units(l.qty) > left) {
          throw qtyExceeds(`Only ${q(left)} is pending issue on the request line; line ${l.line_no} issues ${q(units(l.qty))}.`, { lineId: l.id, requestLineId: ref, pendingIssue: q(left), asked: q(units(l.qty)) });
        }
      }
    }
    // Stock check (the ledger re-checks at posting): available at the issuing location less other open issues.
    const need = new Map<string, { itemId: string; nodeId: string; batchNo: string | null; qty: bigint; lineNo: number; lineId: string }>();
    for (const l of lines) {
      if (!l.item_id) continue;
      const batchNo = typeof l.custom[ISSUE_LINE.batchNo] === 'string' && (l.custom[ISSUE_LINE.batchNo] as string).trim() ? (l.custom[ISSUE_LINE.batchNo] as string).trim() : null;
      const k = `${l.item_id}|${l.location_node_id}|${batchNo ?? ''}`;
      const cur = need.get(k) ?? { itemId: l.item_id, nodeId: l.location_node_id, batchNo, qty: 0n, lineNo: l.line_no, lineId: l.id };
      cur.qty += units(l.qty);
      need.set(k, cur);
    }
    const cutoff = await expiryCutoff(tx);
    for (const n of need.values()) {
      const b = n.batchNo ? await batchId(tx, n.itemId, n.batchNo) : undefined;
      if (b === 'missing') throw AppError.conflict(`Batch "${n.batchNo}" does not exist for the item on line ${n.lineNo}.`);
      await assertNotExpired(tx, b ?? null, cutoff, n.lineNo);
      // Batch-less lines are allocated FEFO over batches that have not expired.
      const have = await availableAt(tx, ctx.tenantId, n.itemId, n.nodeId, b, b === undefined ? cutoff : null);
      const free = have - await pendingIssues(tx, ctx.tenantId, n.itemId, n.nodeId, n.batchNo, ctx.documentId);
      if (n.qty > free) {
        throw new AppError(409, 'STOCK_INSUFFICIENT', `Only ${q(free)} is available to issue at this location (line ${n.lineNo} needs ${q(n.qty)}).`, {
          lineId: n.lineId, itemId: n.itemId, nodeId: n.nodeId, available: q(free), asked: q(n.qty),
        });
      }
    }
  }

  // ------------------------------------------------------------------ store return
  async returnSave(tx: Tx, ctx: SaveHookCtx): Promise<void> {
    if (ctx.mode === 'line_edits') return;
    const lines = await this.store.loadLines(tx, ctx.tenantId, ctx.documentId);
    const refs = await refLines(tx, ctx.tenantId, lines.map(l => l.custom[RETURN_LINE.issueLine]).filter(isUuid));
    const errors: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    for (const l of lines) {
      const at = `lines.${l.line_no - 1}`;
      const ref = l.custom[RETURN_LINE.issueLine];
      if (!isUuid(ref)) {
        if (ctx.mode === 'submit') errors.push({ path: `${at}.${RETURN_LINE.issueLine}`, message: 'Return against a store issue line.' });
        continue;
      }
      const r = refs.get(ref);
      if (!r || r.type_key !== STORE_ISSUE || r.doc_status === 'draft') { errors.push({ path: `${at}.${RETURN_LINE.issueLine}`, message: 'The issue line does not exist.' }); continue; }
      if (r.item_id && l.item_id !== r.item_id) errors.push({ path: `${at}.item`, message: 'The item must be the item of the issue line.' });
      if (seen.has(ref)) errors.push({ path: `${at}.${RETURN_LINE.issueLine}`, message: 'The same issue line is used twice on this return.' });
      seen.add(ref);
    }
    if (errors.length) throw validationFailed(errors);
  }

  async returnSubmit(tx: Tx, ctx: SubmitHookCtx): Promise<void> {
    const lines = (await this.store.loadLines(tx, ctx.tenantId, ctx.documentId)).filter(l => isUuid(l.custom[RETURN_LINE.issueLine]));
    if (!lines.length) return;
    const refs = await refLines(tx, ctx.tenantId, lines.map(l => String(l.custom[RETURN_LINE.issueLine])));
    const sums = await lockSummaries(tx, ctx.tenantId, [...refs.values()].map(r => ({ id: r.id, documentId: r.document_id })));
    const open = await openRefQty(tx, ctx.tenantId, STORE_RETURN, RETURN_LINE.issueLine, [...refs.keys()], ctx.documentId);
    for (const l of lines) {
      const ref = String(l.custom[RETURN_LINE.issueLine]);
      const s = sums.get(ref);
      const left = units(s?.issued) - units(s?.returned) - (open.get(ref) ?? 0n);
      if (units(l.qty) > left) {
        throw qtyExceeds(`Only ${q(left)} of the issue line can still be returned; line ${l.line_no} returns ${q(units(l.qty))}.`, { lineId: l.id, issueLineId: ref, returnable: q(left), asked: q(units(l.qty)) });
      }
    }
  }
}

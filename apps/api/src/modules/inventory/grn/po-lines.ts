import Decimal from 'decimal.js';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import { getTenantSetting } from '../../identity';

export interface PoLineInfo {
  id: string; document_id: string; line_no: number; item_id: string | null; uom_id: string | null; qty: string; rate: string | null;
  status_key: string; location_node_id: string; discount_pct: string | null; party_id: string | null; doc_status: string; number: string | null;
  doc_location: string; closed: boolean; type_key: string; ordered: string | null; tax_amount: string | null;
}

/** PO lines (with their PO header) by id. Lines of other types are returned too (callers check `type_key`). */
export async function loadPoLines(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, PoLineInfo>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const r = await sql<PoLineInfo>`
    select l.id, l.document_id, l.line_no, l.item_id, l.uom_id, l.qty::text as qty, l.rate::text as rate, l.status_key, l.location_node_id,
      nullif(l.custom->>'discount_pct', '') as discount_pct, d.party_id, d.status_key as doc_status, d.number, d.location_node_id as doc_location,
      (d.closed_at is not null or d.cancelled_at is not null) as closed, t.key as type_key, s.ordered::text as ordered,
      (select sum(x.tax_amount)::text from app.line_tax x where x.tenant_id = l.tenant_id and x.line_id = l.id) as tax_amount
    from app.document_line l join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id
    left join app.line_qty_summary s on s.line_id = l.id
    where l.tenant_id = ${tenantId} and l.id = any(${sql.val(uniq)}::uuid[]) and not l.is_deleted and not d.is_deleted`.execute(tx);
  return new Map(r.rows.map(x => [x.id, x]));
}

/** PO statuses in which receipts are allowed. */
const OPEN_PO = new Set(['approved', 'partially_approved', 'partially_received', 'received', 'on_hold']);
const CLOSED_LINE = new Set(['draft', 'submitted', 'cancelled', 'closed', 'rejected']);

/** Why a PO line cannot be received against (null = it can). */
export function notReceivable(p: PoLineInfo | undefined): string | null {
  if (!p || p.type_key !== 'po') return 'The PO line does not exist.';
  if (p.closed || !OPEN_PO.has(p.doc_status)) return 'The purchase order is not approved (or is closed / being amended).';
  if (CLOSED_LINE.has(p.status_key) || Number(p.ordered ?? 0) <= 0) return 'The PO line is not open for receipt.';
  return null;
}

/** Rate per unit received: PO rate less line discount (4 decimals). */
export function poNetRate(p: Pick<PoLineInfo, 'rate' | 'discount_pct'>): string | null {
  if (p.rate === null) return null;
  const d = p.discount_pct ? new Decimal(p.discount_pct) : new Decimal(0);
  return new Decimal(p.rate).mul(new Decimal(100).minus(d)).div(100).toDecimalPlaces(4).toString();
}

/** Stock valuation rate of a receipt: PO net rate, plus line tax per unit when `stock.cost_includes_tax` is on. */
export async function receiptCost(tx: Tx, p: PoLineInfo): Promise<string> {
  const net = new Decimal(poNetRate(p) ?? '0');
  const withTax = await getTenantSetting(tx, 'stock.cost_includes_tax');
  if (!withTax || !p.tax_amount || new Decimal(p.qty).lte(0)) return net.toDecimalPlaces(6).toString();
  return net.plus(new Decimal(p.tax_amount).div(p.qty)).toDecimalPlaces(6).toString();
}

/** Items that need a quality check: `requires_qc` on the item, or on any master record the item links to (e.g. its
 *  category). Pure configuration: the flag is a data field tenants add to whichever master they like. */
export async function qcItems(tx: Tx, tenantId: string, itemIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(itemIds)];
  if (!ids.length) return new Set();
  const r = await sql<{ id: string }>`
    select i.id from app.master_record i
    where i.tenant_id = ${tenantId} and i.id = any(${sql.val(ids)}::uuid[]) and (
      i.data->>'requires_qc' = 'true' or exists (
        select 1 from jsonb_each_text(i.data) kv join app.master_record m on m.tenant_id = i.tenant_id and m.id::text = kv.value
        where m.data->>'requires_qc' = 'true'))`.execute(tx);
  return new Set(r.rows.map(x => x.id));
}

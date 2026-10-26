import { z } from 'zod';
import { Uuid } from './common';

/**
 * STOCK CONTRACT (Phase 5, frozen). ADR-0016. Stock is a movement ledger; balances are derived and maintained in the
 * same transaction. GRN, return-to-vendor, transfer, adjustment, physical count, issue request, store issue and
 * store return are SYSTEM document types (keys `grn`, `rtv`, `stock_transfer`, `stock_adjustment`, `stock_count`,
 * `issue_request`, `store_issue`, `store_return`; module feature `grn` for grn/rtv, `store` for the rest).
 */

/** Query-string boolean: 'false' / '0' / '' are false (z.coerce.boolean would make them true). */
const QBool = z.preprocess(v => (typeof v === 'string' ? !['false', '0', '', 'no', 'off'].includes(v.toLowerCase()) : v), z.boolean());
const Dec = z.string().regex(/^-?\d+(\.\d+)?$/, 'Decimal string');
export const StockStatus = z.enum(['available', 'quarantine', 'rejected']);
export type StockStatus = z.infer<typeof StockStatus>;

/** What the StockLedger service accepts (internal API used by GRN/issue/transfer/... modules and workflow effects). */
export interface StockPost {
  itemId: string; nodeId: string; batchId?: string | null; status: StockStatus;
  movementType: 'opening' | 'receipt' | 'issue' | 'return' | 'transfer_out' | 'transfer_in' | 'adjustment_in' | 'adjustment_out'
    | 'block' | 'unblock' | 'reject' | 'rtv' | 'count_in' | 'count_out' | 'reversal';
  qtyIn?: string; qtyOut?: string;
  /** Receipts/opening: cost per base unit (PO rate incl. landed costs per tenant setting). Outs: computed by valuation. */
  unitCost?: string;
  documentId?: string | null; lineId?: string | null; pairId?: string | null; reason?: string | null;
  idempotencyKey?: string;
}

export interface StockBalanceRow {
  item: { id: string; code: string; name: string; uom: string | null }; node: { id: string; code: string; name: string; path: string[] };
  batch: { id: string; batchNo: string; expiryDate: string | null } | null;
  available: string; quarantine: string; rejected: string; total: string;
  value: string | null;            // null when the viewer lacks stock:action.view_value
  avgCost: string | null;
  reorder: { minQty: string; reorderQty: string; belowMin: boolean } | null;
}
export const StockQuery = z.object({
  node: Uuid.optional(), includeChildren: QBool.default(true), item: Uuid.optional(), q: z.string().max(100).optional(),
  status: StockStatus.optional(), byBatch: QBool.default(false), belowMin: QBool.default(false),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface StockLedgerRow {
  id: string; at: string; movementType: StockPost['movementType']; item: { id: string; code: string; name: string };
  node: { id: string; name: string }; batchNo: string | null; status: StockStatus; qtyIn: string; qtyOut: string;
  balanceAfter: string; unitCost: string | null; value: string | null;
  document: { id: string; docTypeKey: string; number: string | null } | null; lineNo: number | null; reason: string | null; actor: string | null;
}
export const LedgerQuery = z.object({
  item: Uuid.optional(), node: Uuid.optional(), includeChildren: QBool.default(true), from: z.string().date().optional(), to: z.string().date().optional(),
  movementType: z.string().optional(), document: Uuid.optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const OpeningBalanceInput = z.object({
  rows: z.array(z.object({ itemId: Uuid, nodeId: Uuid, batchNo: z.string().max(60).optional(), expiryDate: z.string().date().optional(), qty: Dec, unitCost: Dec })).min(1).max(5000),
  asOf: z.string().date(),
});

export const ReorderRuleInput = z.object({
  itemId: Uuid, nodeId: Uuid, minQty: Dec, reorderQty: Dec, maxQty: Dec.optional(), autoIndent: z.boolean().default(false), isActive: z.boolean().default(true),
});

export const BlockInput = z.object({ itemId: Uuid, nodeId: Uuid, batchId: Uuid.optional(), qty: Dec, reason: z.string().trim().min(3).max(500), direction: z.enum(['block', 'unblock']) });

/** GRN line system values (line form `grn_line`): po_line (hidden ref), item, uom, qty (= received), accepted_qty,
 *  rejected_qty, reject_reason, batch_no, mfg_date, expiry_date, rate (from PO), amount, photos (files),
 *  location (receiving node). Header: location, doc_date, party (vendor), po (hidden ref), invoice_no, invoice_date,
 *  challan_no, vehicle_no, gate_entry_no, photos. */
export interface ReceivablePoLine {
  poLineId: string; poId: string; poNumber: string | null; lineNo: number; vendor: { id: string; code: string; name: string };
  item: { id: string; code: string; name: string } | null; uom: string | null; ordered: string; received: string;
  pendingReceipt: string; maxReceivable: string; /* pending × (1 + tolerance %) */ rate: string | null; expectedDate: string | null;
  location: { id: string; name: string };
}
export const GrnFromPo = z.object({
  lines: z.array(z.object({ poLineId: Uuid, qty: Dec, acceptedQty: Dec.optional(), rejectedQty: Dec.optional(), rejectReason: z.string().max(500).optional(),
    batchNo: z.string().max(60).optional(), mfgDate: z.string().date().optional(), expiryDate: z.string().date().optional(), values: z.record(z.string(), z.unknown()).default({}) })).min(1).max(500),
  values: z.record(z.string(), z.unknown()).default({}),    // header: invoice no/date, challan, vehicle, photos, custom
  submit: z.boolean().default(false),
});

/** Issue against a request (issue_request lines) or direct (setting flow.issue.without_indent). */
export interface IssuableLine { requestLineId: string; requestId: string; requestNumber: string | null; lineNo: number; item: { id: string; code: string; name: string }; uom: string | null; requested: string; issued: string; pendingIssue: string; available: string; location: { id: string; name: string }; requestedBy: string | null }
export interface ReturnableLine { issueLineId: string; issueId: string; issueNumber: string | null; lineNo: number; item: { id: string; code: string; name: string }; uom: string | null; issued: string; returned: string; returnable: string; batchNo: string | null }

export const CountSnapshotInput = z.object({ nodeId: Uuid, includeChildren: z.boolean().default(false), itemIds: z.array(Uuid).max(5000).optional() });

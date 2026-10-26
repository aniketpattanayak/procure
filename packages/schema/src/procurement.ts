import { z } from 'zod';
import { Uuid } from './common';

/**
 * PROCUREMENT CONTRACT (Phase 4, frozen). ADR-0013.
 * Indent, Vendor selection and Purchase order are SYSTEM document types on the documents core
 * (keys `indent`, `vendor_selection`, `po`; module features `indent`, `vendor_quotes`, `purchase`). Their forms are
 * ordinary forms with extra system fields; tenants add custom fields, design workflows and numbering as for any type.
 */

const Dec = z.string().regex(/^\d+(\.\d+)?$/, 'Decimal string');

/** Quantity slab. Either an absolute `rate` or a `discountPct` off the base quoted rate applies from `fromQty`. */
export const QuoteSlab = z.object({
  fromQty: Dec,
  toQty: Dec.optional(),
  rate: Dec.optional(),
  discountPct: Dec.optional(),
}).refine(s => (s.rate === undefined) !== (s.discountPct === undefined), 'Give either a rate or a discount %');

export const VendorQuoteInput = z.object({
  vendorId: Uuid,
  quotedRate: Dec,
  currency: z.string().length(3).default('INR'),
  uomId: Uuid.optional(),
  moq: Dec.optional(),
  leadTimeDays: z.number().int().min(0).max(3650).optional(),
  validUntil: z.string().date().optional(),
  paymentTermsId: Uuid.optional(),
  freight: Dec.default('0'),
  freightBasis: z.enum(['lump_sum', 'per_unit']).default('lump_sum'),
  taxPct: Dec.default('0'),
  slabs: z.array(QuoteSlab).max(20).default([]),
  notes: z.string().max(5000).optional(),
  fileIds: z.array(Uuid).max(20).default([]),
  loggedAt: z.string().datetime().optional(),
  custom: z.record(z.string(), z.unknown()).default({}),
  /** Also log the same quote on these other indent lines (same item). */
  alsoForLineIds: z.array(Uuid).max(200).default([]),
});
export type VendorQuoteInput = z.infer<typeof VendorQuoteInput>;

export interface VendorQuoteRow extends Omit<VendorQuoteInput, 'alsoForLineIds'> {
  id: string; indentLineId: string; itemId: string | null; vendor: { id: string; code: string; name: string };
  version: number; supersedesId: string | null; isCurrent: boolean; createdAt: string; createdBy: { id: string; name: string };
}

/** Comparison sheet for one indent line (or all open lines of one item). Landed cost per unit is computed by the
 *  tenant setting `procurement.landed_cost_formula` (formula language; inputs: rate, qty, freight, freight_per_unit,
 *  tax_pct, lead_time_days, moq) — default `rate * (1 + tax_pct / 100) + freight_per_unit`. */
export interface ComparisonSheet {
  itemId: string | null; itemName: string | null; qty: string; uom: string | null;
  lines: { lineId: string; documentNumber: string | null; lineNo: number; pendingSelection: string }[];
  vendors: {
    vendor: { id: string; code: string; name: string };
    quoteId: string; quotedRate: string; effectiveRate: string; /* slab applied at qty */
    freightPerUnit: string; taxPct: string; landedCostPerUnit: string; landedTotal: string;
    leadTimeDays: number | null; moq: string | null; validUntil: string | null; expired: boolean;
    paymentTerms: string | null; quotesLogged: number; lastLoggedAt: string;
    isBest: boolean; /* lowest landed cost among valid quotes meeting MOQ */
    warnings: ('expired' | 'below_moq' | 'currency_differs')[];
  }[];
  /** Previous POs for this item: last 5 rates per vendor (rate history). */
  history: { vendorId: string; vendorName: string; poNumber: string; date: string; rate: string }[];
}

/**
 * Vendor selection = document of type `vendor_selection`. One selection document may cover many indent lines; each
 * selection line = (indent line, vendor, qty, rate, quote). Splitting one indent line across vendors = several
 * selection lines for the same indent line. Submit writes `selected` events on the indent lines (and
 * `over_approved` for any excess, which requires `doc.vendor_selection:action.over_approve` + reason and is capped
 * by setting `selection.max_over_approval_pct`). The selection's own workflow approves/reduces selection lines;
 * rejected/reduced qty writes `selection_cancelled` back on the indent line.
 */
export const SelectionLineInput = z.object({
  indentLineId: Uuid,
  vendorId: Uuid,
  quoteId: Uuid.optional(),
  qty: Dec,
  rate: Dec,
  reason: z.string().max(500).optional(),    // required when this line causes over-approval
});
export const SelectionCreate = z.object({
  values: z.record(z.string(), z.unknown()).default({}),   // header custom fields
  lines: z.array(SelectionLineInput).min(1).max(1000),
  submit: z.boolean().default(false),
});

/** Lines available to order: approved selection lines (or approved indent lines when vendor selection is off). */
export interface OrderableLine {
  sourceLineId: string; sourceKind: 'selection' | 'indent'; indentLineId: string; indentNumber: string | null; lineNo: number;
  item: { id: string; code: string; name: string } | null; uom: string | null;
  vendor: { id: string; code: string; name: string } | null; rate: string | null;
  location: { id: string; name: string }; requiredDate: string | null; pendingOrder: string;
}

/** POST /procurement/po/from-lines — groups picks by vendor (one PO per vendor) and creates draft POs. */
export const PoFromLines = z.object({
  picks: z.array(z.object({ sourceLineId: Uuid, qty: Dec, vendorId: Uuid.optional() /* required for indent sources */, rate: Dec.optional() })).min(1).max(1000),
  values: z.record(z.string(), z.unknown()).default({}),   // header values applied to every created PO
});

/** Delivery schedule rows live in the PO line's grid field `schedule` (system): [{ date, qty }] summing to qty. */
export interface TaxLine { component: 'cgst' | 'sgst' | 'igst' | 'cess'; ratePct: string; taxableAmount: string; taxAmount: string }

export const FollowupInput = z.object({
  lineId: Uuid.optional(),
  contactMode: z.enum(['call', 'email', 'whatsapp', 'visit', 'other']).default('call'),
  contactPerson: z.string().max(120).optional(),
  promisedDate: z.string().date().optional(),
  revisedExpectedDate: z.string().date().optional(),
  reason: z.string().max(500).optional(),
  notes: z.string().max(5000).optional(),
}).refine(v => !v.revisedExpectedDate || !!v.reason, { path: ['reason'], message: 'Give a reason when the expected date changes' });
export interface FollowupRow { id: string; lineId: string | null; lineNo: number | null; contactMode: string; contactPerson: string | null; promisedDate: string | null; revisedExpectedDate: string | null; previousExpectedDate: string | null; reason: string | null; notes: string | null; createdAt: string; createdBy: { id: string; name: string } }

/** Amendment: POST /docs/po/:id/amend {reason} → snapshot as rev N, PO editable (status 'amending'); submit sends
 *  only the changed lines (or all, per workflow granularity) back through the PO workflow. Ledger deltas against the
 *  indent lines are written on approval (ordered / order_cancelled). */
export const AmendInput = z.object({ reason: z.string().trim().min(3).max(500) });
export interface RevisionDiff {
  header: { field: string; label: string; before: unknown; after: unknown }[];
  lines: { lineNo: number; change: 'added' | 'removed' | 'changed'; fields: { field: string; label: string; before: unknown; after: unknown }[] }[];
}
export interface RevisionRow { revNo: number; status: 'open' | 'approved' | 'rejected' | 'withdrawn'; reason: string | null; createdAt: string; createdBy: string | null; diff: RevisionDiff | null }

/** GST engine inputs: item's `tax_code` (lookup → tax_code master: rate_pct, cess_pct), vendor `state_code`,
 *  ship-to = PO header `location`'s nearest ancestor with custom `state_code` (else tenant address stateCode).
 *  Same state → CGST + SGST (rate/2 each); different → IGST; no vendor state → IGST. */
export const TAX_MASTER_KEY = 'tax_code';

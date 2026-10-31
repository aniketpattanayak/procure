'use client';
/**
 * Procurement client (docs/contracts/phase-4-api.md). One place for paths and query keys.
 *
 * Mock layer: while the Phase 4 endpoints are being built, `NEXT_PUBLIC_PROCUREMENT_MOCK=1` (build time) or
 * localStorage `procure.mock.procurement = 1` (per browser) answers these calls from `./mock` with the same types.
 * Generic `/docs/*` calls (lists, detail, workflow) always go to the real API.
 */
import type {
  ComparisonSheet, DocumentRow, FollowupRow, OrderableLine, Page, RevisionRow, TaxLine, VendorQuoteRow,
} from '@procure/schema';
import type { AmendInput, FollowupInput, PoFromLines, SelectionCreate, VendorQuoteInput } from '@procure/schema';
import type { z } from 'zod';
import { http } from '@/lib/api';
import { docKeys } from '@/features/documents/api';

export type QuoteBody = z.input<typeof VendorQuoteInput>;
export type SelectionBody = z.input<typeof SelectionCreate>;
export type PoFromLinesBody = z.input<typeof PoFromLines>;
export type FollowupBody = z.input<typeof FollowupInput>;
export type AmendBody = z.input<typeof AmendInput>;

/** GET /docs/po/:id/taxes. `totals` keys: taxable, cgst, sgst, igst, cess, tax, grand (any may be missing). */
export interface PoTaxes {
  lines: Record<string, TaxLine[]>;
  totals: Partial<Record<'taxable' | 'cgst' | 'sgst' | 'igst' | 'cess' | 'tax' | 'grand' | 'freight' | 'otherCharges' | 'discount', string>>;
}

export interface SelectableQuery { item?: string; location?: string; q?: string; cursor?: string | null; limit?: number }
export interface OrderableQuery extends SelectableQuery { vendor?: string }

const enc = encodeURIComponent;

export function mockEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_PROCUREMENT_MOCK === '1') return true;
  try { return typeof window !== 'undefined' && window.localStorage.getItem('procure.mock.procurement') === '1'; } catch { return false; }
}

async function mock() {
  return (await import('./mock')).mockApi;
}

function pick<A extends unknown[], R>(real: (...a: A) => Promise<R>, fake: (m: Awaited<ReturnType<typeof mock>>, ...a: A) => Promise<R>) {
  return async (...a: A): Promise<R> => (mockEnabled() ? fake(await mock(), ...a) : real(...a));
}

export const procApi = {
  quotes: pick(
    (lineId: string, all?: boolean) => http.get<VendorQuoteRow[]>(`/procurement/indent-lines/${enc(lineId)}/quotes`, { all: all ? true : undefined }),
    (m, lineId: string, all?: boolean) => m.quotes(lineId, !!all),
  ),
  logQuote: pick(
    (lineId: string, body: QuoteBody) => http.post<VendorQuoteRow[]>(`/procurement/indent-lines/${enc(lineId)}/quotes`, body),
    (m, lineId, body) => m.logQuote(lineId, body),
  ),
  editQuote: pick(
    (quoteId: string, body: QuoteBody) => http.put<VendorQuoteRow>(`/procurement/quotes/${enc(quoteId)}`, body),
    (m, quoteId, body) => m.editQuote(quoteId, body),
  ),
  approveQuote: pick(
    (quoteId: string, qty?: string) => http.post<DocumentRow>(`/procurement/quotes/${enc(quoteId)}/approve`, { qty }),
    (m, quoteId, qty) => m.approveQuote(quoteId, qty),
  ),
  lineComparison: pick(
    (lineId: string, qty?: string) => http.get<ComparisonSheet>(`/procurement/indent-lines/${enc(lineId)}/comparison`, { qty }),
    (m, lineId, qty) => m.lineComparison(lineId, qty),
  ),
  itemComparison: pick(
    (itemId: string, location?: string) => http.get<ComparisonSheet>(`/procurement/items/${enc(itemId)}/comparison`, { location }),
    (m, itemId, location) => m.itemComparison(itemId, location),
  ),
  selectableLines: pick(
    (q: SelectableQuery) => http.get<Page<OrderableLine>>('/procurement/selectable-lines', { item: q.item, location: q.location, q: q.q?.trim() || undefined, cursor: q.cursor ?? undefined, limit: q.limit ?? 100 }),
    (m, q) => m.selectableLines(q),
  ),
  createSelection: pick(
    (body: SelectionBody) => http.post<DocumentRow>('/procurement/selections', body),
    (m, body) => m.createSelection(body),
  ),
  orderableLines: pick(
    (q: OrderableQuery) => http.get<Page<OrderableLine>>('/procurement/orderable-lines', { vendor: q.vendor, item: q.item, location: q.location, q: q.q?.trim() || undefined, cursor: q.cursor ?? undefined, limit: q.limit ?? 100 }),
    (m, q) => m.orderableLines(q),
  ),
  poFromLines: pick(
    (body: PoFromLinesBody) => http.post<DocumentRow[]>('/procurement/po/from-lines', body),
    (m, body) => m.poFromLines(body),
  ),
  taxes: pick(
    (poId: string) => http.get<PoTaxes>(`/docs/po/${enc(poId)}/taxes`),
    (m, poId) => m.taxes(poId),
  ),
  followups: pick(
    (poId: string) => http.get<FollowupRow[]>(`/docs/po/${enc(poId)}/followups`),
    (m, poId) => m.followups(poId),
  ),
  addFollowup: pick(
    (poId: string, body: FollowupBody) => http.post<FollowupRow>(`/docs/po/${enc(poId)}/followups`, body),
    (m, poId, body) => m.addFollowup(poId, body),
  ),
  amend: pick(
    (poId: string, body: AmendBody) => http.post<DocumentRow>(`/docs/po/${enc(poId)}/amend`, body),
    (m, poId, body) => m.amend(poId, body),
  ),
  revisions: pick(
    (poId: string) => http.get<RevisionRow[]>(`/docs/po/${enc(poId)}/revisions`),
    (m, poId) => m.revisions(poId),
  ),
  shortClose: pick(
    (type: 'indent' | 'po', id: string, body: { reason: string; lineIds?: string[] }) => http.post<DocumentRow>(`/docs/${type}/${enc(id)}/short-close`, body),
    (m, type, id, body) => m.shortClose(type, id, body),
  ),
  grnShortClose: (id: string, body: { reason: string; lineIds?: string[] }) =>
    http.post<DocumentRow>(`/inventory/grn/${enc(id)}/short-close`, body),
};

export const procKeys = {
  all: ['procurement'] as const,
  quotes: (lineId: string, all: boolean) => ['procurement', 'quotes', lineId, all] as const,
  quotesAny: (lineId: string) => ['procurement', 'quotes', lineId] as const,
  lineComparison: (lineId: string, qty?: string) => ['procurement', 'comparison', 'line', lineId, qty ?? ''] as const,
  itemComparison: (itemId: string, location?: string) => ['procurement', 'comparison', 'item', itemId, location ?? ''] as const,
  comparisonAny: ['procurement', 'comparison'] as const,
  selectable: (q: SelectableQuery) => ['procurement', 'selectable', q.item ?? '', q.location ?? '', q.q ?? ''] as const,
  orderable: (q: OrderableQuery) => ['procurement', 'orderable', q.vendor ?? '', q.item ?? '', q.location ?? '', q.q ?? ''] as const,
  taxes: (poId: string) => [...docKeys.detail('po', poId), 'taxes'] as const,
  followups: (poId: string) => [...docKeys.detail('po', poId), 'followups'] as const,
  revisions: (poId: string) => [...docKeys.detail('po', poId), 'revisions'] as const,
};

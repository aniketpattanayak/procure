'use client';
/**
 * Stock + inventory client (docs/contracts/phase-5-api.md). One place for paths and query keys.
 * GRN, RTV, transfer, adjustment, count, issue request, store issue and store return are generic documents
 * (`/docs/<type>`); this file only covers the stock ledger and the "create from" endpoints.
 */
import type {
  BlockInput, CountSnapshotInput, DocumentRow, GrnFromPo, IssuableLine, OpeningBalanceInput, Page, ReceivablePoLine, ReorderRuleInput,
  ReturnableLine, StockBalanceRow, StockLedgerRow, StockStatus,
} from '@procure/schema';
import type { z } from 'zod';
import { fmtQty } from '@/features/documents/decimal';
import { t } from '@/i18n';
import { http, isApiError } from '@/lib/api';

export type GrnFromPoBody = z.input<typeof GrnFromPo>;
export type OpeningBody = z.input<typeof OpeningBalanceInput>;
export type BlockBody = z.input<typeof BlockInput>;
export type ReorderRuleBody = z.input<typeof ReorderRuleInput>;
export type CountSnapshotBody = z.input<typeof CountSnapshotInput>;

export interface BalanceQuery {
  node?: string; includeChildren?: boolean; item?: string; q?: string; status?: StockStatus; byBatch?: boolean; belowMin?: boolean;
  expiringWithinDays?: number;
}
export interface LedgerQuery {
  item?: string; node?: string; includeChildren?: boolean; from?: string; to?: string; movementType?: string; document?: string;
}

export interface ItemStockSummary {
  item: { id: string; code: string; name: string; uom: string | null };
  nodes: {
    node: { id: string; code: string; name: string };
    available: string; quarantine: string; rejected: string; value: string | null; avgCost: string | null; openPoQty: string; pendingIssueQty: string;
  }[];
  totals: { available: string; quarantine: string; rejected: string; openPoQty: string; pendingIssueQty: string; value: string | null };
}

export interface ReorderRuleRow {
  id: string; item: { id: string; code: string; name: string }; node: { id: string; code: string; name: string };
  minQty: string; reorderQty: string; maxQty: string | null; autoIndent: boolean; isActive: boolean; lastAlertAt: string | null; version: number;
}
export interface ReorderSuggestion {
  ruleId: string; item: { id: string; code: string; name: string }; node: { id: string; code: string; name: string };
  available: string; minQty: string; reorderQty: string; maxQty: string | null; suggestedQty: string; autoIndent: boolean;
}

/** GET /inventory/returnable-grn-lines row (type lives in the API module, mirrored here). */
export interface ReturnableGrnLine {
  grnLineId: string; grnId: string; grnNumber: string | null; lineNo: number; vendor: { id: string; code: string; name: string };
  item: { id: string; code: string; name: string } | null; uom: string | null; accepted: string; returned: string; inReturn: string; returnable: string;
  rate: string | null; batchNo: string | null; location: { id: string; name: string };
}

export interface RtvFromGrnBody {
  lines: { grnLineId: string; qty: string; fromStatus?: StockStatus; reason?: string }[];
  values?: Record<string, unknown>;
  submit?: boolean;
}
export interface IssueFromRequestsBody {
  lines: { requestLineId: string; qty: string; batchNo?: string; location?: string; values?: Record<string, unknown> }[];
  values?: Record<string, unknown>;
  submit?: boolean;
}
export interface ReturnFromIssuesBody {
  lines: { issueLineId: string; qty: string; status?: 'available' | 'quarantine'; location?: string; reason?: string; values?: Record<string, unknown> }[];
  values?: Record<string, unknown>;
  submit?: boolean;
}

export interface StockAdjustmentBody {
  locationId: string;
  lines: { itemId: string; qty: string; adjustmentType: string; reason?: string; unitCost?: string }[];
  notes?: string;
  submit?: boolean;
}

export interface PostedMovement { id?: string; movementType?: string; qtyIn?: string; qtyOut?: string; status?: StockStatus }

const enc = encodeURIComponent;
const bool = (b: boolean | undefined) => (b === undefined ? undefined : b ? 'true' : 'false');
const page = (cursor: string | null | undefined, limit: number) => ({ cursor: cursor ?? undefined, limit });

export const stockApi = {
  balances: (q: BalanceQuery, cursor: string | null, limit = 100) => http.get<Page<StockBalanceRow>>('/stock/balances', {
    node: q.node, includeChildren: bool(q.includeChildren), item: q.item, q: q.q?.trim() || undefined, status: q.status,
    byBatch: bool(q.byBatch), belowMin: bool(q.belowMin), expiringWithinDays: q.expiringWithinDays, ...page(cursor, limit),
  }),
  ledger: (q: LedgerQuery, cursor: string | null, limit = 100) => http.get<Page<StockLedgerRow>>('/stock/ledger', {
    item: q.item, node: q.node, includeChildren: bool(q.includeChildren), from: q.from, to: q.to, movementType: q.movementType, document: q.document,
    ...page(cursor, limit),
  }),
  summary: (itemId: string) => http.get<ItemStockSummary>(`/stock/items/${enc(itemId)}/summary`),
  opening: (body: OpeningBody) => http.post<{ posted: number }>('/stock/opening', body),
  block: (body: BlockBody) => http.post<PostedMovement[]>('/stock/block', body),
  rules: (node?: string) => http.get<ReorderRuleRow[]>('/stock/reorder-rules', { node }),
  createRule: (body: ReorderRuleBody) => http.post<ReorderRuleRow>('/stock/reorder-rules', body),
  updateRule: (id: string, body: ReorderRuleBody) => http.put<ReorderRuleRow>(`/stock/reorder-rules/${enc(id)}`, body),
  deleteRule: (id: string) => http.del<void>(`/stock/reorder-rules/${enc(id)}`),
  reorder: (node?: string) => http.get<ReorderSuggestion[]>('/stock/reorder', { node }),
  countSnapshot: (body: CountSnapshotBody) => http.post<DocumentRow>('/stock/counts/snapshot', body),
};

export const invApi = {
  receivable: (q: { vendor?: string; po?: string; item?: string; location?: string; q?: string }, cursor: string | null, limit = 200) =>
    http.get<Page<ReceivablePoLine>>('/inventory/receivable-po-lines', { vendor: q.vendor, po: q.po, item: q.item, location: q.location, q: q.q?.trim() || undefined, ...page(cursor, limit) }),
  grnFromPo: (body: GrnFromPoBody) => http.post<DocumentRow[]>('/inventory/grn/from-po', body),
  returnableGrn: (q: { vendor?: string; grn?: string; item?: string; q?: string }, cursor: string | null, limit = 200) =>
    http.get<Page<ReturnableGrnLine>>('/inventory/returnable-grn-lines', { vendor: q.vendor, grn: q.grn, item: q.item, q: q.q?.trim() || undefined, ...page(cursor, limit) }),
  rtvFromGrn: (body: RtvFromGrnBody) => http.post<DocumentRow>('/inventory/rtv/from-grn', body),
  issuable: (q: { node?: string; item?: string; request?: string; department?: string; q?: string }, cursor: string | null, limit = 200) =>
    http.get<Page<IssuableLine>>('/inventory/issuable-lines', { node: q.node, item: q.item, request: q.request, department: q.department, q: q.q?.trim() || undefined, ...page(cursor, limit) }),
  issueFromRequests: (body: IssueFromRequestsBody) => http.post<DocumentRow>('/inventory/issues/from-requests', body),
  returnable: (q: { issue?: string; item?: string; department?: string; node?: string; q?: string }, cursor: string | null, limit = 200) =>
    http.get<Page<ReturnableLine>>('/inventory/returnable-lines', { issue: q.issue, item: q.item, department: q.department, node: q.node, q: q.q?.trim() || undefined, ...page(cursor, limit) }),
  returnFromIssues: (body: ReturnFromIssuesBody) => http.post<DocumentRow>('/inventory/returns/from-issues', body),
  stockAdjustment: (body: StockAdjustmentBody) => http.post<DocumentRow>('/stock/adjustment', body),
};

export const stockKeys = {
  all: ['stock'] as const,
  summary: (itemId: string) => ['stock', 'summary', itemId] as const,
  rules: (node?: string) => ['stock', 'rules', node ?? ''] as const,
  reorder: (node?: string) => ['stock', 'reorder', node ?? ''] as const,
  receivable: (q: object) => ['inventory', 'receivable', q] as const,
  returnableGrn: (q: object) => ['inventory', 'returnable-grn', q] as const,
  issuable: (q: object) => ['inventory', 'issuable', q] as const,
  returnable: (q: object) => ['inventory', 'returnable', q] as const,
  inventory: ['inventory'] as const,
};

/** Permission keys used by the stock screens (`stock` tab + document tabs). */
export const STOCK_PERM = {
  view: 'stock:action.view',
  value: 'stock:action.view_value',
  opening: 'stock:action.opening',
  block: 'stock:action.block',
  reorder: 'stock:action.reorder',
  statusView: (s: StockStatus) => `stock:view.${s}`,
  grnAdd: 'doc.grn:action.add',
  rtvAdd: 'doc.rtv:action.add',
  issueAdd: 'doc.store_issue:action.add',
  returnAdd: 'doc.store_return:action.add',
  countAdd: 'doc.stock_count:action.add',
  indentAdd: 'doc.indent:action.add',
} as const;

export const STOCK_STATUSES: StockStatus[] = ['available', 'quarantine', 'rejected'];

/** Stock flow switches from /auth/me settings. */
export function readStockFlow(settings: Record<string, unknown> | undefined | null) {
  const s = settings ?? {};
  const pct = typeof s['grn.over_receipt_pct'] === 'number' ? (s['grn.over_receipt_pct'] as number) : 5;
  return {
    issueWithoutIndent: s['flow.issue.without_indent'] !== false,
    overReceiptPct: pct,
    multiPo: s['grn.multi_po'] === true,
  };
}

/**
 * Friendly text for stock / inventory API errors, plus the source line the error is about (PO line, request line,
 * issue line or GRN line id from the error meta) so pickers can show it inline on that line.
 */
export function stockError(e: unknown): { message: string; ref: string | null; pairs: { itemId: string; nodeId: string }[] } {
  if (!isApiError(e)) return { message: e instanceof Error ? e.message : String(e), ref: null, pairs: [] };
  const m = e.meta as Record<string, unknown>;
  const s = (k: string) => (typeof m[k] === 'string' || typeof m[k] === 'number' ? fmtQty(String(m[k])) : '?');
  const ref = ['poLineId', 'requestLineId', 'issueLineId', 'grnLineId'].map(k => m[k]).find((v): v is string => typeof v === 'string') ?? null;
  const pairs = Array.isArray(m.pairs) ? (m.pairs as { itemId: string; nodeId: string }[]) : [];
  let message = e.message;
  if (e.is('QTY_EXCEEDS_REMAINING')) {
    if ('maxReceivable' in m) message = t('stock.e.overReceipt', { pending: s('pendingReceipt'), max: s('maxReceivable'), asked: s('asked') });
    else if ('pendingIssue' in m) message = t('stock.e.overIssue', { pending: s('pendingIssue'), asked: s('asked') });
    else if ('returnable' in m) message = t('stock.e.overReturn', { left: s('returnable'), asked: s('asked') });
  } else if (e.is('STOCK_INSUFFICIENT')) message = t('stock.e.insufficient', { available: s('available'), asked: s('asked') });
  else if (e.is('STOCK_NEGATIVE')) message = t('stock.e.negative', { available: s('available'), asked: s('requested') });
  else if (e.is('STOCK_OPENING_EXISTS')) message = t('stock.e.openingExists', { n: pairs.length || 1 });
  else if (e.is('STOCK_VALUATION_LOCKED')) message = t('stock.e.valuationLocked');
  else if (e.is('STOCK_EFFECT_UNSUPPORTED')) message = t('stock.e.effectUnsupported');
  return { message, ref, pairs };
}

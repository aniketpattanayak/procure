/**
 * In-memory stand-in for the Phase 4 procurement endpoints (enabled by `mockEnabled()` in ./api). Shapes follow
 * @procure/schema exactly; data mirrors the contract's demo seed (3 vendors, a slab quote, a 300/400 split).
 * Any indent line id gets quotes on first use, so the panels work against real documents too.
 */
import type {
  ComparisonSheet, DocumentRow, FollowupRow, OrderableLine, Page, RevisionRow, TaxLine, VendorQuoteRow,
} from '@procure/schema';
import type { AmendBody, FollowupBody, OrderableQuery, PoFromLinesBody, PoTaxes, QuoteBody, SelectableQuery, SelectionBody } from './api';
import { effectiveRate, freightPerUnit, landedPerUnit, num } from './calc';

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const wait = <T,>(v: T, ms = 180) => new Promise<T>(r => setTimeout(() => r(structuredClone(v)), ms));
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const me = { id: '00000000-0000-4000-8000-000000000001', name: 'Asha Admin' };

const V = {
  a: { id: '00000000-0000-4000-8000-0000000000a1', code: 'V-001', name: 'Deccan Steel Traders' },
  b: { id: '00000000-0000-4000-8000-0000000000b2', code: 'V-002', name: 'Kaveri Industrial Supply' },
  c: { id: '00000000-0000-4000-8000-0000000000c3', code: 'V-003', name: 'Chennai Metals & Co' },
};
const ITEMS = [
  { id: '00000000-0000-4000-8000-0000000001a1', code: 'RM-104', name: 'MS round bar 12 mm', uom: 'kg' },
  { id: '00000000-0000-4000-8000-0000000001a2', code: 'CN-220', name: 'Cutting oil', uom: 'L' },
  { id: '00000000-0000-4000-8000-0000000001a3', code: 'PK-031', name: 'Corrugated box 18x12', uom: 'nos' },
];
const LOC = { id: '00000000-0000-4000-8000-0000000002a1', name: 'Pune Plant' };
const LOC2 = { id: '00000000-0000-4000-8000-0000000002a2', name: 'Chakan Warehouse' };

interface MockLine { lineId: string; indentNumber: string; lineNo: number; item: (typeof ITEMS)[number]; qty: string; selectable: string; location: { id: string; name: string }; requiredDate: string }
const LINES: MockLine[] = [
  { lineId: '00000000-0000-4000-8000-000000000301', indentNumber: 'IND/26-27/00012', lineNo: 1, item: ITEMS[0]!, qty: '700', selectable: '700', location: LOC, requiredDate: plusDays(12) },
  { lineId: '00000000-0000-4000-8000-000000000302', indentNumber: 'IND/26-27/00012', lineNo: 2, item: ITEMS[1]!, qty: '120', selectable: '120', location: LOC, requiredDate: plusDays(9) },
  { lineId: '00000000-0000-4000-8000-000000000303', indentNumber: 'IND/26-27/00012', lineNo: 3, item: ITEMS[2]!, qty: '2500', selectable: '2500', location: LOC, requiredDate: plusDays(20) },
  { lineId: '00000000-0000-4000-8000-000000000304', indentNumber: 'IND/26-27/00015', lineNo: 1, item: ITEMS[0]!, qty: '400', selectable: '400', location: LOC2, requiredDate: plusDays(25) },
  { lineId: '00000000-0000-4000-8000-000000000305', indentNumber: 'IND/26-27/00015', lineNo: 2, item: ITEMS[2]!, qty: '800', selectable: '650', location: LOC2, requiredDate: plusDays(18) },
];

const quotes = new Map<string, VendorQuoteRow[]>();   // lineId -> all versions

function seedQuotes(lineId: string): VendorQuoteRow[] {
  const existing = quotes.get(lineId);
  if (existing) return existing;
  const line = LINES.find(l => l.lineId === lineId);
  const base = line?.item.code === 'CN-220' ? 180 : line?.item.code === 'PK-031' ? 22 : 50;
  const mk = (vendor: typeof V.a, rate: number, extra: Partial<VendorQuoteRow>, version = 1, isCurrent = true, supersedesId: string | null = null): VendorQuoteRow => ({
    id: uid(), indentLineId: lineId, itemId: line?.item.id ?? null, vendor, vendorId: vendor.id, quotedRate: rate.toFixed(2), currency: 'INR',
    freight: '0', freightBasis: 'lump_sum', taxPct: '18', slabs: [], fileIds: [], custom: {}, version, supersedesId, isCurrent,
    createdAt: new Date(Date.now() - (5 - version) * 86400000).toISOString(), createdBy: me, ...extra,
  });
  const a1 = mk(V.a, base * 1.04, { leadTimeDays: 10, moq: '100', validUntil: plusDays(30), freight: '1500', notes: 'Ex-works Pune' }, 1, false);
  const a2 = mk(V.a, base, { leadTimeDays: 7, moq: '100', validUntil: plusDays(30), freight: '1500', notes: 'Revised after negotiation', slabs: [{ fromQty: '0', toQty: '999', rate: base.toFixed(2) }, { fromQty: '1000', discountPct: '10' }] }, 2, true, a1.id);
  const b = mk(V.b, base * 0.98, { leadTimeDays: 14, moq: '250', validUntil: plusDays(20), freight: '2', freightBasis: 'per_unit', taxPct: '18' });
  const c = mk(V.c, base * 0.95, { leadTimeDays: 21, moq: '500', validUntil: plusDays(-2), freight: '0', taxPct: '18', notes: 'Price valid till month end' });
  const rows = [a1, a2, b, c];
  quotes.set(lineId, rows);
  return rows;
}

function sheetFor(lineIds: string[], qtyStr?: string): ComparisonSheet {
  const lines = LINES.filter(l => lineIds.includes(l.lineId));
  const line = lines[0];
  const qty = qtyStr ?? line?.selectable ?? '100';
  const q = num(qty);
  const current = lineIds.flatMap(id => seedQuotes(id)).filter(r => r.isCurrent);
  const byVendor = new Map<string, VendorQuoteRow>();
  for (const r of current) if (!byVendor.has(r.vendor.id) || byVendor.get(r.vendor.id)!.createdAt < r.createdAt) byVendor.set(r.vendor.id, r);
  const vendors = [...byVendor.values()].map(r => {
    const eff = effectiveRate(r.quotedRate, r.slabs ?? [], q);
    const fpu = freightPerUnit(r.freight, r.freightBasis, q);
    const landed = landedPerUnit(eff, r.taxPct, fpu);
    const expired = !!r.validUntil && r.validUntil < today();
    const belowMoq = !!r.moq && q < num(r.moq);
    const warnings: ComparisonSheet['vendors'][number]['warnings'] = [];
    if (expired) warnings.push('expired');
    if (belowMoq) warnings.push('below_moq');
    return {
      vendor: r.vendor, quoteId: r.id, quotedRate: r.quotedRate, effectiveRate: eff.toFixed(2), freightPerUnit: fpu.toFixed(2), taxPct: r.taxPct ?? '0',
      landedCostPerUnit: landed.toFixed(2), landedTotal: (landed * q).toFixed(2), leadTimeDays: r.leadTimeDays ?? null, moq: r.moq ?? null,
      validUntil: r.validUntil ?? null, expired, paymentTerms: r.vendor.code === 'V-002' ? '45 days credit' : '30 days credit',
      quotesLogged: lineIds.flatMap(id => quotes.get(id) ?? []).filter(x => x.vendor.id === r.vendor.id).length, lastLoggedAt: r.createdAt,
      isBest: false, warnings,
    };
  });
  const valid = vendors.filter(v => !v.expired && !v.warnings.includes('below_moq'));
  const best = valid.sort((x, y) => num(x.landedCostPerUnit) - num(y.landedCostPerUnit))[0];
  for (const v of vendors) v.isBest = !!best && v.vendor.id === best.vendor.id;
  vendors.sort((x, y) => num(x.landedCostPerUnit) - num(y.landedCostPerUnit));
  const baseRate = num(current[0]?.quotedRate ?? 50);
  const history = [V.a, V.b].flatMap((v, vi) => [5, 4, 3, 2, 1].map((k, i) => ({
    vendorId: v.id, vendorName: v.name, poNumber: `PO/25-26/00${40 + i + vi * 5}`, date: plusDays(-k * 45 - vi * 9),
    rate: (baseRate * (0.94 + 0.025 * Math.sin(i * 1.4 + vi)) ).toFixed(2),
  })));
  return {
    itemId: line?.item.id ?? null, itemName: line?.item.name ?? 'Item', qty, uom: line?.item.uom ?? null,
    lines: lines.map(l => ({ lineId: l.lineId, documentNumber: l.indentNumber, lineNo: l.lineNo, pendingSelection: l.selectable })),
    vendors, history,
  };
}

function toOrderable(l: MockLine): OrderableLine {
  return {
    sourceLineId: l.lineId, sourceKind: 'indent', indentLineId: l.lineId, indentNumber: l.indentNumber, lineNo: l.lineNo, item: { id: l.item.id, code: l.item.code, name: l.item.name },
    uom: l.item.uom, vendor: null, rate: null, location: l.location, requiredDate: l.requiredDate, pendingOrder: l.selectable,
  };
}

const ORDERABLE: OrderableLine[] = [
  { ...toOrderable(LINES[0]!), sourceLineId: '00000000-0000-4000-8000-000000000401', sourceKind: 'selection', vendor: V.a, rate: '50.00', pendingOrder: '300' },
  { ...toOrderable(LINES[0]!), sourceLineId: '00000000-0000-4000-8000-000000000402', sourceKind: 'selection', vendor: V.b, rate: '49.00', pendingOrder: '400' },
  { ...toOrderable(LINES[1]!), sourceLineId: '00000000-0000-4000-8000-000000000403', sourceKind: 'selection', vendor: V.b, rate: '176.40', pendingOrder: '120' },
  { ...toOrderable(LINES[2]!), sourceLineId: '00000000-0000-4000-8000-000000000404', sourceKind: 'selection', vendor: V.c, rate: '20.90', pendingOrder: '2500' },
  { ...toOrderable(LINES[4]!), sourceLineId: '00000000-0000-4000-8000-000000000405', sourceKind: 'indent', pendingOrder: '650' },
];

const followups = new Map<string, FollowupRow[]>();
const revisions = new Map<string, RevisionRow[]>();

function filterLines<T extends { item: { id: string } | null; location: { id: string }; indentNumber?: string | null }>(rows: T[], q: SelectableQuery): T[] {
  const s = q.q?.trim().toLowerCase();
  return rows.filter(r => (!q.item || r.item?.id === q.item) && (!q.location || r.location.id === q.location)
    && (!s || JSON.stringify(r).toLowerCase().includes(s)));
}

function fakeDoc(type: string, number: string, extra: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: uid(), docTypeKey: type, number, statusKey: 'draft', statusLabel: 'Draft', values: {}, refs: {}, files: {}, formVersionId: uid(), lineFormVersionId: null,
    isLocked: false, submittedAt: null, submittedBy: null, createdAt: new Date().toISOString(), createdBy: me, lines: [], workflow: null,
    allowedActions: ['edit', 'submit', 'delete'], version: 1, revNo: 0, ...extra,
  };
}

export const mockApi = {
  quotes: (lineId: string, all: boolean) => wait(seedQuotes(lineId).filter(r => all || r.isCurrent)),
  logQuote: (lineId: string, body: QuoteBody) => {
    const ids = [lineId, ...(body.alsoForLineIds ?? [])];
    const vendor = Object.values(V).find(v => v.id === body.vendorId) ?? { id: body.vendorId, code: 'NEW', name: 'Vendor' };
    const rows = ids.map(id => {
      const list = seedQuotes(id);
      const { alsoForLineIds: _drop, ...rest } = body;
      const row: VendorQuoteRow = {
        ...(rest as unknown as VendorQuoteRow), currency: body.currency ?? 'INR', freight: body.freight ?? '0', freightBasis: body.freightBasis ?? 'lump_sum',
        taxPct: body.taxPct ?? '0', slabs: (body.slabs ?? []) as VendorQuoteRow['slabs'], fileIds: body.fileIds ?? [], custom: body.custom ?? {},
        id: uid(), indentLineId: id, itemId: null, vendor, version: 1, supersedesId: null, isCurrent: true, createdAt: new Date().toISOString(), createdBy: me,
      };
      list.push(row);
      return row;
    });
    return wait(rows);
  },
  editQuote: (quoteId: string, body: QuoteBody) => {
    for (const list of quotes.values()) {
      const old = list.find(r => r.id === quoteId);
      if (!old) continue;
      old.isCurrent = false;
      const { alsoForLineIds: _drop, ...rest } = body;
      const row: VendorQuoteRow = {
        ...old, ...(rest as unknown as Partial<VendorQuoteRow>), slabs: (body.slabs ?? []) as VendorQuoteRow['slabs'],
        id: uid(), version: old.version + 1, supersedesId: old.id, isCurrent: true, createdAt: new Date().toISOString(), createdBy: me,
      };
      list.push(row);
      return wait(row);
    }
    return Promise.reject(new Error('Quote not found'));
  },
  lineComparison: (lineId: string, qty?: string) => wait(sheetFor([lineId], qty)),
  itemComparison: (itemId: string, location?: string) => wait(sheetFor(LINES.filter(l => l.item.id === itemId && (!location || l.location.id === location)).map(l => l.lineId))),
  selectableLines: (q: SelectableQuery): Promise<Page<OrderableLine>> =>
    wait({ data: filterLines(LINES.map(toOrderable), q), nextCursor: null } as Page<OrderableLine>),
  createSelection: (body: SelectionBody) => wait(fakeDoc('vendor_selection', body.submit ? 'VS/26-27/00007' : (null as unknown as string), {
    statusKey: body.submit ? 'waiting_approve' : 'draft', statusLabel: body.submit ? 'Waiting for Selection approval' : 'Draft',
  }), 400),
  orderableLines: (q: OrderableQuery): Promise<Page<OrderableLine>> =>
    wait({ data: filterLines(ORDERABLE, q).filter(r => !q.vendor || r.vendor?.id === q.vendor), nextCursor: null } as Page<OrderableLine>),
  poFromLines: (body: PoFromLinesBody) => {
    const vendors = new Set(body.picks.map(p => p.vendorId ?? ORDERABLE.find(o => o.sourceLineId === p.sourceLineId)?.vendor?.id ?? 'x'));
    return wait([...vendors].map(vid => fakeDoc('po', null as unknown as string, {
      values: { party: vid }, refs: { party: { [vid]: Object.values(V).find(v => v.id === vid)?.name ?? 'Vendor' } },
    })), 400);
  },
  taxes: (poId: string): Promise<PoTaxes> => {
    void poId;
    const mk = (taxable: number, rate: number, intra: boolean): TaxLine[] => intra
      ? [{ component: 'cgst', ratePct: String(rate / 2), taxableAmount: taxable.toFixed(2), taxAmount: (taxable * rate / 200).toFixed(2) },
        { component: 'sgst', ratePct: String(rate / 2), taxableAmount: taxable.toFixed(2), taxAmount: (taxable * rate / 200).toFixed(2) }]
      : [{ component: 'igst', ratePct: String(rate), taxableAmount: taxable.toFixed(2), taxAmount: (taxable * rate / 100).toFixed(2) }];
    return wait({ lines: { __1: mk(15000, 18, true), __2: mk(21168, 18, true) }, totals: { taxable: '36168.00', cgst: '3255.12', sgst: '3255.12', igst: '0', tax: '6510.24', grand: '42678.24' } });
  },
  followups: (poId: string) => wait(followups.get(poId) ?? []),
  addFollowup: (poId: string, body: FollowupBody) => {
    const list = followups.get(poId) ?? [];
    const prev = list.find(f => f.revisedExpectedDate)?.revisedExpectedDate ?? plusDays(10);
    const row: FollowupRow = {
      id: uid(), lineId: body.lineId ?? null, lineNo: null, contactMode: body.contactMode ?? 'call', contactPerson: body.contactPerson ?? null,
      promisedDate: body.promisedDate ?? null, revisedExpectedDate: body.revisedExpectedDate ?? null, previousExpectedDate: body.revisedExpectedDate ? prev : null,
      reason: body.reason ?? null, notes: body.notes ?? null, createdAt: new Date().toISOString(), createdBy: me,
    };
    followups.set(poId, [row, ...list]);
    return wait(row);
  },
  amend: (poId: string, body: AmendBody) => {
    const list = revisions.get(poId) ?? [{ revNo: 0, status: 'approved' as const, reason: null, createdAt: new Date(Date.now() - 6 * 86400000).toISOString(), createdBy: me.name, diff: null }];
    list.unshift({ revNo: list.length, status: 'open', reason: body.reason, createdAt: new Date().toISOString(), createdBy: me.name, diff: {
      header: [{ field: 'expected_date', label: 'Expected date', before: plusDays(10), after: plusDays(18) }, { field: 'freight', label: 'Freight', before: '1500.00', after: '2000.00' }],
      lines: [
        { lineNo: 1, change: 'changed', fields: [{ field: 'qty', label: 'Quantity', before: '300', after: '350' }, { field: 'rate', label: 'Rate', before: '50.00', after: '48.50' }] },
        { lineNo: 3, change: 'added', fields: [{ field: 'item', label: 'Item', before: null, after: 'Cutting oil' }, { field: 'qty', label: 'Quantity', before: null, after: '20' }] },
      ],
    } });
    revisions.set(poId, list);
    return wait(fakeDoc('po', 'PO/26-27/00009', { id: poId, statusKey: 'amending', statusLabel: 'Amending' }));
  },
  revisions: (poId: string) => wait(revisions.get(poId) ?? []),
  shortClose: (type: string, id: string, body: { reason: string; lineIds?: string[] }) => {
    void body;
    return wait(fakeDoc(type, 'X', { id, statusKey: 'short_closed', statusLabel: 'Short-closed' }));
  },
};

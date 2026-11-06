'use client';
import type { ApprovedIndentLine, DocumentRow, OrderableLine } from '@procure/schema';
import { Button, Checkbox, cn, Dialog, DialogContent, EmptyState, Input, Label, NativeSelect, Skeleton, toast } from '@procure/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, List, PackagePlus, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { docKeys } from '@/features/documents/api';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { locationKeys, locationsApi } from '@/features/locations/api';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useCurrentLocationId } from '@/lib/location';
import { useTenantPrincipal } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { procApi, procKeys, type ApprovedIndentQuery, type PoFromIndentBody, type PoFromLinesBody } from '../api';
import { fmtRate, num } from '../calc';
import { MasterPicker, type PickedOption } from '../components/master-picker';
import { QuoteFormDialog, type QuoteLineContext } from '../quotes/quote-form';

interface Pick { qty: string; vendor: PickedOption | null; rate: string }
interface VendorHeader { deliveryDate: string; paymentTerms: PickedOption | null; remarks: string }

const rowKey = (l: OrderableLine) => `${l.indentNumber ?? 'x'}-${l.sourceLineId.slice(-4)}`;

type Tab = 'orderable' | 'approved-indents';

/** Create purchase orders from orderable lines (Tab 1) or directly from approved indent lines (Tab 2). */
export function OrderPage() {
  const qc = useQueryClient();
  const me = useTenantPrincipal();
  const switcherLocation = useCurrentLocationId(me?.userId);
  const { currency } = useTenantLocale();
  const [activeTab, setActiveTab] = useState<Tab>('orderable');

  // ---- Tab 1: Orderable lines state ----
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [vendor, setVendor] = useState<PickedOption | null>(null);
  const [item, setItem] = useState<PickedOption | null>(null);
  const [location, setLocation] = useState(switcherLocation ?? 'all');
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<DocumentRow[] | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [vendorHeaders, setVendorHeaders] = useState<Record<string, VendorHeader>>({});

  const setVendorHeader = (vendorId: string, patch: Partial<VendorHeader>) =>
    setVendorHeaders(prev => ({
      ...prev,
      [vendorId]: { deliveryDate: '', paymentTerms: null, remarks: '', ...prev[vendorId], ...patch },
    }));

  // ---- Tab 2: Approved Indents state ----
  const [aiQ, setAiQ] = useState('');
  const dAiQ = useDebounced(aiQ, 300);
  const [aiItem, setAiItem] = useState<PickedOption | null>(null);
  const [aiLocation, setAiLocation] = useState(switcherLocation ?? 'all');
  const [aiPicks, setAiPicks] = useState<Record<string, { qty: string; vendor: PickedOption | null; rate: string }>>({});
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiCreated, setAiCreated] = useState<DocumentRow[] | null>(null);
  const [aiShowConfirm, setAiShowConfirm] = useState(false);
  const [aiVendorHeaders, setAiVendorHeaders] = useState<Record<string, VendorHeader>>({});
  const [quoteForm, setQuoteForm] = useState<{ open: boolean; ctx: QuoteLineContext | null }>({ open: false, ctx: null });

  const setAiVendorHeader = (vendorId: string, patch: Partial<VendorHeader>) =>
    setAiVendorHeaders(prev => ({
      ...prev,
      [vendorId]: { deliveryDate: '', paymentTerms: null, remarks: '', ...prev[vendorId], ...patch },
    }));

  const openQuoteForm = (l: ApprovedIndentLine) => setQuoteForm({
    open: true,
    ctx: {
      lineId: l.indentLineId,
      itemId: l.item?.id ?? null,
      itemName: l.item?.name ?? '—',
      qty: l.approvedQty,
      uom: l.uom ?? '',
      docNumber: l.indentNumber,
      lineNo: l.lineNo,
    },
  });

  // ---- Shared data ----
  const locations = useQuery({
    queryKey: locationKeys.mine,
    queryFn: () => locationsApi.tree({ scope: 'mine', view: 'active' }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  // ---- Tab 1 data ----
  const orderableQuery = { vendor: vendor?.id, item: item?.id, location: location === 'all' ? undefined : location, q: dq };
  const list = useInfiniteQuery({
    queryKey: procKeys.orderable(orderableQuery),
    queryFn: ({ pageParam }) => procApi.orderableLines({ ...orderableQuery, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    retry: false,
  });
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap(p => p.data), [list.data]);
  const byId = useMemo(() => new Map(rows.map(r => [r.sourceLineId, r])), [rows]);

  // ---- Tab 2 data ----
  const approvedIndentQuery: ApprovedIndentQuery = { item: aiItem?.id, location: aiLocation === 'all' ? undefined : aiLocation, q: dAiQ };
  const aiList = useInfiniteQuery({
    queryKey: procKeys.approvedIndents(approvedIndentQuery),
    queryFn: ({ pageParam }) => procApi.approvedIndentLines({ ...approvedIndentQuery, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    retry: false,
    enabled: activeTab === 'approved-indents',
  });
  const aiRows = useMemo(() => (aiList.data?.pages ?? []).flatMap(p => p.data), [aiList.data]);

  // ---- Tab 1 handlers ----
  const toggle = (l: OrderableLine, on: boolean) => setPicks(p => {
    const n = { ...p };
    if (on) {
      const best = (l.quotes ?? []).filter(q => !q.expired).sort((a, b) => num(a.quotedRate) - num(b.quotedRate))[0];
      n[l.sourceLineId] = {
        qty: l.pendingOrder,
        vendor: l.vendor ?? (best ? { id: best.vendor.id, code: best.vendor.code, name: best.vendor.name } : null),
        rate: l.rate ?? best?.quotedRate ?? '',
      };
    } else delete n[l.sourceLineId];
    return n;
  });
  const set = (id: string, patch: Partial<Pick>) => setPicks(p => (p[id] ? { ...p, [id]: { ...p[id]!, ...patch } } : p));
  const allOn = rows.length > 0 && rows.every(r => picks[r.sourceLineId]);

  const problemOf = (l: OrderableLine, pk: Pick): string | null => {
    if (!isDecimal(pk.qty) || !dec.gt0(pk.qty)) return t('order.err.qty');
    if (dec.cmp(pk.qty, l.pendingOrder) > 0) return t('order.err.over', { qty: fmtQty(l.pendingOrder) });
    if (!pk.vendor) return t('order.err.vendor');
    if (l.sourceKind === 'indent' && !isDecimal(pk.rate)) return t('order.err.rate');
    return null;
  };

  const chosen = Object.entries(picks)
    .map(([id, pk]) => ({ id, pk, l: byId.get(id) }))
    .filter((x): x is { id: string; pk: Pick; l: OrderableLine } => !!x.l);
  const bad = chosen.filter(c => problemOf(c.l, c.pk));
  const groups = useMemo(() => {
    const m = new Map<string, { vendor: PickedOption; lines: typeof chosen; value: number }>();
    for (const c of chosen) {
      if (!c.pk.vendor) continue;
      const g = m.get(c.pk.vendor.id) ?? { vendor: c.pk.vendor, lines: [], value: 0 };
      g.lines.push(c);
      g.value += num(c.pk.qty) * num(c.pk.rate);
      m.set(c.pk.vendor.id, g);
    }
    return [...m.values()];
  }, [chosen]);

  const openConfirm = () => {
    setError(null);
    if (bad.length) { setError(t('order.err.fix', { n: bad.length })); return; }
    setShowConfirm(true);
  };

  const create = async () => {
    setError(null);
    if (bad.length) { setError(t('order.err.fix', { n: bad.length })); return; }
    setSaving(true);
    try {
      const allDocs: DocumentRow[] = [];
      for (const g of groups) {
        const vh = vendorHeaders[g.vendor.id];
        const values: Record<string, unknown> = {};
        if (vh?.deliveryDate) values['expected_date'] = vh.deliveryDate;
        if (vh?.paymentTerms) values['payment_terms'] = vh.paymentTerms.id;
        if (vh?.remarks) values['remarks'] = vh.remarks;
        const body: PoFromLinesBody = {
          values,
          picks: g.lines.map(c => ({
            sourceLineId: c.id, qty: dec.norm(c.pk.qty),
            ...(c.l.sourceKind === 'indent' || c.pk.vendor?.id !== c.l.vendor?.id ? { vendorId: c.pk.vendor!.id } : {}),
            ...(c.pk.rate && c.pk.rate !== c.l.rate ? { rate: c.pk.rate } : c.l.sourceKind === 'indent' ? { rate: c.pk.rate } : {}),
          })),
        };
        const docs = await procApi.poFromLines(body);
        allDocs.push(...docs);
      }
      setCreated(allDocs);
      setPicks({});
      setVendorHeaders({});
      setShowConfirm(false);
      void qc.invalidateQueries({ queryKey: procKeys.all });
      void qc.invalidateQueries({ queryKey: docKeys.all('po') });
      toast.success(t('order.created', { n: allDocs.length }));
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // ---- Tab 2: Approved Indents handlers ----
  const aiByLineId = useMemo(() => new Map(aiRows.map(r => [r.indentLineId, r])), [aiRows]);

  const aiToggle = (l: ApprovedIndentLine, on: boolean) => setAiPicks(p => {
    const n = { ...p };
    if (on) {
      const best = l.quotes.filter(q => !q.expired).sort((a, b) => num(a.quotedRate) - num(b.quotedRate))[0];
      n[l.indentLineId] = {
        qty: l.remainingQty,
        vendor: best ? { id: best.vendor.id, code: best.vendor.code, name: best.vendor.name } : null,
        rate: best?.quotedRate ?? '',
      };
    } else {
      delete n[l.indentLineId];
    }
    return n;
  });

  const aiSet = (id: string, patch: Partial<{ qty: string; vendor: PickedOption | null; rate: string }>) =>
    setAiPicks(p => (p[id] ? { ...p, [id]: { ...p[id]!, ...patch } } : p));

  const aiAllOn = aiRows.length > 0 && aiRows.every(r => aiPicks[r.indentLineId]);

  const aiProblemOf = (l: ApprovedIndentLine, pk: { qty: string; vendor: PickedOption | null; rate: string }): string | null => {
    if (!isDecimal(pk.qty) || !dec.gt0(pk.qty)) return t('order.err.qty');
    if (dec.cmp(pk.qty, l.remainingQty) > 0) return t('order.err.over', { qty: fmtQty(l.remainingQty) });
    if (!pk.vendor) return t('order.err.vendor');
    if (!isDecimal(pk.rate) || !dec.gt0(pk.rate)) return t('order.err.rate');
    return null;
  };

  const aiChosen = Object.entries(aiPicks)
    .map(([id, pk]) => ({ id, pk, l: aiByLineId.get(id) }))
    .filter((x): x is { id: string; pk: { qty: string; vendor: PickedOption | null; rate: string }; l: ApprovedIndentLine } => !!x.l);
  const aiBad = aiChosen.filter(c => aiProblemOf(c.l, c.pk));

  const aiGroups = useMemo(() => {
    const m = new Map<string, { vendor: PickedOption; lines: typeof aiChosen; value: number }>();
    for (const c of aiChosen) {
      if (!c.pk.vendor) continue;
      const g = m.get(c.pk.vendor.id) ?? { vendor: c.pk.vendor, lines: [], value: 0 };
      g.lines.push(c);
      g.value += num(c.pk.qty) * num(c.pk.rate);
      m.set(c.pk.vendor.id, g);
    }
    return [...m.values()];
  }, [aiChosen]);

  const aiOpenConfirm = () => {
    setAiError(null);
    if (aiBad.length) { setAiError(t('order.err.fix', { n: aiBad.length })); return; }
    setAiShowConfirm(true);
  };

  const aiCreate = async () => {
    setAiError(null);
    if (aiBad.length) { setAiError(t('order.err.fix', { n: aiBad.length })); return; }
    setAiSaving(true);
    try {
      const allDocs: DocumentRow[] = [];
      for (const g of aiGroups) {
        const vh = aiVendorHeaders[g.vendor.id];
        const values: Record<string, unknown> = {};
        if (vh?.deliveryDate) values['expected_date'] = vh.deliveryDate;
        if (vh?.paymentTerms) values['payment_terms'] = vh.paymentTerms.id;
        if (vh?.remarks) values['remarks'] = vh.remarks;
        const body: PoFromIndentBody = {
          values,
          picks: g.lines.map(c => ({
            indentLineId: c.id,
            vendorId: c.pk.vendor!.id,
            qty: dec.norm(c.pk.qty),
            rate: dec.norm(c.pk.rate),
          })),
        };
        const docs = await procApi.poFromIndent(body);
        allDocs.push(...docs);
      }
      setAiCreated(allDocs);
      setAiPicks({});
      setAiVendorHeaders({});
      setAiShowConfirm(false);
      void qc.invalidateQueries({ queryKey: procKeys.all });
      void qc.invalidateQueries({ queryKey: docKeys.all('po') });
      toast.success(t('order.created', { n: allDocs.length }));
    } catch (e) {
      setAiError(isApiError(e) ? e.message : String(e));
    } finally {
      setAiSaving(false);
    }
  };

  return (
    <PageBody>
      <PageHeader
        back={<Link href="/docs/po" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('order.back')}</Link>}
        title={t('order.title')}
        description={t('order.hint')}
      />

      {/* Tab switcher */}
      <div className="mb-4 flex gap-1 rounded-lg bg-subtle p-1 w-fit" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'orderable'}
          onClick={() => setActiveTab('orderable')}
          className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors', activeTab === 'orderable' ? 'bg-bg shadow-sm text-fg' : 'text-fg-muted hover:text-fg')}
          data-testid="order-tab-orderable"
        >
          <PackagePlus className="size-3.5" aria-hidden />
          Create from Selection / Orderable Lines
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'approved-indents'}
          onClick={() => setActiveTab('approved-indents')}
          className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors', activeTab === 'approved-indents' ? 'bg-bg shadow-sm text-fg' : 'text-fg-muted hover:text-fg')}
          data-testid="order-tab-approved-indents"
        >
          <List className="size-3.5" aria-hidden />
          Approved Indents
        </button>
      </div>

      {/* ======== TAB 1: ORDERABLE LINES ======== */}
      {activeTab === 'orderable' && (
        <>
          {created && (
            <InlineAlert tone="success" className="mb-4" data-testid="order-created">
              <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-4" aria-hidden />{t('order.createdTitle', { n: created.length })}</p>
              <ul className="mt-2 space-y-1">
                {created.map((d, i) => (
                  <li key={d.id}>
                    <Link href={`/docs/po/${d.id}`} className="font-medium underline-offset-2 hover:underline" data-testid={`order-created-${i}`}>
                      {d.number ?? t('order.draftFor', { vendor: refName(d) })}
                    </Link>
                    <span className="text-fg-muted"> · {t('order.draftLines', { n: d.lines.length })}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm">{t('order.createdHint')}</p>
            </InlineAlert>
          )}

          {/* Filters */}
          <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="order-filters">
            <div className="relative w-full sm:w-60">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('proc.sel.search')} aria-label={t('proc.sel.search')} className="h-8 pl-8" data-testid="order-search" />
            </div>
            <div className="w-full sm:w-48">
              <MasterPicker masterKey="vendor" value={vendor} onChange={setVendor} ariaLabel={t('proc.filter.vendor')} placeholder={t('proc.filter.vendor')} compact testId="order-filter-vendor" />
            </div>
            <div className="w-full sm:w-48">
              <MasterPicker masterKey="item" value={item} onChange={setItem} ariaLabel={t('proc.filter.item')} placeholder={t('proc.filter.item')} compact testId="order-filter-item" />
            </div>
            <NativeSelect aria-label={t('proc.filter.location')} className="h-8 w-full sm:w-44" value={location} onChange={e => setLocation(e.target.value)} data-testid="order-filter-location">
              <option value="all">{t('topbar.allLocations')}</option>
              {(locations.data ?? []).map(n => <option key={n.id} value={n.id}>{`${'  '.repeat(Math.max(0, n.depth - 1))}${n.name}`}</option>)}
            </NativeSelect>
          </div>

          {/* Table */}
          {list.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : list.isError ? (
            <InlineAlert>{isApiError(list.error) ? list.error.message : t('order.loadFailed')}</InlineAlert>
          ) : rows.length === 0 ? (
            <EmptyState icon={<PackagePlus />} title={t('order.empty')} description={t('order.emptyHint')} />
          ) : (
            <div className="overflow-x-auto overflow-hidden rounded-lg border border-border" data-testid="order-page">
              <table className="w-full text-sm">
                <thead className="bg-subtle text-left text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">
                      <Checkbox
                        checked={allOn ? true : chosen.length ? 'indeterminate' : false}
                        onCheckedChange={c => rows.forEach(r => toggle(r, !!c))}
                        aria-label={t('order.selectAll')}
                        data-testid="order-select-all"
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">{t('proc.filter.item')}</th>
                    <th className="px-3 py-2 font-medium">VS No.</th>
                    <th className="px-3 py-2 font-medium">Indent No.</th>
                    <th className="px-3 py-2 font-medium">{t('proc.filter.location')}</th>
                    <th className="px-3 py-2 font-medium">{t('order.vendor')}</th>
                    <th className="px-3 py-2 font-medium">{t('order.rate')}</th>
                    <th className="px-3 py-2 font-medium">{t('order.qtyToOrder')}</th>
                    <th className="px-3 py-2 font-medium">Required Date</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(l => {
                    const pk = picks[l.sourceLineId];
                    const k = rowKey(l);
                    const prob = pk ? problemOf(l, pk) : null;
                    return (
                      <tr key={l.sourceLineId} className={cn('border-t border-border', pk && 'bg-accent-soft/40')} data-testid={`order-line-${k}`} data-source={l.sourceKind} data-pending={l.pendingOrder}>
                        <td className="px-3 py-2.5">
                          <Checkbox checked={!!pk} onCheckedChange={c => toggle(l, !!c)} data-testid={`order-pick-${k}`} aria-label={t('order.pickLine', { item: l.item?.name ?? '', number: l.indentNumber ?? '' })} />
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="font-medium">{l.item?.name ?? '—'}</p>
                          <p className="text-xs text-fg-subtle">{l.item?.code}</p>
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">
                          {l.sourceKind === 'selection' && l.selectionNumber ? (
                            <span className="font-medium">{l.selectionNumber}</span>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-fg-muted">
                          {l.indentNumber ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-fg-muted">{l.location.name}</td>
                        <td className="min-w-[10rem] px-3 py-2.5">
                          {pk ? (
                            <MasterPicker masterKey="vendor" value={pk.vendor} onChange={v => set(l.sourceLineId, { vendor: v })} ariaLabel={t('order.vendor')} placeholder={t('order.vendor')} compact testId={`order-vendor-${k}`} />
                          ) : l.vendor ? (
                            <span className="text-fg-muted">{l.vendor.name}</span>
                          ) : (l.quotes ?? []).length > 0 ? (
                            <div className="space-y-0.5">
                              {(l.quotes ?? []).slice(0, 2).map(q => (
                                <p key={q.quoteId} className={cn('text-xs', q.expired && 'line-through text-fg-subtle')}>
                                  <span className="font-medium">{q.vendor.name}</span>
                                  <span className="text-fg-muted"> · {fmtRate(q.quotedRate, currency)}</span>
                                </p>
                              ))}
                              {(l.quotes ?? []).length > 2 && <p className="text-xs text-fg-subtle">+{(l.quotes ?? []).length - 2} more</p>}
                            </div>
                          ) : (
                            <span className="text-fg-subtle text-xs">No quotes</span>
                          )}
                        </td>
                        <td className="min-w-[7rem] px-3 py-2.5">
                          {pk && l.sourceKind === 'indent' ? (
                            <div className="relative">
                              <Input inputMode="decimal" className="h-8 pr-10" value={pk.rate} onChange={e => set(l.sourceLineId, { rate: e.target.value })} aria-label={t('order.rate')} placeholder={t('order.rate')} data-testid={`order-rate-${k}`} />
                              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">{currency}</span>
                            </div>
                          ) : (
                            <span className="tabular-nums text-fg-muted">{l.rate ? fmtRate(l.rate, currency) : '—'}</span>
                          )}
                        </td>
                        <td className="min-w-[7rem] px-3 py-2.5">
                          {pk ? (
                            <div className="space-y-1">
                              <div className="relative">
                                <Input inputMode="decimal" className="h-8 pr-10" value={pk.qty} onChange={e => set(l.sourceLineId, { qty: e.target.value })} aria-label={t('order.qtyToOrder')} data-testid={`order-qty-${k}`} />
                                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">{l.uom}</span>
                              </div>
                              {prob && <p className="text-xs text-danger" data-testid={`order-error-${k}`}>{prob}</p>}
                            </div>
                          ) : (
                            <span className="tabular-nums text-fg-muted">{fmtQty(l.pendingOrder)} {l.uom ?? ''}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-fg-muted">
                          {l.requiredDate ? fmtDate(l.requiredDate) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {list.hasNextPage && (
                <div className="flex justify-center border-t border-border p-2">
                  <Button variant="ghost" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>{t('table.loadMore')}</Button>
                </div>
              )}
            </div>
          )}

          {/* Sticky action bar — replaces old sidebar Card */}
          {chosen.length > 0 && (
            <div className="sticky bottom-0 z-10 mt-4 flex items-center justify-between gap-4 rounded-lg border border-border bg-bg px-4 py-3 shadow-lg" data-testid="order-action-bar">
              <div className="text-sm text-fg-muted">
                <span className="font-semibold text-fg">{chosen.length}</span> line{chosen.length !== 1 ? 's' : ''} selected
                {groups.length > 0 && (
                  <span> &middot; <span className="font-semibold text-fg">{groups.length}</span> PO{groups.length !== 1 ? 's' : ''} will be created</span>
                )}
                {chosen.length > groups.reduce((s, g) => s + g.lines.length, 0) && (
                  <span className="ml-2 text-warning">({chosen.length - groups.reduce((s, g) => s + g.lines.length, 0)} need a vendor)</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {error && <p className="text-sm text-danger" role="alert" data-testid="order-error">{error}</p>}
                <Button variant="ghost" onClick={() => setPicks({})} disabled={saving}>Clear</Button>
                <Button onClick={openConfirm} loading={saving} data-testid="order-create">
                  {groups.length > 1 ? `Create ${groups.length} POs` : 'Create PO'}
                </Button>
              </div>
            </div>
          )}

          {/* Confirmation dialog */}
          <Dialog open={showConfirm} onOpenChange={open => { if (!saving) setShowConfirm(open); }}>
            <DialogContent
              size="lg"
              title="Review & confirm purchase orders"
              description="Check the details below and fill in header fields for each vendor before creating the POs."
              footer={
                <>
                  <Button variant="ghost" onClick={() => setShowConfirm(false)} disabled={saving}>Cancel</Button>
                  <Button onClick={() => void create()} loading={saving} data-testid="order-confirm-create">
                    {groups.length > 1 ? `Create ${groups.length} purchase orders` : 'Create purchase order'}
                  </Button>
                </>
              }
            >
              <div className="space-y-5">
                {groups.map(g => {
                  const vh = vendorHeaders[g.vendor.id] ?? { deliveryDate: '', paymentTerms: null, remarks: '' };
                  const vid = g.vendor.id;
                  return (
                    <div key={vid} className="rounded-lg border border-border">
                      <div className="flex items-center justify-between border-b border-border bg-subtle px-4 py-2">
                        <p className="font-semibold">{g.vendor.name}</p>
                        <p className="text-sm text-fg-muted tabular-nums">{g.lines.length} line{g.lines.length !== 1 ? 's' : ''} · {currency} {fmtRate(g.value, currency)}</p>
                      </div>
                      <ul className="divide-y divide-border">
                        {g.lines.map(c => (
                          <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 px-4 py-2.5 text-sm">
                            <span className="truncate font-medium">{c.l.item?.name ?? '—'} <span className="font-normal text-fg-muted">{c.l.item?.code}</span></span>
                            <span className="tabular-nums text-fg-muted">{fmtQty(c.pk.qty)} {c.l.uom ?? ''}</span>
                            <span className="tabular-nums">{fmtRate(num(c.pk.qty) * num(c.pk.rate), currency)}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="space-y-3 border-t border-border bg-subtle/40 px-4 py-3">
                        <p className="text-xs font-medium text-fg-muted uppercase tracking-wide">PO details for {g.vendor.name}</p>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label htmlFor={`del-date-${vid}`}>Expected delivery date</Label>
                            <Input id={`del-date-${vid}`} type="date" value={vh.deliveryDate} onChange={e => setVendorHeader(vid, { deliveryDate: e.target.value })} className="h-8" />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`pay-terms-${vid}`}>Payment terms</Label>
                            <MasterPicker masterKey="payment_terms" value={vh.paymentTerms} onChange={v => setVendorHeader(vid, { paymentTerms: v })} ariaLabel="Payment terms" placeholder="Select payment terms" id={`pay-terms-${vid}`} />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`remarks-${vid}`}>Remarks / notes</Label>
                          <Input id={`remarks-${vid}`} type="text" placeholder="Any notes for this vendor or internal reference…" value={vh.remarks} onChange={e => setVendorHeader(vid, { remarks: e.target.value })} className="h-8" />
                        </div>
                      </div>
                    </div>
                  );
                })}
                {error && <p className="text-sm text-danger" role="alert">{error}</p>}
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* ======== TAB 2: APPROVED INDENTS ======== */}
      {activeTab === 'approved-indents' && (
        <>
          {aiCreated && (
            <InlineAlert tone="success" className="mb-4" data-testid="ai-created">
              <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-4" aria-hidden />{t('order.createdTitle', { n: aiCreated.length })}</p>
              <ul className="mt-2 space-y-1">
                {aiCreated.map((d, i) => (
                  <li key={d.id}>
                    <Link href={`/docs/po/${d.id}`} className="font-medium underline-offset-2 hover:underline" data-testid={`ai-created-${i}`}>
                      {d.number ?? t('order.draftFor', { vendor: refName(d) })}
                    </Link>
                    <span className="text-fg-muted"> · {t('order.draftLines', { n: d.lines.length })}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm">{t('order.createdHint')}</p>
            </InlineAlert>
          )}

          {/* Filters */}
          <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="ai-filters">
            <div className="relative w-full sm:w-60">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input type="search" value={aiQ} onChange={e => setAiQ(e.target.value)} placeholder="Search indent / item…" aria-label="Search" className="h-8 pl-8" data-testid="ai-search" />
            </div>
            <div className="w-full sm:w-48">
              <MasterPicker masterKey="item" value={aiItem} onChange={setAiItem} ariaLabel={t('proc.filter.item')} placeholder={t('proc.filter.item')} compact testId="ai-filter-item" />
            </div>
            <NativeSelect aria-label={t('proc.filter.location')} className="h-8 w-full sm:w-44" value={aiLocation} onChange={e => setAiLocation(e.target.value)} data-testid="ai-filter-location">
              <option value="all">{t('topbar.allLocations')}</option>
              {(locations.data ?? []).map(n => <option key={n.id} value={n.id}>{`${'  '.repeat(Math.max(0, n.depth - 1))}${n.name}`}</option>)}
            </NativeSelect>
          </div>

          {/* Table */}
          {aiList.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : aiList.isError ? (
            <InlineAlert>{isApiError(aiList.error) ? aiList.error.message : 'Failed to load approved indents'}</InlineAlert>
          ) : aiRows.length === 0 ? (
            <EmptyState icon={<List />} title="No approved indents" description="All approved indent lines are either fully ordered or none exist yet." />
          ) : (
            <div className="overflow-x-auto overflow-hidden rounded-lg border border-border" data-testid="ai-table">
              <table className="w-full text-sm">
                <thead className="bg-subtle text-left text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">
                      <Checkbox
                        checked={aiAllOn ? true : aiChosen.length ? 'indeterminate' : false}
                        onCheckedChange={c => aiRows.forEach(r => aiToggle(r, !!c))}
                        aria-label="Select all"
                        data-testid="ai-select-all"
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">Indent No.</th>
                    <th className="px-3 py-2 font-medium">{t('proc.filter.item')}</th>
                    <th className="px-3 py-2 font-medium">{t('proc.filter.location')}</th>
                    <th className="px-3 py-2 font-medium">Approved Qty</th>
                    <th className="px-3 py-2 font-medium">Remaining Qty</th>
                    <th className="px-3 py-2 font-medium">POs Raised</th>
                    <th className="px-3 py-2 font-medium">Vendor Quotes</th>
                    <th className="px-3 py-2 font-medium">Vendor</th>
                    <th className="px-3 py-2 font-medium">Rate ({currency})</th>
                    <th className="px-3 py-2 font-medium">Qty to Order</th>
                  </tr>
                </thead>
                <tbody>
                  {aiRows.map(l => {
                    const pk = aiPicks[l.indentLineId];
                    const prob = pk ? aiProblemOf(l, pk) : null;
                    const lineKey = `${l.indentNumber ?? 'x'}-${l.indentLineId.slice(-4)}`;
                    return (
                      <tr key={l.indentLineId} className={cn('border-t border-border', pk && 'bg-accent-soft/40')} data-testid={`ai-line-${lineKey}`}>
                        <td className="px-3 py-2.5">
                          <Checkbox
                            checked={!!pk}
                            onCheckedChange={c => aiToggle(l, !!c)}
                            data-testid={`ai-pick-${lineKey}`}
                            aria-label={`Select ${l.item?.name ?? ''} from ${l.indentNumber ?? 'indent'}`}
                          />
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">
                          <Link href={`/docs/indent/${l.indentId}`} className="font-medium text-primary hover:underline underline-offset-2" target="_blank">
                            {l.indentNumber ?? '—'}
                          </Link>
                          {l.requiredDate && <p className="text-xs text-fg-subtle">{fmtDate(l.requiredDate)}</p>}
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="font-medium">{l.item?.name ?? '—'}</p>
                          <p className="text-xs text-fg-subtle">{l.item?.code}</p>
                        </td>
                        <td className="px-3 py-2.5 text-fg-muted">{l.location.name}</td>
                        <td className="px-3 py-2.5 tabular-nums text-fg-muted">{fmtQty(l.approvedQty)} {l.uom ?? ''}</td>
                        <td className="px-3 py-2.5 tabular-nums font-medium">
                          <span className={cn(dec.cmp(l.remainingQty, '0') <= 0 ? 'text-fg-subtle' : 'text-success')}>
                            {fmtQty(l.remainingQty)} {l.uom ?? ''}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">
                          {l.poCount > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium">
                              {l.poCount} PO{l.poCount !== 1 ? 's' : ''}
                            </span>
                          ) : (
                            <span className="text-fg-subtle text-xs">None</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 max-w-[14rem]">
                          {l.quotes.length === 0 ? (
                            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => openQuoteForm(l)}>
                              <Plus className="size-3" aria-hidden />Add quote
                            </Button>
                          ) : (
                            <div className="space-y-0.5">
                              <ul className="space-y-0.5">
                                {l.quotes.slice(0, 3).map(q => (
                                  <li key={q.quoteId} className={cn('text-xs', q.expired && 'text-fg-subtle line-through')}>
                                    <span className="font-medium">{q.vendor.name}</span>
                                    <span className="text-fg-muted"> · {fmtRate(q.quotedRate, currency)}</span>
                                    {q.expired && <span className="text-warning ml-1">(expired)</span>}
                                  </li>
                                ))}
                                {l.quotes.length > 3 && <li className="text-xs text-fg-subtle">+{l.quotes.length - 3} more</li>}
                              </ul>
                              <Button variant="ghost" size="sm" className="h-6 gap-1 px-1 text-xs text-fg-muted" onClick={() => openQuoteForm(l)}>
                                <Plus className="size-3" aria-hidden />Add
                              </Button>
                            </div>
                          )}
                        </td>
                        <td className="min-w-[10rem] px-3 py-2.5">
                          {pk ? (
                            <MasterPicker
                              masterKey="vendor"
                              value={pk.vendor}
                              onChange={v => aiSet(l.indentLineId, { vendor: v })}
                              ariaLabel={t('order.vendor')}
                              placeholder={t('order.vendor')}
                              compact
                              testId={`ai-vendor-${lineKey}`}
                            />
                          ) : (
                            <span className="text-xs text-fg-subtle">—</span>
                          )}
                        </td>
                        <td className="min-w-[7rem] px-3 py-2.5">
                          {pk ? (
                            <div className="relative">
                              <Input
                                inputMode="decimal"
                                className="h-8 pr-10"
                                value={pk.rate}
                                onChange={e => aiSet(l.indentLineId, { rate: e.target.value })}
                                aria-label={t('order.rate')}
                                placeholder="0.00"
                                data-testid={`ai-rate-${lineKey}`}
                              />
                              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">{currency}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-fg-subtle">—</span>
                          )}
                        </td>
                        <td className="min-w-[7rem] px-3 py-2.5">
                          {pk ? (
                            <div className="space-y-1">
                              <div className="relative">
                                <Input
                                  inputMode="decimal"
                                  className="h-8 pr-10"
                                  value={pk.qty}
                                  onChange={e => aiSet(l.indentLineId, { qty: e.target.value })}
                                  aria-label={t('order.qtyToOrder')}
                                  data-testid={`ai-qty-${lineKey}`}
                                />
                                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">{l.uom}</span>
                              </div>
                              {prob && <p className="text-xs text-danger" data-testid={`ai-error-${lineKey}`}>{prob}</p>}
                            </div>
                          ) : (
                            <span className="tabular-nums text-fg-muted text-xs">{fmtQty(l.remainingQty)} {l.uom ?? ''}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {aiList.hasNextPage && (
                <div className="flex justify-center border-t border-border p-2">
                  <Button variant="ghost" onClick={() => void aiList.fetchNextPage()} loading={aiList.isFetchingNextPage}>{t('table.loadMore')}</Button>
                </div>
              )}
            </div>
          )}

          {/* Sticky action bar */}
          {aiChosen.length > 0 && (
            <div className="sticky bottom-0 z-10 mt-4 flex items-center justify-between gap-4 rounded-lg border border-border bg-bg px-4 py-3 shadow-lg" data-testid="ai-action-bar">
              <div className="text-sm text-fg-muted">
                <span className="font-semibold text-fg">{aiChosen.length}</span> line{aiChosen.length !== 1 ? 's' : ''} selected
                {aiGroups.length > 0 && (
                  <span> &middot; <span className="font-semibold text-fg">{aiGroups.length}</span> PO{aiGroups.length !== 1 ? 's' : ''} will be created</span>
                )}
                {aiChosen.length > aiGroups.reduce((s, g) => s + g.lines.length, 0) && (
                  <span className="ml-2 text-warning">({aiChosen.length - aiGroups.reduce((s, g) => s + g.lines.length, 0)} need a vendor)</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {aiError && <p className="text-sm text-danger" role="alert" data-testid="ai-error">{aiError}</p>}
                <Button variant="ghost" onClick={() => setAiPicks({})} disabled={aiSaving}>Clear</Button>
                <Button onClick={aiOpenConfirm} loading={aiSaving} data-testid="ai-create">
                  {aiGroups.length > 1 ? `Create ${aiGroups.length} POs from Indents` : 'Create PO from Indent'}
                </Button>
              </div>
            </div>
          )}

          {/* Confirmation dialog */}
          <Dialog open={aiShowConfirm} onOpenChange={open => { if (!aiSaving) setAiShowConfirm(open); }}>
            <DialogContent
              size="lg"
              title="Review & confirm purchase orders (from indents)"
              description="These POs will be created directly from the approved indent lines. Fill in header fields for each vendor."
              footer={
                <>
                  <Button variant="ghost" onClick={() => setAiShowConfirm(false)} disabled={aiSaving}>Cancel</Button>
                  <Button onClick={() => void aiCreate()} loading={aiSaving} data-testid="ai-confirm-create">
                    {aiGroups.length > 1 ? `Create ${aiGroups.length} purchase orders` : 'Create purchase order'}
                  </Button>
                </>
              }
            >
              <div className="space-y-5">
                {aiGroups.map(g => {
                  const vh = aiVendorHeaders[g.vendor.id] ?? { deliveryDate: '', paymentTerms: null, remarks: '' };
                  const vid = g.vendor.id;
                  return (
                    <div key={vid} className="rounded-lg border border-border">
                      <div className="flex items-center justify-between border-b border-border bg-subtle px-4 py-2">
                        <p className="font-semibold">{g.vendor.name}</p>
                        <p className="text-sm text-fg-muted tabular-nums">{g.lines.length} line{g.lines.length !== 1 ? 's' : ''} · {currency} {fmtRate(g.value, currency)}</p>
                      </div>
                      <ul className="divide-y divide-border">
                        {g.lines.map(c => (
                          <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 px-4 py-2.5 text-sm">
                            <span className="truncate font-medium">
                              {c.l.item?.name ?? '—'} <span className="font-normal text-fg-muted">{c.l.item?.code}</span>
                              <span className="ml-2 text-xs text-fg-subtle">{c.l.indentNumber}</span>
                            </span>
                            <span className="tabular-nums text-fg-muted">{fmtQty(c.pk.qty)} {c.l.uom ?? ''}</span>
                            <span className="tabular-nums">{fmtRate(num(c.pk.qty) * num(c.pk.rate), currency)}</span>
                          </li>
                        ))}
                      </ul>
                      <div className="space-y-3 border-t border-border bg-subtle/40 px-4 py-3">
                        <p className="text-xs font-medium text-fg-muted uppercase tracking-wide">PO details for {g.vendor.name}</p>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label htmlFor={`ai-del-date-${vid}`}>Expected delivery date</Label>
                            <Input id={`ai-del-date-${vid}`} type="date" value={vh.deliveryDate} onChange={e => setAiVendorHeader(vid, { deliveryDate: e.target.value })} className="h-8" />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`ai-pay-terms-${vid}`}>Payment terms</Label>
                            <MasterPicker masterKey="payment_terms" value={vh.paymentTerms} onChange={v => setAiVendorHeader(vid, { paymentTerms: v })} ariaLabel="Payment terms" placeholder="Select payment terms" id={`ai-pay-terms-${vid}`} />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`ai-remarks-${vid}`}>Remarks / notes</Label>
                          <Input id={`ai-remarks-${vid}`} type="text" placeholder="Any notes for this vendor…" value={vh.remarks} onChange={e => setAiVendorHeader(vid, { remarks: e.target.value })} className="h-8" />
                        </div>
                      </div>
                    </div>
                  );
                })}
                {aiError && <p className="text-sm text-danger" role="alert">{aiError}</p>}
              </div>
            </DialogContent>
          </Dialog>

          {/* Add Vendor Quote dialog */}
          {quoteForm.open && quoteForm.ctx && (
            <QuoteFormDialog
              open
              onOpenChange={o => { if (!o) setQuoteForm({ open: false, ctx: null }); }}
              line={quoteForm.ctx}
              editing={null}
              vendorSuggestions={[]}
              currency={currency}
              onSaved={_rows => {
                setQuoteForm({ open: false, ctx: null });
                void qc.invalidateQueries({ queryKey: procKeys.approvedIndents(approvedIndentQuery) });
              }}
            />
          )}
        </>
      )}
    </PageBody>
  );
}

function refName(d: DocumentRow): string {
  const id = typeof d.values.party === 'string' ? d.values.party : '';
  return d.refs.party?.[id] ?? t('order.vendor');
}

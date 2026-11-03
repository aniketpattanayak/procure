'use client';
import type { DocumentRow, OrderableLine } from '@procure/schema';
import { Button, Card, Checkbox, cn, Dialog, DialogContent, EmptyState, Input, Label, NativeSelect, Skeleton, toast } from '@procure/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, PackagePlus, Search } from 'lucide-react';
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
import { procApi, procKeys, type PoFromLinesBody } from '../api';
import { fmtRate, num } from '../calc';
import { MasterPicker, type PickedOption } from '../components/master-picker';

interface Pick { qty: string; vendor: PickedOption | null; rate: string }
interface VendorHeader { deliveryDate: string; paymentTerms: PickedOption | null; remarks: string }

const rowKey = (l: OrderableLine) => `${l.indentNumber ?? 'x'}-${l.sourceLineId.slice(-4)}`;

/** Create purchase orders from approved selection lines (or indent lines when vendor selection is off). */
export function OrderPage() {
  const qc = useQueryClient();
  const me = useTenantPrincipal();
  const switcherLocation = useCurrentLocationId(me?.userId);
  const { currency } = useTenantLocale();
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
  // Per-vendor header values keyed by vendorId
  const [vendorHeaders, setVendorHeaders] = useState<Record<string, VendorHeader>>({});

  const setVendorHeader = (vendorId: string, patch: Partial<VendorHeader>) =>
    setVendorHeaders(prev => ({
      ...prev,
      [vendorId]: { deliveryDate: '', paymentTerms: null, remarks: '', ...prev[vendorId], ...patch },
    }));

  const locations = useQuery({ queryKey: locationKeys.mine, queryFn: () => locationsApi.tree({ scope: 'mine', view: 'active' }), staleTime: 5 * 60_000, retry: false });
  const query = { vendor: vendor?.id, item: item?.id, location: location === 'all' ? undefined : location, q: dq };
  const list = useInfiniteQuery({
    queryKey: procKeys.orderable(query),
    queryFn: ({ pageParam }) => procApi.orderableLines({ ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    retry: false,
  });
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap(p => p.data), [list.data]);
  const byId = useMemo(() => new Map(rows.map(r => [r.sourceLineId, r])), [rows]);

  const toggle = (l: OrderableLine, on: boolean) => setPicks(p => {
    const n = { ...p };
    if (on) n[l.sourceLineId] = { qty: l.pendingOrder, vendor: l.vendor, rate: l.rate ?? '' };
    else delete n[l.sourceLineId];
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

  const chosen = Object.entries(picks).map(([id, pk]) => ({ id, pk, l: byId.get(id) })).filter((x): x is { id: string; pk: Pick; l: OrderableLine } => !!x.l);
  const problems = chosen.map(c => ({ ...c, problem: problemOf(c.l, c.pk) }));
  const bad = problems.filter(p => p.problem);
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
      // Create one PO per vendor group, each with its own header values
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

  return (
    <PageBody>
      <PageHeader
        back={<Link href="/docs/po" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('order.back')}</Link>}
        title={t('order.title')}
        description={t('order.hint')}
      />

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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2" data-testid="order-filters">
            <div className="relative w-full sm:w-60">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('proc.sel.search')} aria-label={t('proc.sel.search')} className="h-8 pl-8" data-testid="order-search" />
            </div>
            <div className="w-full sm:w-48"><MasterPicker masterKey="vendor" value={vendor} onChange={setVendor} ariaLabel={t('proc.filter.vendor')} placeholder={t('proc.filter.vendor')} compact testId="order-filter-vendor" /></div>
            <div className="w-full sm:w-48"><MasterPicker masterKey="item" value={item} onChange={setItem} ariaLabel={t('proc.filter.item')} placeholder={t('proc.filter.item')} compact testId="order-filter-item" /></div>
            <NativeSelect aria-label={t('proc.filter.location')} className="h-8 w-full sm:w-44" value={location} onChange={e => setLocation(e.target.value)} data-testid="order-filter-location">
              <option value="all">{t('topbar.allLocations')}</option>
              {(locations.data ?? []).map(n => <option key={n.id} value={n.id}>{`${'  '.repeat(Math.max(0, n.depth - 1))}${n.name}`}</option>)}
            </NativeSelect>
          </div>

          {list.isLoading ? <Skeleton className="h-64 w-full" /> : list.isError ? (
            <InlineAlert>{isApiError(list.error) ? list.error.message : t('order.loadFailed')}</InlineAlert>
          ) : rows.length === 0 ? (
            <EmptyState icon={<PackagePlus />} title={t('order.empty')} description={t('order.emptyHint')} />
          ) : (
            <div className="overflow-x-auto overflow-hidden rounded-lg border border-border" data-testid="order-page">
              <table className="w-full text-sm">
                <thead className="bg-subtle text-left text-xs text-fg-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">
                      <Checkbox checked={allOn ? true : chosen.length ? 'indeterminate' : false} onCheckedChange={c => rows.forEach(r => toggle(r, !!c))} aria-label={t('order.selectAll')} data-testid="order-select-all" />
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
                          {pk && l.sourceKind === 'indent' ? (
                            <MasterPicker masterKey="vendor" value={pk.vendor} onChange={v => set(l.sourceLineId, { vendor: v })} ariaLabel={t('order.vendor')} placeholder={t('order.vendor')} compact testId={`order-vendor-${k}`} />
                          ) : (
                            <span className="text-fg-muted">{l.vendor?.name ?? '—'}</span>
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
                                <Input inputMode="decimal" className="h-8 pr-10" value={pk.qty} onChange={e => set(l.sourceLineId, { qty: e.target.value })} aria-label={t('order.qtyToOrder')} aria-invalid={!!prob && prob.includes(fmtQty(l.pendingOrder)) || undefined} data-testid={`order-qty-${k}`} />
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
              {list.hasNextPage && <div className="flex justify-center border-t border-border p-2"><Button variant="ghost" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>{t('table.loadMore')}</Button></div>}
            </div>
          )}
        </div>

        {/* Preview */}
        <Card className="h-fit space-y-3 p-4 lg:sticky lg:top-[calc(var(--topbar-h)+1rem)]" data-testid="order-preview" data-count={groups.length}>
          <h2 className="font-semibold">{t('order.preview')}</h2>
          {groups.length === 0 ? <p className="text-sm text-fg-muted">{t('order.previewEmpty')}</p> : (
            <>
              <p className="text-md" data-testid="order-preview-count">{t('order.willCreate', { n: groups.length })}</p>
              <ul className="space-y-2">
                {groups.map(g => (
                  <li key={g.vendor.id} className="rounded border border-border px-3 py-2" data-testid={`order-preview-vendor-${g.vendor.code ?? g.vendor.id}`}>
                    <p className="truncate font-medium">{g.vendor.name}</p>
                    <p className="text-sm text-fg-muted tabular-nums">{t('order.groupFacts', { n: g.lines.length, value: fmtRate(g.value, currency) })}</p>
                  </li>
                ))}
              </ul>
              {chosen.length > groups.reduce((s, g) => s + g.lines.length, 0) && <p className="text-sm text-warning">{t('order.needVendor', { n: chosen.length - groups.reduce((s, g) => s + g.lines.length, 0) })}</p>}
            </>
          )}
          {error && <p className="text-sm text-danger" role="alert" data-testid="order-error">{error}</p>}
          <Button className="w-full" disabled={!chosen.length} loading={saving} onClick={openConfirm} data-testid="order-create">
            {groups.length > 1 ? t('order.createN', { n: groups.length }) : t('order.create1')}
          </Button>
          <p className="text-xs text-fg-subtle">{t('order.draftNote')}</p>
        </Card>
      </div>

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
          {/* Vendor groups — each with its own header fields */}
          <div className="space-y-5">
            {groups.map(g => {
              const vh = vendorHeaders[g.vendor.id] ?? { deliveryDate: '', paymentTerms: null, remarks: '' };
              const vid = g.vendor.id;
              return (
                <div key={vid} className="rounded-lg border border-border">
                  {/* Vendor header bar */}
                  <div className="flex items-center justify-between border-b border-border bg-subtle px-4 py-2">
                    <p className="font-semibold">{g.vendor.name}</p>
                    <p className="text-sm text-fg-muted tabular-nums">{g.lines.length} line{g.lines.length !== 1 ? 's' : ''} · {currency} {fmtRate(g.value, currency)}</p>
                  </div>

                  {/* Lines */}
                  <ul className="divide-y divide-border">
                    {g.lines.map(c => (
                      <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 px-4 py-2.5 text-sm">
                        <span className="truncate font-medium">{c.l.item?.name ?? '—'} <span className="font-normal text-fg-muted">{c.l.item?.code}</span></span>
                        <span className="tabular-nums text-fg-muted">{fmtQty(c.pk.qty)} {c.l.uom ?? ''}</span>
                        <span className="tabular-nums">{fmtRate(num(c.pk.qty) * num(c.pk.rate), currency)}</span>
                      </li>
                    ))}
                  </ul>

                  {/* Per-vendor header fields */}
                  <div className="space-y-3 border-t border-border bg-subtle/40 px-4 py-3">
                    <p className="text-xs font-medium text-fg-muted uppercase tracking-wide">PO details for {g.vendor.name}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`del-date-${vid}`}>Expected delivery date</Label>
                        <Input
                          id={`del-date-${vid}`}
                          type="date"
                          value={vh.deliveryDate}
                          onChange={e => setVendorHeader(vid, { deliveryDate: e.target.value })}
                          className="h-8"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`pay-terms-${vid}`}>Payment terms</Label>
                        <MasterPicker
                          masterKey="payment_terms"
                          value={vh.paymentTerms}
                          onChange={v => setVendorHeader(vid, { paymentTerms: v })}
                          ariaLabel="Payment terms"
                          placeholder="Select payment terms"
                          id={`pay-terms-${vid}`}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`remarks-${vid}`}>Remarks / notes</Label>
                      <Input
                        id={`remarks-${vid}`}
                        type="text"
                        placeholder="Any notes for this vendor or internal reference…"
                        value={vh.remarks}
                        onChange={e => setVendorHeader(vid, { remarks: e.target.value })}
                        className="h-8"
                      />
                    </div>
                  </div>
                </div>
              );
            })}

            {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          </div>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}

function refName(d: DocumentRow): string {
  const id = typeof d.values.party === 'string' ? d.values.party : '';
  return d.refs.party?.[id] ?? t('order.vendor');
}

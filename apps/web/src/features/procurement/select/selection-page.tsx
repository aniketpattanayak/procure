'use client';
import type { ComparisonSheet, OrderableLine } from '@procure/schema';
import { Button, Checkbox, cn, EmptyState, Input, NativeSelect, Segmented, Skeleton, toast } from '@procure/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Award, ListChecks, Search, Split, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { locationKeys, locationsApi } from '@/features/locations/api';
import { docKeys } from '@/features/documents/api';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useCurrentLocationId } from '@/lib/location';
import { usePermissions } from '@/lib/permissions';
import { useTenantPrincipal } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { procApi, procKeys, type SelectionBody } from '../api';
import { fmtRate, num } from '../calc';
import { AllocationMeter, type MeterState } from '../components/allocation-meter';
import { MasterPicker, type PickedOption } from '../components/master-picker';
import { PERM, useProcurementFlow } from '../flow';

interface AllocRow { key: string; vendor: PickedOption | null; qty: string; rate: string; quoteId?: string }
interface Alloc { rows: AllocRow[]; reason: string }
interface Evaluation { total: string; over: string; state: MeterState; problems: string[]; overAllowed: string | null }
type Grouping = 'line' | 'item';

const rk = () => Math.random().toString(36).slice(2, 9);
const lineKey = (l: OrderableLine) => `${l.indentNumber ?? 'draft'}-${lineNoOf(l)}`;
/** OrderableLine carries no line number; the indent line id suffix keeps test ids stable when absent. */
function lineNoOf(l: OrderableLine & { lineNo?: number }) { return l.lineNo ?? l.indentLineId.slice(-4); }

export function SelectionPage() {
  const p = usePermissions();
  const flow = useProcurementFlow();
  const router = useRouter();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const me = useTenantPrincipal();
  const switcherLocation = useCurrentLocationId(me?.userId);
  const { currency } = useTenantLocale();

  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [item, setItem] = useState<PickedOption | null>(null);
  const [location, setLocation] = useState<string>(switcherLocation ?? 'all');
  const [grouping, setGrouping] = useState<Grouping>('item');
  const [allocs, setAllocs] = useState<Record<string, Alloc>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null);
  const focusLine = sp.get('line');

  const locations = useQuery({ queryKey: locationKeys.mine, queryFn: () => locationsApi.tree({ scope: 'mine', view: 'active' }), staleTime: 5 * 60_000, retry: false });
  const query = { item: item?.id, location: location === 'all' ? undefined : location, q: dq };
  const lines = useInfiniteQuery({
    queryKey: procKeys.selectable(query),
    queryFn: ({ pageParam }) => procApi.selectableLines({ ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    retry: false,
  });
  const rows = useMemo(() => (lines.data?.pages ?? []).flatMap(pg => pg.data), [lines.data]);
  const byId = useMemo(() => new Map(rows.map(r => [r.indentLineId, r])), [rows]);

  // Deep link from the comparison sheet: pick that line once it is loaded.
  useEffect(() => {
    if (focusLine && byId.has(focusLine) && !allocs[focusLine]) setAllocs(a => ({ ...a, [focusLine]: { rows: [{ key: rk(), vendor: null, qty: byId.get(focusLine)!.pendingOrder, rate: '' }], reason: '' } }));
  }, [focusLine, byId]);

  const toggle = (l: OrderableLine, on: boolean) => setAllocs(a => {
    const next = { ...a };
    if (on) next[l.indentLineId] = { rows: [{ key: rk(), vendor: null, qty: l.pendingOrder, rate: '' }], reason: '' };
    else delete next[l.indentLineId];
    return next;
  });
  const update = (id: string, fn: (a: Alloc) => Alloc) => setAllocs(a => (a[id] ? { ...a, [id]: fn(a[id]!) } : a));

  const canOver = p.has(PERM.overApprove);
  const evaluate = (l: OrderableLine, a: Alloc): Evaluation => {
    const total = dec.add(...a.rows.map(r => (isDecimal(r.qty) ? r.qty : '0')));
    const over = dec.max0(dec.sub(total, l.pendingOrder));
    const cap = flow.maxOverApprovalPct === null ? null : (num(l.pendingOrder) * flow.maxOverApprovalPct) / 100;
    let state: MeterState = dec.isZero(total) ? 'empty' : dec.cmp(total, l.pendingOrder) < 0 ? 'under' : dec.cmp(total, l.pendingOrder) === 0 ? 'exact' : 'over';
    const problems: string[] = [];
    if (state === 'over') {
      if (!canOver) { state = 'blocked'; problems.push(t('proc.sel.err.noOver')); }
      else if (cap !== null && num(over) > cap + 1e-9) { state = 'blocked'; problems.push(t('proc.sel.err.overCap', { pct: flow.maxOverApprovalPct ?? 0 })); }
      else if (!a.reason.trim()) problems.push(t('proc.sel.err.reason'));
    }
    a.rows.forEach((r, i) => {
      if (!r.vendor) problems.push(t('proc.sel.err.vendor', { n: i + 1 }));
      if (!isDecimal(r.qty) || !dec.gt0(r.qty)) problems.push(t('proc.sel.err.qty', { n: i + 1 }));
      if (!isDecimal(r.rate)) problems.push(t('proc.sel.err.rate', { n: i + 1 }));
    });
    const dup = a.rows.map(r => r.vendor?.id).filter(Boolean);
    if (new Set(dup).size !== dup.length) problems.push(t('proc.sel.err.dupVendor'));
    return { total, over, state, problems, overAllowed: cap === null || !canOver ? null : String(cap) };
  };

  const picked = Object.entries(allocs).map(([id, a]) => ({ id, a, l: byId.get(id) })).filter((x): x is { id: string; a: Alloc; l: OrderableLine } => !!x.l);
  const results = picked.map(x => ({ ...x, ev: evaluate(x.l, x.a) }));
  const blocking = results.filter(r => r.ev.problems.length > 0);
  const vendorsCount = new Set(results.flatMap(r => r.a.rows.map(x => x.vendor?.id).filter(Boolean))).size;
  const value = results.reduce((s, r) => s + r.a.rows.reduce((x, row) => x + num(row.qty) * num(row.rate), 0), 0);

  const submit = async (mode: 'draft' | 'submit') => {
    setError(null);
    if (!results.length) return;
    if (blocking.length) { setError(t('proc.sel.err.fix', { n: blocking.length })); return; }
    const body: SelectionBody = {
      values: {},
      submit: mode === 'submit',
      lines: results.flatMap(r => r.a.rows.map(row => ({
        indentLineId: r.id, vendorId: row.vendor!.id, qty: dec.norm(row.qty), rate: row.rate.trim(),
        ...(row.quoteId ? { quoteId: row.quoteId } : {}),
        ...(dec.gt0(r.ev.over) && r.a.reason.trim() ? { reason: r.a.reason.trim() } : {}),
      }))),
    };
    setSaving(mode);
    try {
      const doc = await procApi.createSelection(body);
      void qc.invalidateQueries({ queryKey: procKeys.all });
      void qc.invalidateQueries({ queryKey: docKeys.all('vendor_selection') });
      void qc.invalidateQueries({ queryKey: docKeys.all('indent') });
      toast.success(mode === 'submit' ? t('proc.sel.submitted', { number: doc.number ?? '' }) : t('proc.sel.saved'));
      router.push(`/docs/vendor_selection/${doc.id}${mode === 'submit' ? '?submitted=1' : ''}`);
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
      setSaving(null);
    }
  };

  // Grouping by item keeps lines of the same material together (one comparison, one decision).
  const groups = useMemo(() => {
    if (grouping === 'line') return [{ key: 'all', title: null as string | null, code: null as string | null, rows }];
    const m = new Map<string, { key: string; title: string | null; code: string | null; rows: OrderableLine[] }>();
    for (const r of rows) {
      const k = r.item?.id ?? 'none';
      const g = m.get(k) ?? { key: k, title: r.item?.name ?? t('proc.sel.noItem'), code: r.item?.code ?? null, rows: [] };
      g.rows.push(r);
      m.set(k, g);
    }
    return [...m.values()];
  }, [rows, grouping]);

  if (!flow.selectionEnabled) {
    return <PageBody><EmptyState icon={<ListChecks />} title={t('proc.sel.off')} description={t('proc.sel.offHint')} action={<Button asChild variant="secondary"><Link href="/procurement/order">{t('nav.procurement.order')}</Link></Button>} /></PageBody>;
  }

  return (
    <PageBody className="pb-32">
      <PageHeader
        back={<Link href="/docs/vendor_selection" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('proc.sel.back')}</Link>}
        title={t('proc.sel.title')}
        description={t('proc.sel.hint')}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="select-filters">
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('proc.sel.search')} aria-label={t('proc.sel.search')} className="h-8 pl-8" data-testid="select-search" />
        </div>
        <div className="w-full sm:w-56"><MasterPicker masterKey="item" value={item} onChange={setItem} ariaLabel={t('proc.filter.item')} placeholder={t('proc.filter.item')} compact testId="select-filter-item" /></div>
        <NativeSelect aria-label={t('proc.filter.location')} className="h-8 w-full sm:w-48" value={location} onChange={e => setLocation(e.target.value)} data-testid="select-filter-location">
          <option value="all">{t('topbar.allLocations')}</option>
          {(locations.data ?? []).map(n => <option key={n.id} value={n.id}>{`${'  '.repeat(Math.max(0, n.depth - 1))}${n.name}`}</option>)}
        </NativeSelect>
        <Segmented<Grouping> className="sm:ml-auto" label={t('proc.sel.groupLabel')} value={grouping} onChange={setGrouping} size="md" data-testid="select-group"
          options={[{ value: 'item', label: t('proc.sel.byItem') }, { value: 'line', label: t('proc.sel.byLine') }]} />
      </div>

      {lines.isLoading ? <Skeleton className="h-64 w-full" /> : lines.isError ? (
        <InlineAlert>{isApiError(lines.error) ? lines.error.message : t('proc.sel.loadFailed')}</InlineAlert>
      ) : rows.length === 0 ? (
        <EmptyState icon={<ListChecks />} title={t('proc.sel.empty')} description={t('proc.sel.emptyHint')} data-testid="select-empty" />
      ) : (
        <div className="space-y-5" data-testid="select-page">
          {groups.map(g => (
            <section key={g.key} aria-label={g.title ?? undefined} data-testid={g.code ? `select-group-item-${g.code}` : undefined}>
              {g.title && (
                <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="font-semibold">{g.title}</h2>
                  {g.code && <span className="text-sm text-fg-subtle">{g.code}</span>}
                  <span className="text-sm text-fg-muted tabular-nums">{t('proc.sel.groupFacts', { n: g.rows.length, qty: fmtQty(dec.add(...g.rows.map(r => r.pendingOrder))), uom: g.rows[0]?.uom ?? '' })}</span>
                </div>
              )}
              <ul className="space-y-2">
                {g.rows.map(l => {
                  const a = allocs[l.indentLineId];
                  const ev = a ? evaluate(l, a) : null;
                  return (
                    <SelectableLineRow key={l.indentLineId} line={l} alloc={a ?? null} ev={ev} currency={currency} showItem={grouping === 'line'}
                      onToggle={on => toggle(l, on)} onChange={fn => update(l.indentLineId, fn)} />
                  );
                })}
              </ul>
            </section>
          ))}
          {lines.hasNextPage && <div className="flex justify-center"><Button variant="secondary" onClick={() => void lines.fetchNextPage()} loading={lines.isFetchingNextPage}>{t('table.loadMore')}</Button></div>}
        </div>
      )}

      {/* Summary bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 backdrop-blur lg:left-sidebar" data-testid="select-summary" data-lines={results.length}>
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:px-6">
          <div className="min-w-0 flex-1">
            {results.length === 0 ? <p className="text-sm text-fg-muted">{t('proc.sel.pickHint')}</p> : (
              <p className="text-sm tabular-nums">
                <span className="font-medium">{t('proc.sel.summary', { lines: results.length, vendors: vendorsCount })}</span>
                <span className="text-fg-muted"> · {fmtRate(value, currency)}</span>
                {blocking.length > 0 && <span className="ml-2 font-medium text-danger">{t('proc.sel.needsFix', { n: blocking.length })}</span>}
              </p>
            )}
            {error && <p className="text-sm text-danger" role="alert" data-testid="select-error">{error}</p>}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!results.length || !!saving} loading={saving === 'draft'} onClick={() => submit('draft')} data-testid="select-save">{t('proc.sel.saveDraft')}</Button>
            {p.has(PERM.selectionSubmit) && (
              <Button disabled={!results.length || !!saving} loading={saving === 'submit'} onClick={() => submit('submit')} data-testid="select-submit">{t('proc.sel.submit')}</Button>
            )}
          </div>
        </div>
      </div>
    </PageBody>
  );
}

function SelectableLineRow({ line: l, alloc, ev, currency, showItem, onToggle, onChange }: {
  line: OrderableLine;
  alloc: Alloc | null;
  ev: Evaluation | null;
  currency: string;
  showItem: boolean;
  onToggle: (on: boolean) => void;
  onChange: (fn: (a: Alloc) => Alloc) => void;
}) {
  const k = lineKey(l);
  const uom = l.uom ?? '';
  const sheet = useQuery({
    queryKey: procKeys.lineComparison(l.indentLineId, l.pendingOrder),
    queryFn: () => procApi.lineComparison(l.indentLineId, l.pendingOrder),
    enabled: !!alloc,
    staleTime: 60_000,
    retry: false,
  });
  const quoted = sheet.data?.vendors ?? [];
  const best = quoted.find(v => v.isBest) ?? null;
  const vendorRate = (vid: string | undefined) => quoted.find(v => v.vendor.id === vid);

  // Pre-fill the first empty row from the best quote as soon as the sheet loads.
  useEffect(() => {
    if (!alloc || !best) return;
    const first = alloc.rows[0];
    if (alloc.rows.length === 1 && first && !first.vendor) suggest(sheet.data!);
  }, [best?.vendor.id, !!alloc]);

  function suggest(s: ComparisonSheet) {
    const b = s.vendors.find(v => v.isBest) ?? s.vendors[0];
    if (!b) return;
    onChange(a => ({ ...a, rows: [{ key: rk(), vendor: b.vendor, qty: l.pendingOrder, rate: b.effectiveRate, quoteId: b.quoteId }] }));
  }
  const setRow = (i: number, patch: Partial<AllocRow>) => onChange(a => ({ ...a, rows: a.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const split = () => onChange(a => {
    const total = dec.add(...a.rows.map(r => (isDecimal(r.qty) ? r.qty : '0')));
    const left = dec.max0(dec.sub(l.pendingOrder, total));
    const used = new Set(a.rows.map(r => r.vendor?.id));
    const nextV = quoted.filter(v => !used.has(v.vendor.id)).sort((x, y) => num(x.landedCostPerUnit) - num(y.landedCostPerUnit))[0];
    return { ...a, rows: [...a.rows, { key: rk(), vendor: nextV?.vendor ?? null, qty: dec.gt0(left) ? left : '', rate: nextV?.effectiveRate ?? '', quoteId: nextV?.quoteId }] };
  });

  const on = !!alloc;
  return (
    <li className={cn('rounded-lg border bg-surface transition-colors', on ? 'border-accent/50 shadow-sm' : 'border-border')} data-testid={`select-line-${k}`} data-selectable={l.pendingOrder}>
      <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
        <Checkbox className="mt-1" checked={on} onCheckedChange={c => onToggle(!!c)} data-testid={`select-pick-${k}`} aria-label={t('proc.sel.pickLine', { number: l.indentNumber ?? '', item: l.item?.name ?? '' })} />
        <span className="grid min-w-0 flex-1 gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
          <span className="min-w-0">
            <span className="block truncate font-medium">{showItem && l.item ? <>{l.item.name} <span className="font-normal text-fg-subtle">{l.item.code}</span></> : (l.indentNumber ?? t('docs.draft'))}</span>
            <span className="block truncate text-sm text-fg-muted">{showItem ? l.indentNumber : null}{showItem ? ' · ' : ''}{l.location.name}{l.requiredDate ? ` · ${t('proc.quotes.needBy', { date: fmtDate(l.requiredDate) })}` : ''}</span>
          </span>
          <span className="text-sm text-fg-muted sm:self-center">{on && best ? <span className="inline-flex items-center gap-1 text-success"><Award className="size-3.5" aria-hidden />{t('proc.sel.bestShort', { vendor: best.vendor.name, rate: fmtRate(best.effectiveRate, currency) })}</span> : on && sheet.isSuccess && !quoted.length ? t('proc.sel.noQuotes') : null}</span>
          <span className="text-right font-semibold tabular-nums sm:self-center" data-testid={`select-qty-avail-${k}`}>{fmtQty(l.pendingOrder)} <span className="text-sm font-normal text-fg-muted">{uom}</span></span>
        </span>
      </label>

      {alloc && ev && (
        <div className="space-y-3 border-t border-border px-3 pb-3 pt-3 sm:pl-10" data-testid={`select-alloc-${k}`}>
          <AllocationMeter parts={alloc.rows.map(r => ({ label: r.vendor?.name ?? '—', qty: isDecimal(r.qty) ? r.qty : '0' }))} available={l.pendingOrder} uom={uom} state={ev.state} overAllowed={ev.overAllowed} testId={`select-meter-${k}`} />
          <ol className="space-y-2">
            {alloc.rows.map((r, i) => {
              const vq = vendorRate(r.vendor?.id);
              return (
                <li key={r.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:items-center" data-testid={`select-alloc-${k}-row-${i}`}>
                  <div className="col-span-2 sm:col-span-1">
                    <MasterPicker masterKey="vendor" value={r.vendor} ariaLabel={t('proc.sel.vendorN', { n: i + 1 })} compact testId={`select-vendor-${k}-${i}`}
                      suggestions={quoted.map(v => ({ ...v.vendor, hint: t('proc.sel.quotedHint', { rate: fmtRate(v.effectiveRate, currency) }) + (v.isBest ? ` · ${t('proc.cmp.best')}` : '') }))}
                      onChange={v => { const q2 = quoted.find(x => x.vendor.id === v?.id); setRow(i, { vendor: v, rate: q2 ? q2.effectiveRate : r.rate, quoteId: q2?.quoteId }); }} />
                  </div>
                  <div className="relative">
                    <Input inputMode="decimal" className="h-8 pr-10" value={r.qty} onChange={e => setRow(i, { qty: e.target.value })} aria-label={t('proc.sel.qtyN', { n: i + 1 })} data-testid={`select-qty-${k}-${i}`}
                      aria-invalid={!isDecimal(r.qty) || ev.state === 'blocked' || undefined} />
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">{uom}</span>
                  </div>
                  <div className="relative">
                    <Input inputMode="decimal" className="h-8 pr-10" value={r.rate} onChange={e => setRow(i, { rate: e.target.value, quoteId: vq && vq.effectiveRate === e.target.value ? vq.quoteId : r.quoteId })} aria-label={t('proc.sel.rateN', { n: i + 1 })} data-testid={`select-rate-${k}-${i}`} />
                    <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">{currency}</span>
                  </div>
                  <div className="col-span-2 flex items-center justify-between gap-2 sm:col-span-1 sm:justify-end">
                    <span className="text-sm text-fg-muted tabular-nums sm:hidden">{fmtRate(num(r.qty) * num(r.rate), currency)}</span>
                    <Button variant="ghost" size="icon-sm" disabled={alloc.rows.length === 1} onClick={() => onChange(a => ({ ...a, rows: a.rows.filter((_, j) => j !== i) }))} aria-label={t('proc.sel.removeRow', { n: i + 1 })} data-testid={`select-remove-${k}-${i}`}><Trash2 aria-hidden /></Button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={split} data-testid={`select-split-${k}`}><Split aria-hidden />{t('proc.sel.split')}</Button>
            {sheet.data && quoted.length > 0 && <Button variant="ghost" size="sm" onClick={() => suggest(sheet.data!)} data-testid={`select-suggest-${k}`}><Sparkles aria-hidden />{t('proc.sel.suggest')}</Button>}
          </div>
          {(ev.state === 'over' || ev.state === 'blocked') && (
            <div className="space-y-1">
              <label htmlFor={`reason-${k}`} className="text-sm font-medium">{t('proc.sel.overReason')}</label>
              <Input id={`reason-${k}`} value={alloc.reason} onChange={e => onChange(a => ({ ...a, reason: e.target.value }))} maxLength={500} placeholder={t('proc.sel.overReasonHint')} data-testid={`select-reason-${k}`} disabled={ev.state === 'blocked'} />
            </div>
          )}
          {ev.problems.length > 0 && (
            <ul className="space-y-0.5 text-sm text-danger" data-testid={`select-problems-${k}`}>{ev.problems.map(pr => <li key={pr}>{pr}</li>)}</ul>
          )}
        </div>
      )}
    </li>
  );
}

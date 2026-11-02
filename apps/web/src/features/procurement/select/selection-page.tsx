'use client';
import type { ComparisonSheet, OrderableLine } from '@procure/schema';
import { Button, Checkbox, cn, Dialog, DialogContent, EmptyState, Input, NativeSelect, Segmented, Skeleton, toast } from '@procure/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Award, ListChecks, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
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
  /** Create / change / clear one line's allocation; a line with no rows left is un-picked. */
  const setAlloc = (id: string, fn: (a: Alloc | null) => Alloc | null) => setAllocs(all => {
    const nx = fn(all[id] ?? null);
    const n = { ...all };
    if (nx && nx.rows.length) n[id] = nx; else delete n[id];
    return n;
  });
  const [confirmOpen, setConfirmOpen] = useState(false);

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
                  <span className="text-sm text-fg-muted tabular-nums">{t('proc.sel.groupFacts', { n: g.rows.length, qty: fmtQty(dec.add(...g.rows.map(r => r.pendingOrder))), uom: g.rows[0]?.uom ?? '' })}</span>
                </div>
              )}
              <ul className="space-y-2">
                {g.rows.map(l => {
                  const a = allocs[l.indentLineId];
                  const ev = a ? evaluate(l, a) : null;
                  return (
                    <SelectableLineRow key={l.indentLineId} line={l} alloc={a ?? null} ev={ev} currency={currency} showItem={grouping === 'line'}
                      onToggle={on => toggle(l, on)} onSet={fn => setAlloc(l.indentLineId, fn)} />
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
              <Button disabled={!results.length || !!saving} loading={saving === 'submit'} data-testid="select-submit"
                onClick={() => { setError(null); if (blocking.length) { setError(t('proc.sel.err.fix', { n: blocking.length })); return; } setConfirmOpen(true); }}>{t('proc.sel.submit')}</Button>
            )}
          </div>
        </div>
      </div>
      {confirmOpen && (
        <SelectionConfirmDialog results={results} currency={currency} busy={saving === 'submit'}
          onCancel={() => setConfirmOpen(false)} onConfirm={() => { void submit('submit').finally(() => setConfirmOpen(false)); }} />
      )}
    </PageBody>
  );
}

function SelectableLineRow({ line: l, alloc, ev, currency, showItem, onToggle, onSet }: {
  line: OrderableLine;
  alloc: Alloc | null;
  ev: Evaluation | null;
  currency: string;
  showItem: boolean;
  onToggle: (on: boolean) => void;
  /** Create / change / clear this line's allocation (null or no rows = not picked). */
  onSet: (fn: (a: Alloc | null) => Alloc | null) => void;
}) {
  const k = lineKey(l);
  const uom = l.uom ?? '';
  // Quotes are always shown under the line, so load them up front.
  const sheet = useQuery({
    queryKey: procKeys.lineComparison(l.indentLineId, l.pendingOrder),
    queryFn: () => procApi.lineComparison(l.indentLineId, l.pendingOrder),
    staleTime: 60_000,
    retry: false,
  });
  const quoted = sheet.data?.vendors ?? [];
  const best = quoted.find(v => v.isBest) ?? null;
  const quotedIds = new Set(quoted.map(v => v.vendor.id));
  const vendorRate = (vid: string | undefined) => quoted.find(v => v.vendor.id === vid);
  const onChange = (fn: (a: Alloc) => Alloc) => onSet(a => (a ? fn(a) : a));
  // Ticking a line pre-fills the best quote for the whole qty once the sheet is loaded.
  useEffect(() => {
    if (!alloc || !best) return;
    const first = alloc.rows[0];
    if (alloc.rows.length === 1 && first && !first.vendor && !first.rate) suggest(sheet.data!);
  }, [best?.vendor.id, !!alloc]);
  function suggest(s: ComparisonSheet) {
    const b = s.vendors.find(v => v.isBest) ?? s.vendors[0];
    if (!b) return;
    onSet(a => ({ reason: a?.reason ?? '', rows: [{ key: rk(), vendor: b.vendor, qty: l.pendingOrder, rate: b.effectiveRate, quoteId: b.quoteId }] }));
  }
  const setRow = (i: number, patch: Partial<AllocRow>) => onChange(a => ({ ...a, rows: a.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const isPlaceholder = (r: AllocRow) => !r.vendor && !r.rate.trim();
  const qtyFor = (vid: string) => alloc?.rows.find(r => r.vendor?.id === vid)?.qty ?? '';
  /** Typing a qty against a quoted vendor adds / updates / removes that vendor's split (rate from the quote). */
  const setVendorQty = (v: ComparisonSheet['vendors'][number], raw: string) => {
    const qv = raw.replace(/[^\d.]/g, '');
    onSet(a => {
      const rows = (a?.rows ?? []).filter(r => !isPlaceholder(r));
      const i = rows.findIndex(r => r.vendor?.id === v.vendor.id);
      let next = rows;
      if (!qv) next = i >= 0 ? rows.filter((_, j) => j !== i) : rows;
      else if (i >= 0) next = rows.map((r, j) => (j === i ? { ...r, qty: qv } : r));
      else next = [...rows, { key: rk(), vendor: v.vendor, qty: qv, rate: v.effectiveRate, quoteId: v.quoteId }];
      return { reason: a?.reason ?? '', rows: next };
    });
  };
  const addVendor = () => onSet(a => ({ reason: a?.reason ?? '', rows: [...(a?.rows ?? []).filter(r => !isPlaceholder(r)), { key: rk(), vendor: null, qty: '', rate: '' }] }));
  const removeRow = (i: number) => onSet(a => (a ? { ...a, rows: a.rows.filter((_, j) => j !== i) } : a));
  const custom = (alloc?.rows ?? []).map((r, i) => ({ r, i })).filter(({ r }) => !r.vendor || !quotedIds.has(r.vendor.id));
  const history = sheet.data?.history ?? [];
  const on = !!alloc;
  const cell = 'px-2 py-1.5 text-right tabular-nums';
  return (
    <li className={cn('rounded-lg border bg-surface transition-colors', on ? 'border-accent/50 shadow-sm' : 'border-border')} data-testid={`select-line-${k}`} data-selectable={l.pendingOrder}>
      <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
        <Checkbox className="mt-1" checked={on} onCheckedChange={c => onToggle(!!c)} data-testid={`select-pick-${k}`} aria-label={t('proc.sel.pickLine', { number: l.indentNumber ?? '', item: l.item?.name ?? '' })} />
        <span className="grid min-w-0 flex-1 gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
          <span className="min-w-0">
            <span className="block truncate font-medium">{showItem && l.item ? l.item.name : (l.indentNumber ?? t('docs.draft'))}</span>
            <span className="block truncate text-sm text-fg-muted">{showItem ? l.indentNumber : null}{showItem ? ' · ' : ''}{l.location.name}{l.requiredDate ? ` · ${t('proc.quotes.needBy', { date: fmtDate(l.requiredDate) })}` : ''}</span>
          </span>
          <span className="text-sm text-fg-muted sm:self-center">
            {best ? <span className="inline-flex items-center gap-1 text-success"><Award className="size-3.5" aria-hidden />{t('proc.sel.bestShort', { vendor: best.vendor.name, rate: fmtRate(best.effectiveRate, currency) })}</span>
              : sheet.isSuccess && !quoted.length ? t('proc.sel.noQuotes') : null}
          </span>
          <span className="text-right sm:self-center">
            <span className="block text-xs text-fg-muted">{t('proc.sel.q.toSelect')}</span>
            <span className="font-semibold tabular-nums" data-testid={`select-qty-avail-${k}`}>{fmtQty(l.pendingOrder)} <span className="text-sm font-normal text-fg-muted">{uom}</span></span>
          </span>
        </span>
      </label>

      <div className="space-y-3 border-t border-border px-3 pb-3 pt-3 sm:pl-10" data-testid={`select-alloc-${k}`}>
        {sheet.isLoading ? <Skeleton className="h-16 w-full" /> : quoted.length > 0 ? (
          <div className="overflow-x-auto rounded border border-border" data-testid={`select-quotes-${k}`}>
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-subtle text-xs text-fg-muted">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">{t('proc.sel.q.vendor')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('proc.sel.q.rate')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('proc.sel.q.freight')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('proc.sel.q.tax')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('proc.sel.q.landed')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('proc.sel.q.total')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('proc.sel.q.lead')}</th>
                  <th className="px-2 py-1.5 text-right font-medium">{t('proc.sel.q.moq')}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t('proc.sel.q.valid')}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{t('proc.sel.q.terms')}</th>
                  <th className="w-32 px-2 py-1.5 text-right font-medium">{t('proc.sel.q.qty', { uom })}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {quoted.map(v => {
                  const qv = qtyFor(v.vendor.id);
                  return (
                    <tr key={v.quoteId} className={cn(qv ? 'bg-accent-soft/50' : v.isBest ? 'bg-success-soft/30' : '')} data-testid={`select-quote-${k}-${v.vendor.code}`}>
                      <td className="px-2 py-1.5">
                        <span className="font-medium">{v.vendor.name}</span>
                        {v.isBest && <span className="ml-1.5 inline-flex items-center gap-0.5 rounded bg-success-soft px-1 text-xs font-medium text-success"><Award className="size-3" aria-hidden />{t('proc.sel.q.best')}</span>}
                        {v.expired && <span className="ml-1.5 rounded bg-danger-soft px-1 text-xs text-danger">{t('proc.sel.q.expired')}</span>}
                        {v.warnings.includes('below_moq') && <span className="ml-1.5 rounded bg-warning-soft px-1 text-xs text-warning">{t('proc.sel.q.belowMoq')}</span>}
                      </td>
                      <td className={cell}>{fmtRate(v.effectiveRate, currency)}</td>
                      <td className={cell}>{fmtRate(v.freightPerUnit, currency)}</td>
                      <td className={cell}>{v.taxPct}%</td>
                      <td className={cn(cell, 'font-semibold')}>{fmtRate(v.landedCostPerUnit, currency)}</td>
                      <td className={cell}>{fmtRate(v.landedTotal, currency)}</td>
                      <td className={cell}>{v.leadTimeDays === null ? '—' : t('proc.sel.q.leadDays', { n: v.leadTimeDays })}</td>
                      <td className={cell}>{v.moq ? fmtQty(v.moq) : '—'}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{v.validUntil ? fmtDate(v.validUntil) : '—'}</td>
                      <td className="px-2 py-1.5">{v.paymentTerms ?? '—'}</td>
                      <td className="px-2 py-1">
                        <Input inputMode="decimal" placeholder="0" value={qv} onChange={e => setVendorQty(v, e.target.value)}
                          className="h-8 text-right tabular-nums" aria-label={t('proc.sel.q.qtyFor', { vendor: v.vendor.name })} data-testid={`select-qq-${k}-${v.vendor.code}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-fg-muted" data-testid={`select-noquotes-${k}`}>{t('proc.sel.q.none')}</p>
        )}

        {custom.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{t('proc.sel.q.other')}</p>
            <ol className="space-y-2">
              {custom.map(({ r, i }) => {
                const vq = vendorRate(r.vendor?.id);
                return (
                  <li key={r.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:items-center" data-testid={`select-alloc-${k}-row-${i}`}>
                    <div className="col-span-2 sm:col-span-1">
                      <MasterPicker masterKey="vendor" value={r.vendor} ariaLabel={t('proc.sel.vendorN', { n: i + 1 })} compact testId={`select-vendor-${k}-${i}`}
                        onChange={v => { const q2 = quoted.find(x => x.vendor.id === v?.id); setRow(i, { vendor: v, rate: q2 ? q2.effectiveRate : r.rate, quoteId: q2?.quoteId }); }} />
                    </div>
                    <div className="relative">
                      <Input inputMode="decimal" className="h-8 pr-10" placeholder={t('proc.sel.q.qtyPh')} value={r.qty} onChange={e => setRow(i, { qty: e.target.value })} aria-label={t('proc.sel.qtyN', { n: i + 1 })} data-testid={`select-qty-${k}-${i}`}
                        aria-invalid={(r.qty !== '' && !isDecimal(r.qty)) || undefined} />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">{uom}</span>
                    </div>
                    <div className="relative">
                      <Input inputMode="decimal" className="h-8 pr-10" placeholder={t('proc.sel.q.ratePh')} value={r.rate} onChange={e => setRow(i, { rate: e.target.value, quoteId: vq && vq.effectiveRate === e.target.value ? vq.quoteId : r.quoteId })} aria-label={t('proc.sel.rateN', { n: i + 1 })} data-testid={`select-rate-${k}-${i}`} />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">{currency}</span>
                    </div>
                    <div className="col-span-2 flex items-center justify-between gap-2 sm:col-span-1 sm:justify-end">
                      <span className="text-sm text-fg-muted tabular-nums sm:hidden">{fmtRate(num(r.qty) * num(r.rate), currency)}</span>
                      <Button variant="ghost" size="icon-sm" onClick={() => removeRow(i)} aria-label={t('proc.sel.removeRow', { n: i + 1 })} data-testid={`select-remove-${k}-${i}`}><Trash2 aria-hidden /></Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={addVendor} data-testid={`select-add-vendor-${k}`}><Plus aria-hidden />{t('proc.sel.q.addVendor')}</Button>
          {sheet.data && quoted.length > 0 && <Button variant="ghost" size="sm" onClick={() => suggest(sheet.data!)} data-testid={`select-suggest-${k}`}><Sparkles aria-hidden />{t('proc.sel.suggest')}</Button>}
        </div>

        {alloc && ev && (
          <>
            <AllocationMeter parts={alloc.rows.map(r => ({ label: r.vendor?.name ?? '—', qty: isDecimal(r.qty) ? r.qty : '0' }))} available={l.pendingOrder} uom={uom} state={ev.state} overAllowed={ev.overAllowed} testId={`select-meter-${k}`} />
            {(ev.state === 'over' || ev.state === 'blocked') && (
              <div className="space-y-1">
                <label htmlFor={`reason-${k}`} className="text-sm font-medium">{t('proc.sel.overReason')}</label>
                <Input id={`reason-${k}`} value={alloc.reason} onChange={e => onChange(a => ({ ...a, reason: e.target.value }))} maxLength={500} placeholder={t('proc.sel.overReasonHint')} data-testid={`select-reason-${k}`} disabled={ev.state === 'blocked'} />
              </div>
            )}
            {ev.problems.length > 0 && (
              <ul className="space-y-0.5 text-sm text-danger" data-testid={`select-problems-${k}`}>{ev.problems.map(pr => <li key={pr}>{pr}</li>)}</ul>
            )}
          </>
        )}

        {history.length > 0 && (
          <div data-testid={`select-history-${k}`}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">{t('proc.sel.q.history')}</p>
            <div className="overflow-x-auto rounded border border-border">
              <table className="w-full text-xs">
                <thead className="bg-subtle text-left text-fg-muted">
                  <tr><th className="px-2 py-1 font-medium">{t('proc.sel.q.po')}</th><th className="px-2 py-1 font-medium">{t('proc.sel.q.date')}</th><th className="px-2 py-1 font-medium">{t('proc.sel.q.vendor')}</th><th className="px-2 py-1 text-right font-medium">{t('proc.sel.q.rate')}</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {history.slice(0, 10).map(h => (
                    <tr key={`${h.poNumber}-${h.vendorId}`}>
                      <td className="px-2 py-1 tabular-nums">{h.poNumber}</td>
                      <td className="px-2 py-1">{fmtDate(h.date)}</td>
                      <td className="px-2 py-1">{h.vendorName}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{fmtRate(h.rate, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

/** Overview before "Submit for approval": every split with qty, rate and amount, totals per vendor. */
function SelectionConfirmDialog({ results, currency, busy, onCancel, onConfirm }: {
  results: { l: OrderableLine; a: Alloc }[]; currency: string; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const rows = results.flatMap(r => r.a.rows.map(row => ({
    key: `${r.l.indentLineId}-${row.key}`, indent: r.l.indentNumber ?? '', item: r.l.item?.name ?? '—', vendor: row.vendor?.name ?? '—',
    qty: row.qty, uom: r.l.uom ?? '', rate: row.rate, amount: num(row.qty) * num(row.rate),
  })));
  const byVendor = new Map<string, number>();
  for (const r of rows) byVendor.set(r.vendor, (byVendor.get(r.vendor) ?? 0) + r.amount);
  const grand = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <Dialog open onOpenChange={o => { if (!o && !busy) onCancel(); }}>
      <DialogContent size="lg" title={t('proc.sel.confirm.title')} description={t('proc.sel.confirm.summary', { lines: results.length, vendors: byVendor.size })} data-testid="select-confirm-dialog"
        footer={<>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-testid="select-confirm-cancel">{t('common.cancel')}</Button>
          <Button onClick={onConfirm} loading={busy} data-testid="select-confirm-ok">{t('proc.sel.submit')}</Button>
        </>}>
        <div className="max-h-[55vh] overflow-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-subtle text-left text-xs text-fg-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t('proc.sel.confirm.indent')}</th>
                <th className="px-3 py-2 font-medium">{t('proc.sel.confirm.item')}</th>
                <th className="px-3 py-2 font-medium">{t('proc.sel.q.vendor')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('proc.sel.confirm.qty')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('proc.sel.q.rate')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('proc.sel.confirm.amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(r => (
                <tr key={r.key}>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">{r.indent}</td>
                  <td className="px-3 py-2">{r.item}</td>
                  <td className="px-3 py-2">{r.vendor}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtQty(r.qty)} <span className="text-fg-subtle">{r.uom}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtRate(r.rate, currency)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{fmtRate(r.amount, currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-subtle text-sm">
              {[...byVendor.entries()].map(([v, amt]) => (
                <tr key={v}><td className="px-3 py-1.5 text-fg-muted" colSpan={5}>{t('proc.sel.confirm.vendorTotal', { vendor: v })}</td><td className="px-3 py-1.5 text-right tabular-nums">{fmtRate(amt, currency)}</td></tr>
              ))}
              <tr className="font-semibold"><td className="px-3 py-2" colSpan={5}>{t('proc.sel.confirm.grand')}</td><td className="px-3 py-2 text-right tabular-nums">{fmtRate(grand, currency)}</td></tr>
            </tfoot>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

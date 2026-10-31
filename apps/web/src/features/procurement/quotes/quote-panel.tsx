'use client';
import type { DocumentLineRow, DocumentRow, VendorQuoteRow } from '@procure/schema';
import { Badge, Button, cn, EmptyState, NativeSelect, Segmented, Skeleton, toast } from '@procure/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, ChevronRight, FileText, History, Paperclip, Pencil, Plus, Scale, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { dec, fmtQty } from '@/features/documents/decimal';
import { docKeys } from '@/features/documents/api';
import { lineItemLabel, lineUom } from '@/features/documents/lines-table';
import { procApi, procKeys } from '../api';
import { effectiveRate, fmtPct, fmtRate, num } from '../calc';
import { PERM, useProcurementFlow } from '../flow';
import { ComparisonSheetView } from './comparison-sheet';
import { QuoteFormDialog, type QuoteLineContext } from './quote-form';

type View = 'compare' | 'log';

/** Quantity still to be covered by a selection: approved + over-approved − selected (− short-closed). */
export function pendingSelection(l: DocumentLineRow): string {
  return dec.max0(dec.sub(dec.add(l.qty.approved, l.qty.overApproved), dec.add(l.qty.selected, l.qty.shortClosed)));
}

/** Indent detail tab "Vendor quotes": per line quote log (versioned) and the comparison sheet. */
export function QuotePanel({ doc, focusLineId, onFocusLine }: { doc: DocumentRow; focusLineId: string | null; onFocusLine: (id: string) => void }) {
  const p = usePermissions();
  const flow = useProcurementFlow();
  const lines = useMemo(() => [...doc.lines].filter(l => l.values.item).sort((a, b) => a.lineNo - b.lineNo), [doc.lines]);
  const [lineId, setLineId] = useState<string | null>(() => (focusLineId && lines.some(l => l.id === focusLineId) ? focusLineId : lines[0]?.id ?? null));
  useEffect(() => { if (focusLineId && lines.some(l => l.id === focusLineId)) setLineId(focusLineId); }, [focusLineId, lines]);
  const line = lines.find(l => l.id === lineId) ?? null;
  const canCompare = p.has(PERM.compare);
  const [view, setView] = useState<View>(canCompare ? 'compare' : 'log');

  if (!lines.length) return <EmptyState icon={<Scale />} title={t('proc.quotes.noLines')} />;

  const choose = (id: string) => { setLineId(id); onFocusLine(id); };

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]" data-testid="quote-panel">
      {/* Line rail (desktop) / select (phones) */}
      <div className="lg:hidden">
        <label htmlFor="quote-line-select" className="mb-1 block text-sm text-fg-muted">{t('proc.quotes.line')}</label>
        <NativeSelect id="quote-line-select" value={lineId ?? ''} onChange={e => choose(e.target.value)} data-testid="quote-line-select">
          {lines.map(l => <option key={l.id} value={l.id}>{`${l.lineNo}. ${lineItemLabel(l)} · ${fmtQty(l.qty.approved)} ${lineUom(l)}`}</option>)}
        </NativeSelect>
      </div>
      <nav aria-label={t('proc.quotes.lines')} className="hidden lg:block">
        <ul className="space-y-1">
          {lines.map(l => {
            const on = l.id === lineId;
            return (
              <li key={l.id}>
                <button type="button" onClick={() => choose(l.id)} aria-current={on ? 'true' : undefined} data-testid={`quote-line-${l.lineNo}`}
                  className={cn('w-full rounded border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                    on ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-muted')}>
                  <span className="flex items-baseline gap-2">
                    <span className="text-xs tabular-nums text-fg-subtle">{l.lineNo}</span>
                    <span className={cn('min-w-0 flex-1 truncate', on && 'font-medium')}>{lineItemLabel(l)}</span>
                  </span>
                  <span className="mt-0.5 block pl-5 text-xs text-fg-muted tabular-nums">
                    {t('proc.quotes.approvedQty', { qty: fmtQty(dec.add(l.qty.approved, l.qty.overApproved)), uom: lineUom(l) })}
                    {dec.gt0(l.qty.selected) && <> · {t('proc.quotes.selectedQty', { qty: fmtQty(l.qty.selected) })}</>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {line && (
        <LineQuotes key={line.id} doc={doc} line={line} view={view} setView={setView} canCompare={canCompare}
          canLog={p.has(PERM.logQuote)} canSelect={flow.selectionEnabled && p.has(PERM.selectionAdd)}
          canApproveQuote={flow.selectionEnabled && p.has(PERM.approveQuote)} />
      )}
    </div>
  );
}

function LineQuotes({ doc, line, view, setView, canCompare, canLog, canSelect, canApproveQuote }: {
  doc: DocumentRow; line: DocumentLineRow; view: View; setView: (v: View) => void; canCompare: boolean; canLog: boolean; canSelect: boolean; canApproveQuote: boolean;
}) {
  const qc = useQueryClient();
  const { currency } = useTenantLocale();
  const uom = lineUom(line);
  const pending = pendingSelection(line);
  const [qty, setQty] = useState<string>(() => (dec.gt0(pending) ? pending : dec.norm(line.qty.requested)));
  const [showAll, setShowAll] = useState(false);
  const [form, setForm] = useState<{ open: boolean; editing: VendorQuoteRow | null }>({ open: false, editing: null });

  const quotes = useQuery({ queryKey: procKeys.quotes(line.id, showAll), queryFn: () => procApi.quotes(line.id, showAll), retry: false });
  const sheet = useQuery({
    queryKey: procKeys.lineComparison(line.id, qty),
    queryFn: () => procApi.lineComparison(line.id, dec.gt0(qty) ? dec.norm(qty) : undefined),
    enabled: canCompare && view === 'compare',
    retry: false,
  });

  const ctx: QuoteLineContext = {
    lineId: line.id, itemId: typeof line.values.item === 'string' ? line.values.item : null, itemName: lineItemLabel(line),
    qty: dec.gt0(pending) ? pending : line.qty.requested, uom, docNumber: doc.number, lineNo: line.lineNo,
  };
  const vendorSuggestions = useMemo(() => {
    const m = new Map<string, { id: string; code: string; name: string; hint?: string }>();
    for (const r of quotes.data ?? []) m.set(r.vendor.id, { ...r.vendor, hint: t('proc.quotes.quotedBefore') });
    return [...m.values()];
  }, [quotes.data]);

  const onSaved = (rows: VendorQuoteRow[]) => {
    toast.success(form.editing ? t('proc.quote.savedVersion', { n: rows[0]?.version ?? 2 }) : rows.length > 1 ? t('proc.quote.loggedN', { n: rows.length }) : t('proc.quote.logged'));
    void qc.invalidateQueries({ queryKey: procKeys.all });
    void qc.invalidateQueries({ queryKey: docKeys.timeline('indent', doc.id) });
  };

  const current = (quotes.data ?? []).filter(r => r.isCurrent);
  const groups = groupByVendor(quotes.data ?? []);

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="quote-line-h" data-testid="quote-line-panel" data-line={line.lineNo}>
      <header className="flex flex-col gap-3 border-b border-border pb-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 id="quote-line-h" className="truncate text-md font-semibold">{t('proc.quotes.lineTitle', { n: line.lineNo, item: lineItemLabel(line) })}</h2>
          <p className="text-sm text-fg-muted tabular-nums">
            {t('proc.quotes.lineFacts', { approved: fmtQty(dec.add(line.qty.approved, line.qty.overApproved)), pending: fmtQty(pending), uom })}
            {line.values.required_date ? <> · {t('proc.quotes.needBy', { date: fmtDate(String(line.values.required_date)) })}</> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canCompare && (
            <Segmented<View> label={t('proc.quotes.viewLabel')} value={view} onChange={setView} size="md" data-testid="quote-view"
              options={[{ value: 'compare', label: t('proc.quotes.viewCompare') }, { value: 'log', label: t('proc.quotes.viewLog', { n: current.length }) }]} />
          )}
          {canLog && <Button onClick={() => setForm({ open: true, editing: null })} data-testid="quote-add"><Plus aria-hidden />{t('proc.quote.logTitle')}</Button>}
        </div>
      </header>

      {view === 'compare' && canCompare ? (
        sheet.isLoading ? <Skeleton className="h-72 w-full" /> : sheet.isError ? (
          <InlineAlert>{isApiError(sheet.error) ? sheet.error.message : t('proc.cmp.failed')}</InlineAlert>
        ) : sheet.data ? (
          <ComparisonSheetView sheet={sheet.data} currency={currency} qty={qty} onQtyChange={v => setQty(v)}
            footer={canSelect && dec.gt0(pending) && sheet.data.vendors.length > 0 ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button asChild variant="secondary"><Link href={`/procurement/select?line=${line.id}`} data-testid="compare-select"><ShoppingCart aria-hidden />{t('proc.cmp.goSelect')}</Link></Button>
              </div>
            ) : null} />
        ) : null
      ) : (
        <div className="space-y-3" data-testid="quote-log">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-fg-muted">{t('proc.quotes.logHint')}</p>
            <Button variant="ghost" size="sm" onClick={() => setShowAll(s => !s)} aria-pressed={showAll} data-testid="quote-show-history"><History aria-hidden />{showAll ? t('proc.quotes.hideHistory') : t('proc.quotes.showHistory')}</Button>
          </div>
          {quotes.isLoading ? <Skeleton className="h-40 w-full" /> : quotes.isError ? (
            <InlineAlert>{isApiError(quotes.error) ? quotes.error.message : t('proc.quotes.failed')}</InlineAlert>
          ) : groups.length === 0 ? (
            <div className="rounded border border-dashed border-border px-3 py-8 text-center" data-testid="quote-empty">
              <p className="text-fg-muted">{t('proc.quotes.empty')}</p>
              {canLog && <Button className="mt-3" variant="secondary" onClick={() => setForm({ open: true, editing: null })}><Plus aria-hidden />{t('proc.quote.logTitle')}</Button>}
            </div>
          ) : (
            <ul className="space-y-2">
              {groups.map(g => <VendorQuoteCard key={g.vendor.id} rows={g.rows} qty={num(ctx.qty)} uom={uom} canEdit={canLog} onEdit={r => setForm({ open: true, editing: r })}
                canApprove={canApproveQuote} pendingQty={pending} lineUom={uom} onApproved={() => { void qc.invalidateQueries({ queryKey: procKeys.all }); void qc.invalidateQueries({ queryKey: docKeys.timeline('indent', doc.id) }); }} />)}
            </ul>
          )}
        </div>
      )}

      {form.open && (
        <QuoteFormDialog open onOpenChange={o => !o && setForm({ open: false, editing: null })} line={ctx} editing={form.editing}
          vendorSuggestions={vendorSuggestions} onSaved={onSaved} currency={currency} />
      )}
    </section>
  );
}

function groupByVendor(rows: VendorQuoteRow[]) {
  const m = new Map<string, { vendor: VendorQuoteRow['vendor']; rows: VendorQuoteRow[] }>();
  for (const r of rows) {
    const g = m.get(r.vendor.id) ?? { vendor: r.vendor, rows: [] };
    g.rows.push(r);
    m.set(r.vendor.id, g);
  }
  for (const g of m.values()) g.rows.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.createdAt.localeCompare(a.createdAt));
  return [...m.values()].sort((a, b) => a.vendor.name.localeCompare(b.vendor.name));
}

/** One vendor: the current quote, plus earlier versions (append-only history) when loaded. */
function VendorQuoteCard({ rows, qty, uom, canEdit, onEdit, canApprove, pendingQty, lineUom, onApproved }: { rows: VendorQuoteRow[]; qty: number; uom: string; canEdit: boolean; onEdit: (r: VendorQuoteRow) => void; canApprove: boolean; pendingQty: string; lineUom: string; onApproved: () => void }) {
  const [open, setOpen] = useState(false);
  const approveMut = useMutation({
    mutationFn: (quoteId: string) => procApi.approveQuote(quoteId, pendingQty),
    onSuccess: () => { toast.success(t('proc.quote.approved')); onApproved(); },
    onError: () => { toast.error(t('proc.quote.approveError')); },
  });
  const currentRows = rows.filter(r => r.isCurrent);
  const old = rows.filter(r => !r.isCurrent);
  return (
    <>
      {currentRows.map(r => (
        <li key={r.id} className="rounded-lg border border-border bg-surface" data-testid={`quote-row-${r.vendor.code}`} data-quote-id={r.id} data-version={r.version}>
          <QuoteBody r={r} qty={qty} uom={uom}
            actions={
              <div className="flex items-center gap-1">
                {canApprove && (
                  <Button variant="outline" size="sm" tone="success" onClick={() => approveMut.mutate(r.id)} disabled={approveMut.isPending} data-testid={`quote-approve-${r.vendor.code}`}>
                    <CheckCircle2 aria-hidden />{approveMut.isPending ? t('proc.quote.approving') : t('proc.quote.approve')}
                  </Button>
                )}
                {canEdit && <Button variant="ghost" size="sm" onClick={() => onEdit(r)} data-testid={`quote-edit-${r.vendor.code}`}><Pencil aria-hidden />{t('proc.quote.edit')}</Button>}
              </div>
            } />
          {old.length > 0 && (
            <div className="border-t border-border">
              <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} data-testid={`quote-history-${r.vendor.code}`}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm text-fg-muted hover:text-fg">
                {open ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
                {t('proc.quotes.earlier', { n: old.length })}
              </button>
              {open && (
                <ol className="space-y-px bg-subtle px-3 pb-3">
                  {old.map(o => (
                    <li key={o.id} className="rounded border border-border bg-surface opacity-80" data-testid={`quote-version-${r.vendor.code}-${o.version}`}>
                      <QuoteBody r={o} qty={qty} uom={uom} superseded />
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </li>
      ))}
    </>
  );
}

function QuoteBody({ r, qty, uom, actions, superseded }: { r: VendorQuoteRow; qty: number; uom: string; actions?: React.ReactNode; superseded?: boolean }) {
  const cur = r.currency ?? 'INR';
  const eff = effectiveRate(r.quotedRate, r.slabs ?? [], qty);
  return (
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            {!superseded && <span className="font-semibold">{r.vendor.name}</span>}
            <Badge tone={superseded ? 'neutral' : 'accent'}>{t('proc.quote.version', { n: r.version })}</Badge>
            {superseded && <span className="text-xs text-fg-subtle">{t('proc.quote.superseded')}</span>}
          </p>
          <p className="text-xs text-fg-subtle">{t('proc.quote.loggedBy', { name: r.createdBy.name, when: fmtDateTime(r.createdAt) })}</p>
        </div>
        {actions}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Fact label={t('proc.cmp.quoted')} value={`${fmtRate(r.quotedRate, cur)} / ${uom || t('proc.unit')}`} strong />
        <Fact label={t('proc.cmp.tax')} value={fmtPct(r.taxPct ?? '0')} />
        <Fact label={t('proc.quote.freight')} value={num(r.freight) ? `${fmtRate(r.freight, cur)} ${r.freightBasis === 'per_unit' ? t('proc.quote.perUnitShort', { uom }) : t('proc.quote.lumpSumShort')}` : '—'} />
        <Fact label={t('proc.cmp.leadTime')} value={r.leadTimeDays !== undefined && r.leadTimeDays !== null ? t('proc.cmp.days', { n: r.leadTimeDays }) : '—'} />
        <Fact label={t('proc.cmp.moq')} value={r.moq ? `${fmtQty(r.moq)} ${uom}` : '—'} />
        <Fact label={t('proc.cmp.validUntil')} value={r.validUntil ? fmtDate(r.validUntil) : '—'} />
      </dl>
      {(r.slabs?.length ?? 0) > 0 && (
        <div className="rounded bg-subtle px-2.5 py-1.5 text-sm" data-testid={`quote-slabs-${r.vendor.code}`}>
          <span className="text-fg-muted">{t('proc.quote.slabs')}: </span>
          {r.slabs!.map((s, i) => (
            <span key={i} className="mr-3 inline-block tabular-nums">
              {s.toQty ? t('proc.slab.rangeShort', { from: fmtQty(s.fromQty), to: fmtQty(s.toQty) }) : t('proc.slab.fromShort', { from: fmtQty(s.fromQty) })}
              {' '}<span className="font-medium">{s.rate ? fmtRate(s.rate, cur) : t('proc.slab.off', { pct: fmtPct(s.discountPct) })}</span>
            </span>
          ))}
          <span className="text-fg-muted">{t('proc.quote.atQty', { rate: fmtRate(eff, cur), qty: fmtQty(String(qty)), uom })}</span>
        </div>
      )}
      {(r.notes || (r.fileIds?.length ?? 0) > 0) && (
        <p className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">
          {r.notes && <span className="inline-flex items-center gap-1"><FileText className="size-3.5" aria-hidden />{r.notes}</span>}
          {(r.fileIds?.length ?? 0) > 0 && <span className="inline-flex items-center gap-1"><Paperclip className="size-3.5" aria-hidden />{t('proc.quote.filesN', { n: r.fileIds!.length })}</span>}
        </p>
      )}
    </div>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className="min-w-0"><dt className="text-xs text-fg-subtle">{label}</dt><dd className={cn('truncate tabular-nums', strong && 'font-semibold')}>{value}</dd></div>;
}

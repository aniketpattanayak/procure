'use client';
import type { DocumentRow, ReceivablePoLine } from '@procure/schema';
import { Badge, Button, Card, Checkbox, cn, EmptyState, FormField, Input, Skeleton, toast } from '@procure/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, CheckCircle2, PackageCheck, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { docKeys } from '@/features/documents/api';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { MasterPicker, type PickedOption } from '@/features/procurement/components/master-picker';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useCurrentLocationId } from '@/lib/location';
import { useTenantPrincipal } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { invApi, stockError, stockKeys, type GrnFromPoBody } from './api';
import { LocationSelect, SearchBox, useStockFlow } from './components';

interface Pick { qty: string; rejected: string; rejectReason: string; batchNo: string; mfgDate: string; expiryDate: string }
interface Header { invoice_no: string; invoice_date: string; challan_no: string; vehicle_no: string }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems (block create) and warnings (tolerance) for one picked line. */
export function checkReceipt(l: Pick & { line: ReceivablePoLine }): { error: string | null; warning: string | null } {
  const { line } = l;
  if (!isDecimal(l.qty) || !dec.gt0(l.qty)) return { error: t('stock.err.qty'), warning: null };
  if (dec.cmp(l.qty, line.maxReceivable) > 0) return { error: t('grn.err.overMax', { max: fmtQty(line.maxReceivable) }), warning: null };
  const rej = l.rejected.trim() === '' ? '0' : l.rejected;
  if (!isDecimal(rej)) return { error: t('grn.err.rejected'), warning: null };
  if (dec.cmp(rej, l.qty) > 0) return { error: t('grn.err.rejectedOver'), warning: null };
  if (dec.gt0(rej) && !l.rejectReason.trim()) return { error: t('grn.err.reason'), warning: null };
  if (l.expiryDate && !DATE_RE.test(l.expiryDate)) return { error: t('stock.opening.err.date'), warning: null };
  if (l.mfgDate && l.expiryDate && l.mfgDate > l.expiryDate) return { error: t('grn.err.expiryBeforeMfg'), warning: null };
  const warning = dec.cmp(l.qty, line.pendingReceipt) > 0 ? t('grn.warn.over', { over: fmtQty(dec.sub(l.qty, line.pendingReceipt)), pending: fmtQty(line.pendingReceipt) }) : null;
  return { error: null, warning };
}

/** Receive against PO: pick receivable PO lines (grouped by PO and vendor), enter quantities, create GRN draft(s). */
export function ReceivePage() {
  const qc = useQueryClient();
  const router = useRouter();
  const sp = useSearchParams();
  const me = useTenantPrincipal();
  const switcher = useCurrentLocationId(me?.userId);
  const flow = useStockFlow();
  const { currency } = useTenantLocale();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [vendor, setVendor] = useState<PickedOption | null>(null);
  const [location, setLocation] = useState(switcher ?? '');
  const po = sp.get('po') ?? undefined;
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [header, setHeader] = useState<Header>({ invoice_no: '', invoice_date: '', challan_no: '', vehicle_no: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null);
  const [created, setCreated] = useState<DocumentRow[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [lineErr, setLineErr] = useState<{ ref: string; message: string } | null>(null);

  const query = { vendor: vendor?.id, location: location || undefined, q: dq || undefined, po };
  const list = useInfiniteQuery({
    queryKey: stockKeys.receivable(query),
    queryFn: ({ pageParam }) => invApi.receivable(query, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    retry: false,
  });
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap(p => p.data), [list.data]);
  const byId = useMemo(() => new Map(rows.map(r => [r.poLineId, r])), [rows]);
  const pos = useMemo(() => {
    const m = new Map<string, { poId: string; poNumber: string | null; vendor: ReceivablePoLine['vendor']; lines: ReceivablePoLine[] }>();
    for (const r of rows) { const g = m.get(r.poId) ?? { poId: r.poId, poNumber: r.poNumber, vendor: r.vendor, lines: [] }; g.lines.push(r); m.set(r.poId, g); }
    return [...m.values()];
  }, [rows]);

  const toggle = (l: ReceivablePoLine, on: boolean) => setPicks(p => {
    const n = { ...p };
    if (on) n[l.poLineId] = { qty: dec.norm(l.pendingReceipt), rejected: '', rejectReason: '', batchNo: '', mfgDate: '', expiryDate: '' };
    else delete n[l.poLineId];
    return n;
  });
  const set = (id: string, patch: Partial<Pick>) => setPicks(p => (p[id] ? { ...p, [id]: { ...p[id]!, ...patch } } : p));

  const chosen = Object.entries(picks).map(([id, pk]) => ({ id, ...pk, line: byId.get(id) })).filter((x): x is Pick & { id: string; line: ReceivablePoLine } => !!x.line);
  const checked = chosen.map(c => ({ ...c, ...checkReceipt(c) }));
  const bad = checked.filter(c => c.error);
  // One GRN per PO; per vendor when the tenant allows multi-PO GRNs.
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string; vendor: string; lines: typeof chosen }>();
    for (const c of chosen) {
      const key = flow.multiPo ? c.line.vendor.id : c.line.poId;
      const g = m.get(key) ?? { key, label: flow.multiPo ? c.line.vendor.name : c.line.poNumber ?? '—', vendor: c.line.vendor.name, lines: [] };
      g.lines.push(c);
      m.set(key, g);
    }
    return [...m.values()];
  }, [chosen, flow.multiPo]);

  const create = async (submit: boolean) => {
    setError(null);
    setLineErr(null);
    setShowErrors(true);
    if (!chosen.length) return;
    if (bad.length) { setError(t('grn.err.fix', { n: bad.length })); return; }
    if (header.invoice_date && !DATE_RE.test(header.invoice_date)) { setError(t('stock.opening.err.date')); return; }
    const values = Object.fromEntries(Object.entries(header).filter(([, v]) => v.trim() !== ''));
    setSaving(submit ? 'submit' : 'draft');
    const docs: DocumentRow[] = [];
    try {
      for (const g of groups) {
        const body: GrnFromPoBody = {
          values,
          submit,
          lines: g.lines.map(c => {
            const rej = c.rejected.trim() && dec.gt0(c.rejected) ? dec.norm(c.rejected) : null;
            return {
              poLineId: c.id, qty: dec.norm(c.qty),
              ...(rej ? { rejectedQty: rej, acceptedQty: dec.sub(c.qty, rej), rejectReason: c.rejectReason.trim() } : {}),
              ...(c.batchNo.trim() ? { batchNo: c.batchNo.trim() } : {}),
              ...(c.mfgDate ? { mfgDate: c.mfgDate } : {}),
              ...(c.expiryDate ? { expiryDate: c.expiryDate } : {}),
              values: {},
            };
          }),
        };
        docs.push(...(await invApi.grnFromPo(body)));
      }
      setPicks({});
      setShowErrors(false);
      void qc.invalidateQueries({ queryKey: stockKeys.inventory });
      void qc.invalidateQueries({ queryKey: docKeys.all('grn') });
      void qc.invalidateQueries({ queryKey: docKeys.all('po') });
      toast.success(t('grn.created', { n: docs.length }));
      if (docs.length === 1) { router.push(`/docs/grn/${docs[0]!.id}`); return; }
      setCreated(docs);
    } catch (e) {
      if (docs.length) setCreated(docs);
      const se = stockError(e);
      setError(se.message);
      if (se.ref) setLineErr({ ref: se.ref, message: se.message });
    } finally {
      setSaving(null);
    }
  };

  const hdr = (k: keyof Header, label: string, type = 'text') => (
    <FormField label={label}>
      <Input type={type} value={header[k]} onChange={e => setHeader(h => ({ ...h, [k]: e.target.value }))} maxLength={100} data-testid={`grn-header-${k}`} />
    </FormField>
  );

  return (
    <PageBody>
      <PageHeader
        back={<Link href="/docs/grn" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('grn.back')}</Link>}
        title={t('grn.receive.title')}
        description={t('grn.receive.hint', { pct: flow.overReceiptPct })}
      />
      {created && (
        <InlineAlert tone="success" className="mb-4" data-testid="grn-created">
          <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-4" aria-hidden />{t('grn.created', { n: created.length })}</p>
          <ul className="mt-1 space-y-0.5">{created.map((d, i) => <li key={d.id}><Link className="font-medium underline-offset-2 hover:underline" href={`/docs/grn/${d.id}`} data-testid={`grn-created-${i}`}>{d.number ?? t('grn.draftN', { n: i + 1 })}</Link><span className="text-fg-muted"> · {t('order.draftLines', { n: d.lines.length })}</span></li>)}</ul>
        </InlineAlert>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2" data-testid="grn-filters">
            <SearchBox value={q} onChange={setQ} label={t('grn.search')} testId="grn-search" />
            <div className="w-full sm:w-52"><MasterPicker masterKey="vendor" value={vendor} onChange={setVendor} ariaLabel={t('proc.filter.vendor')} placeholder={t('proc.filter.vendor')} compact testId="grn-filter-vendor" /></div>
            <LocationSelect value={location} onChange={setLocation} allLabel={t('topbar.allLocations')} label={t('stock.filter.location')} className="w-full sm:w-48" testId="grn-filter-location" />
            {po && <Button size="sm" variant="ghost" onClick={() => router.replace('/stock/receive')}><X aria-hidden />{t('grn.clearPo')}</Button>}
          </div>
          {list.isLoading ? <Skeleton className="h-64 w-full" /> : list.isError ? (
            <InlineAlert>{isApiError(list.error) ? list.error.message : t('stock.loadFailed')}</InlineAlert>
          ) : rows.length === 0 ? (
            <EmptyState icon={<PackageCheck />} title={t('grn.empty')} description={t('grn.emptyHint')} />
          ) : (
            <div className="space-y-3" data-testid="grn-picker">
              {pos.map(g => {
                const allOn = g.lines.every(l => picks[l.poLineId]);
                const someOn = g.lines.some(l => picks[l.poLineId]);
                return (
                  <section key={g.poId} className="overflow-hidden rounded-lg border border-border" aria-label={g.poNumber ?? ''} data-testid={`grn-po-${g.poNumber}`}>
                    <div className="flex items-center gap-3 border-b border-border bg-subtle px-3 py-2">
                      <Checkbox checked={allOn ? true : someOn ? 'indeterminate' : false} onCheckedChange={c => g.lines.forEach(l => toggle(l, c === true))} aria-label={t('grn.pickPo', { po: g.poNumber ?? '' })} data-testid={`grn-po-all-${g.poNumber}`} />
                      <div className="min-w-0 flex-1">
                        <Link href={`/docs/po/${g.poId}`} className="font-semibold hover:underline">{g.poNumber ?? '—'}</Link>
                        <span className="ml-2 text-sm text-fg-muted">{g.vendor.name}</span>
                      </div>
                      <span className="text-xs text-fg-subtle">{t('grn.nLines', { n: g.lines.length })}</span>
                    </div>
                    <ul className="divide-y divide-border">
                      {g.lines.map(l => <LineRow key={l.poLineId} line={l} pick={picks[l.poLineId]} serverError={lineErr?.ref === l.poLineId ? lineErr.message : null} showErrors={showErrors} currency={currency} onToggle={on => toggle(l, on)} onChange={patch => set(l.poLineId, patch)} />)}
                    </ul>
                  </section>
                );
              })}
              {list.hasNextPage && <div className="flex justify-center"><Button variant="ghost" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>{t('table.loadMore')}</Button></div>}
            </div>
          )}
        </div>

        <Card className="h-fit space-y-3 p-4 lg:sticky lg:top-[calc(var(--topbar-h)+1rem)]" data-testid="grn-preview" data-count={groups.length}>
          <h2 className="font-semibold">{t('grn.preview')}</h2>
          {groups.length === 0 ? <p className="text-sm text-fg-muted">{t('grn.previewEmpty')}</p> : (
            <ul className="space-y-2">
              {groups.map(g => (
                <li key={g.key} className="rounded border border-border px-3 py-2">
                  <p className="truncate font-medium">{g.label}</p>
                  <p className="text-sm text-fg-muted">{g.vendor} · {t('grn.nLines', { n: g.lines.length })}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-2">
            {hdr('invoice_no', t('grn.invoiceNo'))}
            {hdr('invoice_date', t('grn.invoiceDate'), 'date')}
            {hdr('challan_no', t('grn.challanNo'))}
            {hdr('vehicle_no', t('grn.vehicleNo'))}
          </div>
          {error && <p className="text-sm text-danger" role="alert" data-testid="grn-error">{error}</p>}
          <Button className="w-full" variant="secondary" disabled={!chosen.length || !!saving} loading={saving === 'draft'} onClick={() => create(false)} data-testid="grn-create">
            {groups.length > 1 ? t('grn.createN', { n: groups.length }) : t('grn.create1')}
          </Button>
          <Button className="w-full" disabled={!chosen.length || !!saving} loading={saving === 'submit'} onClick={() => create(true)} data-testid="grn-create-submit">{t('grn.createSubmit')}</Button>
          <p className="text-xs text-fg-subtle">{t('grn.draftNote')}</p>
        </Card>
      </div>
    </PageBody>
  );
}

function LineRow({ line: l, pick, serverError, showErrors, currency, onToggle, onChange }: {
  line: ReceivablePoLine; pick: Pick | undefined; serverError: string | null; showErrors: boolean; currency: string; onToggle: (on: boolean) => void; onChange: (p: Partial<Pick>) => void;
}) {
  const k = `${l.poNumber ?? 'po'}-${l.lineNo}`;
  const check = pick ? checkReceipt({ ...pick, line: l }) : null;
  const accepted = pick && isDecimal(pick.qty) ? dec.max0(dec.sub(pick.qty, pick.rejected.trim() && isDecimal(pick.rejected) ? pick.rejected : '0')) : null;
  return (
    <li className={cn('px-3 py-2.5', pick && 'bg-accent-soft/40')} data-testid={`grn-line-${k}`} data-pending={l.pendingReceipt} data-max={l.maxReceivable}>
      <div className="flex items-start gap-3">
        <Checkbox className="mt-1" checked={!!pick} onCheckedChange={c => onToggle(c === true)} aria-label={t('grn.pickLine', { item: l.item?.name ?? '', n: l.lineNo })} data-testid={`grn-pick-${k}`} />
        <div className="grid min-w-0 flex-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <p className="truncate font-medium">{l.item?.name ?? '—'} <span className="font-normal text-fg-subtle">{l.item?.code}</span></p>
            <p className="truncate text-sm text-fg-muted">{t('stock.lineN', { n: l.lineNo })} · {l.location.name}{l.expectedDate ? ` · ${t('grn.expected', { date: fmtDate(l.expectedDate) })}` : ''}{l.rate ? ` · ${fmtMoney(Number(l.rate), currency)}/${l.uom ?? t('proc.unit')}` : ''}</p>
          </div>
          <dl className="flex gap-3 text-right text-xs text-fg-muted sm:self-start">
            <div><dt>{t('grn.ordered')}</dt><dd className="tabular-nums text-fg">{fmtQty(l.ordered)}</dd></div>
            <div><dt>{t('grn.received')}</dt><dd className="tabular-nums text-fg">{fmtQty(l.received)}</dd></div>
            <div><dt>{t('grn.pending')}</dt><dd className="font-semibold tabular-nums text-fg" data-testid={`grn-pending-${k}`}>{fmtQty(l.pendingReceipt)} {l.uom}</dd></div>
          </dl>
        </div>
      </div>
      {pick && (
        <div className="mt-2 space-y-2 pl-7">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <FormField label={t('grn.qtyReceived')} hint={t('grn.maxHint', { max: fmtQty(l.maxReceivable) })}>
              <Input inputMode="decimal" className="h-8" value={pick.qty} onChange={e => onChange({ qty: e.target.value })} aria-invalid={(showErrors && !!check?.error) || undefined} data-testid={`grn-qty-${k}`} />
            </FormField>
            <FormField label={t('grn.rejectedQty')}>
              <Input inputMode="decimal" className="h-8" value={pick.rejected} placeholder="0" onChange={e => onChange({ rejected: e.target.value })} data-testid={`grn-rejected-${k}`} />
            </FormField>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('grn.acceptedQty')}</span>
              <span className="flex h-8 items-center tabular-nums" data-testid={`grn-accepted-${k}`}>{accepted === null ? '—' : fmtQty(accepted)}</span>
            </div>
            {pick.rejected.trim() && dec.gt0(pick.rejected) ? (
              <FormField label={t('grn.rejectReason')} required>
                <Input className="h-8" value={pick.rejectReason} maxLength={500} onChange={e => onChange({ rejectReason: e.target.value })} data-testid={`grn-reason-${k}`} />
              </FormField>
            ) : <span />}
            <FormField label={t('stock.col.batch')}>
              <Input className="h-8" value={pick.batchNo} maxLength={60} onChange={e => onChange({ batchNo: e.target.value })} data-testid={`grn-batch-${k}`} />
            </FormField>
            <FormField label={t('grn.mfgDate')}>
              <Input type="date" className="h-8" value={pick.mfgDate} onChange={e => onChange({ mfgDate: e.target.value })} />
            </FormField>
            <FormField label={t('grn.expiryDate')}>
              <Input type="date" className="h-8" value={pick.expiryDate} onChange={e => onChange({ expiryDate: e.target.value })} data-testid={`grn-expiry-${k}`} />
            </FormField>
          </div>
          {check?.warning && !check.error && <p className="flex items-center gap-1.5 text-sm text-warning" data-testid={`grn-warn-${k}`}><AlertTriangle className="size-4" aria-hidden />{check.warning}</p>}
          {check?.error && (showErrors || dec.cmp(pick.qty || '0', l.maxReceivable) > 0) && <p className="text-sm text-danger" role="alert" data-testid={`grn-line-error-${k}`}>{check.error}</p>}
          {serverError && <p className="text-sm text-danger" role="alert" data-testid={`grn-server-error-${k}`}>{serverError}</p>}
          {dec.cmp(l.maxReceivable, l.pendingReceipt) > 0 && !check?.warning && <Badge tone="neutral">{t('grn.tolerance', { max: fmtQty(l.maxReceivable) })}</Badge>}
        </div>
      )}
    </li>
  );
}

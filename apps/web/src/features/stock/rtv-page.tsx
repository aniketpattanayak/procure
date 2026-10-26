'use client';
import type { DocumentRow, StockStatus } from '@procure/schema';
import { Button, Card, Checkbox, cn, EmptyState, FormField, Input, NativeSelect, Skeleton, Textarea, toast } from '@procure/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { docKeys } from '@/features/documents/api';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { MasterPicker, type PickedOption } from '@/features/procurement/components/master-picker';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { invApi, stockError, stockKeys, type ReturnableGrnLine } from './api';
import { SearchBox } from './components';

interface Pick { qty: string; fromStatus: StockStatus; reason: string }

/** Return to vendor from GRN lines (manual returns after acceptance; rejected stock is drafted by the workflow). */
export function RtvPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const sp = useSearchParams();
  const grn = sp.get('grn') ?? undefined;
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [vendor, setVendor] = useState<PickedOption | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<DocumentRow[] | null>(null);
  const [lineErr, setLineErr] = useState<{ ref: string; message: string } | null>(null);

  const query = { vendor: vendor?.id, grn, q: dq || undefined };
  const list = useInfiniteQuery({
    queryKey: stockKeys.returnableGrn(query),
    queryFn: ({ pageParam }) => invApi.returnableGrn(query, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    retry: false,
  });
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap(p => p.data), [list.data]);
  const byId = useMemo(() => new Map(rows.map(r => [r.grnLineId, r])), [rows]);
  const grns = useMemo(() => {
    const m = new Map<string, { grnId: string; grnNumber: string | null; vendor: ReturnableGrnLine['vendor']; lines: ReturnableGrnLine[] }>();
    for (const r of rows) { const g = m.get(r.grnId) ?? { grnId: r.grnId, grnNumber: r.grnNumber, vendor: r.vendor, lines: [] }; g.lines.push(r); m.set(r.grnId, g); }
    return [...m.values()];
  }, [rows]);

  const toggle = (l: ReturnableGrnLine, on: boolean) => setPicks(p => { const n = { ...p }; if (on) n[l.grnLineId] = { qty: dec.norm(l.returnable), fromStatus: 'available', reason: '' }; else delete n[l.grnLineId]; return n; });
  const set = (id: string, patch: Partial<Pick>) => setPicks(p => (p[id] ? { ...p, [id]: { ...p[id]!, ...patch } } : p));
  const chosen = Object.entries(picks).map(([id, pk]) => ({ id, ...pk, line: byId.get(id) })).filter((x): x is Pick & { id: string; line: ReturnableGrnLine } => !!x.line);
  const problem = (c: Pick & { line: ReturnableGrnLine }) => (!isDecimal(c.qty) || !dec.gt0(c.qty) ? t('stock.err.qty') : dec.cmp(c.qty, c.line.returnable) > 0 ? t('stock.err.max', { qty: fmtQty(c.line.returnable) }) : null);
  const bad = chosen.filter(c => problem(c));
  const vendors = useMemo(() => {
    const m = new Map<string, { vendor: ReturnableGrnLine['vendor']; lines: typeof chosen }>();
    for (const c of chosen) { const g = m.get(c.line.vendor.id) ?? { vendor: c.line.vendor, lines: [] }; g.lines.push(c); m.set(c.line.vendor.id, g); }
    return [...m.values()];
  }, [chosen]);

  const create = async () => {
    setError(null);
    if (bad.length) { setError(t('grn.err.fix', { n: bad.length })); return; }
    setSaving(true);
    const docs: DocumentRow[] = [];
    try {
      for (const g of vendors) {
        docs.push(await invApi.rtvFromGrn({
          values: reason.trim() ? { reason: reason.trim() } : {},
          lines: g.lines.map(c => ({ grnLineId: c.id, qty: dec.norm(c.qty), fromStatus: c.fromStatus, ...(c.reason.trim() ? { reason: c.reason.trim() } : {}) })),
        }));
      }
      setPicks({});
      void qc.invalidateQueries({ queryKey: stockKeys.inventory });
      void qc.invalidateQueries({ queryKey: docKeys.all('rtv') });
      toast.success(t('rtv.created', { n: docs.length }));
      if (docs.length === 1) { router.push(`/docs/rtv/${docs[0]!.id}`); return; }
      setCreated(docs);
    } catch (e) {
      if (docs.length) setCreated(docs);
      const se = stockError(e);
      setError(se.message);
      setLineErr(se.ref ? { ref: se.ref, message: se.message } : null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageBody>
      <PageHeader
        back={<Link href="/docs/rtv" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('rtv.back')}</Link>}
        title={t('rtv.title')}
        description={t('rtv.hint')}
      />
      {created && (
        <InlineAlert tone="success" className="mb-4" data-testid="rtv-created">
          <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-4" aria-hidden />{t('rtv.created', { n: created.length })}</p>
          <ul className="mt-1">{created.map((d, i) => <li key={d.id}><Link className="underline-offset-2 hover:underline" href={`/docs/rtv/${d.id}`}>{d.number ?? t('grn.draftN', { n: i + 1 })}</Link></li>)}</ul>
        </InlineAlert>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchBox value={q} onChange={setQ} label={t('rtv.search')} testId="rtv-search" />
            <div className="w-full sm:w-52"><MasterPicker masterKey="vendor" value={vendor} onChange={setVendor} ariaLabel={t('proc.filter.vendor')} placeholder={t('proc.filter.vendor')} compact /></div>
          </div>
          {list.isLoading ? <Skeleton className="h-64 w-full" /> : list.isError ? <InlineAlert>{isApiError(list.error) ? list.error.message : t('stock.loadFailed')}</InlineAlert>
            : rows.length === 0 ? <EmptyState icon={<Undo2 />} title={t('rtv.empty')} description={t('rtv.emptyHint')} /> : (
              <div className="space-y-3" data-testid="rtv-picker">
                {grns.map(g => (
                  <section key={g.grnId} className="overflow-hidden rounded-lg border border-border" aria-label={g.grnNumber ?? ''}>
                    <div className="flex items-center gap-3 border-b border-border bg-subtle px-3 py-2">
                      <Link href={`/docs/grn/${g.grnId}`} className="font-semibold hover:underline">{g.grnNumber ?? '—'}</Link>
                      <span className="text-sm text-fg-muted">{g.vendor.name}</span>
                    </div>
                    <ul className="divide-y divide-border">
                      {g.lines.map(l => {
                        const pk = picks[l.grnLineId];
                        const k = `${g.grnNumber ?? 'grn'}-${l.lineNo}`;
                        const prob = pk ? problem({ ...pk, line: l }) : null;
                        return (
                          <li key={l.grnLineId} className={cn('px-3 py-2.5', pk && 'bg-accent-soft/40')} data-testid={`rtv-line-${k}`}>
                            <div className="flex items-start gap-3">
                              <Checkbox className="mt-1" checked={!!pk} onCheckedChange={c => toggle(l, c === true)} aria-label={t('grn.pickLine', { item: l.item?.name ?? '', n: l.lineNo })} data-testid={`rtv-pick-${k}`} />
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-medium">{l.item?.name ?? '—'} <span className="font-normal text-fg-subtle">{l.item?.code}</span></p>
                                <p className="text-sm text-fg-muted">{l.location.name}{l.batchNo ? ` · ${l.batchNo}` : ''} · {t('rtv.facts', { accepted: fmtQty(l.accepted), returned: fmtQty(l.returned), inReturn: fmtQty(l.inReturn) })}</p>
                              </div>
                              <p className="text-sm font-semibold tabular-nums">{t('rtv.returnable', { qty: fmtQty(l.returnable), uom: l.uom ?? '' })}</p>
                            </div>
                            {pk && (
                              <div className="mt-2 grid grid-cols-2 gap-2 pl-7 sm:grid-cols-[8rem_10rem_minmax(0,1fr)]">
                                <Input inputMode="decimal" className="h-8" value={pk.qty} onChange={e => set(l.grnLineId, { qty: e.target.value })} aria-label={t('rtv.qty')} aria-invalid={!!prob || undefined} data-testid={`rtv-qty-${k}`} />
                                <NativeSelect className="h-8" value={pk.fromStatus} onChange={e => set(l.grnLineId, { fromStatus: e.target.value as StockStatus })} aria-label={t('rtv.from')}>
                                  <option value="available">{t('stock.status.available')}</option>
                                  <option value="quarantine">{t('stock.status.quarantine')}</option>
                                  <option value="rejected">{t('stock.status.rejected')}</option>
                                </NativeSelect>
                                <Input className="col-span-2 h-8 sm:col-span-1" value={pk.reason} maxLength={500} placeholder={t('common.reason')} onChange={e => set(l.grnLineId, { reason: e.target.value })} aria-label={t('common.reason')} />
                                {(prob || lineErr?.ref === l.grnLineId) && <p className="col-span-full text-sm text-danger" role="alert">{prob ?? lineErr?.message}</p>}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
                {list.hasNextPage && <div className="flex justify-center"><Button variant="ghost" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>{t('table.loadMore')}</Button></div>}
              </div>
            )}
        </div>
        <Card className="h-fit space-y-3 p-4 lg:sticky lg:top-[calc(var(--topbar-h)+1rem)]">
          <h2 className="font-semibold">{t('grn.preview')}</h2>
          {vendors.length === 0 ? <p className="text-sm text-fg-muted">{t('rtv.previewEmpty')}</p> : (
            <ul className="space-y-2">{vendors.map(g => <li key={g.vendor.id} className="rounded border border-border px-3 py-2"><p className="font-medium">{g.vendor.name}</p><p className="text-sm text-fg-muted">{t('grn.nLines', { n: g.lines.length })}</p></li>)}</ul>
          )}
          <FormField label={t('common.reason')}><Textarea rows={2} value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} /></FormField>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button className="w-full" disabled={!chosen.length} loading={saving} onClick={create} data-testid="rtv-create">{t('rtv.create', { n: Math.max(1, vendors.length) })}</Button>
          <p className="text-xs text-fg-subtle">{t('grn.draftNote')}</p>
        </Card>
      </div>
    </PageBody>
  );
}

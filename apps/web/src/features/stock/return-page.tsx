'use client';
import type { ReturnableLine } from '@procure/schema';
import { Button, Card, Checkbox, cn, EmptyState, FormField, Input, NativeSelect, Skeleton, toast } from '@procure/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, PackagePlus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { docKeys } from '@/features/documents/api';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { invApi, stockError, stockKeys } from './api';
import { LocationSelect, SearchBox } from './components';

type ReturnStatus = 'available' | 'quarantine';
interface Pick { qty: string; status: ReturnStatus; reason: string }

/** Return issued material to the store (to available or quarantine), from store-issue lines. */
export function ReturnPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const sp = useSearchParams();
  const issue = sp.get('issue') ?? undefined;
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [node, setNode] = useState('');
  const [returnedBy, setReturnedBy] = useState('');
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null);
  const [lineErr, setLineErr] = useState<{ ref: string; message: string } | null>(null);

  const query = { issue, q: dq || undefined };
  const list = useInfiniteQuery({
    queryKey: stockKeys.returnable(query),
    queryFn: ({ pageParam }) => invApi.returnable(query, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    retry: false,
  });
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap(p => p.data), [list.data]);
  const byId = useMemo(() => new Map(rows.map(r => [r.issueLineId, r])), [rows]);
  const issues = useMemo(() => {
    const m = new Map<string, { id: string; number: string | null; lines: ReturnableLine[] }>();
    for (const r of rows) { const g = m.get(r.issueId) ?? { id: r.issueId, number: r.issueNumber, lines: [] }; g.lines.push(r); m.set(r.issueId, g); }
    return [...m.values()];
  }, [rows]);

  const toggle = (l: ReturnableLine, on: boolean) => setPicks(p => { const n = { ...p }; if (on) n[l.issueLineId] = { qty: dec.norm(l.returnable), status: 'available', reason: '' }; else delete n[l.issueLineId]; return n; });
  const set = (id: string, patch: Partial<Pick>) => setPicks(p => (p[id] ? { ...p, [id]: { ...p[id]!, ...patch } } : p));
  const chosen = Object.entries(picks).map(([id, pk]) => ({ id, ...pk, line: byId.get(id) })).filter((x): x is Pick & { id: string; line: ReturnableLine } => !!x.line);
  const problem = (c: Pick & { line: ReturnableLine }) => (!isDecimal(c.qty) || !dec.gt0(c.qty) ? t('stock.err.qty') : dec.cmp(c.qty, c.line.returnable) > 0 ? t('stock.err.max', { qty: fmtQty(c.line.returnable) }) : null);
  const bad = chosen.filter(c => problem(c));

  const create = async (submit: boolean) => {
    setError(null);
    if (bad.length) { setError(t('grn.err.fix', { n: bad.length })); return; }
    setSaving(submit ? 'submit' : 'draft');
    try {
      const doc = await invApi.returnFromIssues({
        submit,
        values: { ...(node ? { location: node } : {}), ...(returnedBy.trim() ? { returned_by: returnedBy.trim() } : {}) },
        lines: chosen.map(c => ({ issueLineId: c.id, qty: dec.norm(c.qty), status: c.status, ...(node ? { location: node } : {}), ...(c.reason.trim() ? { reason: c.reason.trim() } : {}) })),
      });
      void qc.invalidateQueries({ queryKey: stockKeys.inventory });
      void qc.invalidateQueries({ queryKey: docKeys.all('store_return') });
      toast.success(t('return.created'));
      router.push(`/docs/store_return/${doc.id}`);
    } catch (e) {
      const se = stockError(e);
      setError(se.message);
      setLineErr(se.ref ? { ref: se.ref, message: se.message } : null);
      setSaving(null);
    }
  };

  return (
    <PageBody>
      <PageHeader
        back={<Link href="/docs/store_return" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('return.back')}</Link>}
        title={t('return.title')}
        description={t('return.hint')}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-3">
          <SearchBox value={q} onChange={setQ} label={t('return.search')} testId="return-search" />
          {list.isLoading ? <Skeleton className="h-64 w-full" /> : list.isError ? <InlineAlert>{isApiError(list.error) ? list.error.message : t('stock.loadFailed')}</InlineAlert>
            : rows.length === 0 ? <EmptyState icon={<PackagePlus />} title={t('return.empty')} description={t('return.emptyHint')} /> : (
              <div className="space-y-3" data-testid="return-picker">
                {issues.map(g => (
                  <section key={g.id} className="overflow-hidden rounded-lg border border-border" aria-label={g.number ?? ''}>
                    <div className="border-b border-border bg-subtle px-3 py-2"><Link href={`/docs/store_issue/${g.id}`} className="font-semibold hover:underline">{g.number ?? '—'}</Link></div>
                    <ul className="divide-y divide-border">
                      {g.lines.map(l => {
                        const pk = picks[l.issueLineId];
                        const k = `${g.number ?? 'iss'}-${l.lineNo}`;
                        const prob = pk ? problem({ ...pk, line: l }) : null;
                        return (
                          <li key={l.issueLineId} className={cn('px-3 py-2.5', pk && 'bg-accent-soft/40')} data-testid={`return-line-${k}`}>
                            <div className="flex items-start gap-3">
                              <Checkbox className="mt-1" checked={!!pk} onCheckedChange={c => toggle(l, c === true)} aria-label={t('grn.pickLine', { item: l.item.name, n: l.lineNo })} data-testid={`return-pick-${k}`} />
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-medium">{l.item.name} <span className="font-normal text-fg-subtle">{l.item.code}</span></p>
                                <p className="text-sm text-fg-muted">{t('return.facts', { issued: fmtQty(l.issued), returned: fmtQty(l.returned) })}{l.batchNo ? ` · ${l.batchNo}` : ''}</p>
                              </div>
                              <p className="text-sm font-semibold tabular-nums">{t('rtv.returnable', { qty: fmtQty(l.returnable), uom: l.uom ?? '' })}</p>
                            </div>
                            {pk && (
                              <div className="mt-2 grid grid-cols-2 gap-2 pl-7 sm:grid-cols-[8rem_10rem_minmax(0,1fr)]">
                                <Input inputMode="decimal" className="h-8" value={pk.qty} onChange={e => set(l.issueLineId, { qty: e.target.value })} aria-label={t('return.qty')} aria-invalid={!!prob || undefined} data-testid={`return-qty-${k}`} />
                                <NativeSelect className="h-8" value={pk.status} onChange={e => set(l.issueLineId, { status: e.target.value as ReturnStatus })} aria-label={t('return.as')} data-testid={`return-status-${k}`}>
                                  <option value="available">{t('stock.status.available')}</option>
                                  <option value="quarantine">{t('stock.status.quarantine')}</option>
                                </NativeSelect>
                                <Input className="col-span-2 h-8 sm:col-span-1" value={pk.reason} maxLength={500} placeholder={t('common.reason')} onChange={e => set(l.issueLineId, { reason: e.target.value })} aria-label={t('common.reason')} />
                                {(prob || lineErr?.ref === l.issueLineId) && <p className="col-span-full text-sm text-danger" role="alert">{prob ?? lineErr?.message}</p>}
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
          <h2 className="font-semibold">{t('issue.preview')}</h2>
          <p className="text-sm text-fg-muted">{chosen.length ? t('return.willReturn', { n: chosen.length }) : t('return.previewEmpty')}</p>
          <FormField label={t('return.to')} hint={t('return.toHint')}>
            <LocationSelect value={node} onChange={setNode} allLabel={t('return.toIssueLocation')} label={t('return.to')} className="h-9 w-full" testId="return-to" />
          </FormField>
          <FormField label={t('return.returnedBy')}><Input value={returnedBy} maxLength={200} onChange={e => setReturnedBy(e.target.value)} /></FormField>
          {error && <p role="alert" className="text-sm text-danger" data-testid="return-error">{error}</p>}
          <Button className="w-full" variant="secondary" disabled={!chosen.length || !!saving} loading={saving === 'draft'} onClick={() => create(false)} data-testid="return-create">{t('return.create')}</Button>
          <Button className="w-full" disabled={!chosen.length || !!saving} loading={saving === 'submit'} onClick={() => create(true)} data-testid="return-create-submit">{t('issue.createSubmit')}</Button>
        </Card>
      </div>
    </PageBody>
  );
}

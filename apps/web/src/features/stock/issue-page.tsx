'use client';
import type { IssuableLine } from '@procure/schema';
import { Button, Card, Checkbox, cn, EmptyState, FormField, Input, Skeleton, toast } from '@procure/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, PackageMinus, Plus } from 'lucide-react';
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
import { BatchPicker, LocationSelect, SearchBox, useStockFlow } from './components';

interface Pick { qty: string; batchNo: string | undefined }

const min = (a: string, b: string) => (dec.cmp(a, b) <= 0 ? a : b);

/** Issue against approved issue-request lines (available stock shown at the issuing location); direct issue when allowed. */
export function IssuePage() {
  const qc = useQueryClient();
  const router = useRouter();
  const sp = useSearchParams();
  const flow = useStockFlow();
  const request = sp.get('request') ?? undefined;
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [node, setNode] = useState('');
  const [issuedTo, setIssuedTo] = useState('');
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null);
  const [lineErr, setLineErr] = useState<{ ref: string; message: string } | null>(null);

  const query = { node: node || undefined, request, q: dq || undefined };
  const list = useInfiniteQuery({
    queryKey: stockKeys.issuable(query),
    queryFn: ({ pageParam }) => invApi.issuable(query, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    retry: false,
  });
  const rows = useMemo(() => (list.data?.pages ?? []).flatMap(p => p.data), [list.data]);
  const byId = useMemo(() => new Map(rows.map(r => [r.requestLineId, r])), [rows]);
  const requests = useMemo(() => {
    const m = new Map<string, { id: string; number: string | null; location: IssuableLine['location']; by: string | null; lines: IssuableLine[] }>();
    for (const r of rows) { const g = m.get(r.requestId) ?? { id: r.requestId, number: r.requestNumber, location: r.location, by: r.requestedBy, lines: [] }; g.lines.push(r); m.set(r.requestId, g); }
    return [...m.values()];
  }, [rows]);

  const toggle = (l: IssuableLine, on: boolean) => setPicks(p => {
    const n = { ...p };
    if (on) n[l.requestLineId] = { qty: dec.norm(dec.gt0(l.available) ? min(l.pendingIssue, l.available) : l.pendingIssue), batchNo: undefined };
    else delete n[l.requestLineId];
    return n;
  });
  const set = (id: string, patch: Partial<Pick>) => setPicks(p => (p[id] ? { ...p, [id]: { ...p[id]!, ...patch } } : p));
  const chosen = Object.entries(picks).map(([id, pk]) => ({ id, ...pk, line: byId.get(id) })).filter((x): x is Pick & { id: string; line: IssuableLine } => !!x.line);
  const problem = (c: Pick & { line: IssuableLine }) => (!isDecimal(c.qty) || !dec.gt0(c.qty) ? t('stock.err.qty') : dec.cmp(c.qty, c.line.pendingIssue) > 0 ? t('issue.err.over', { qty: fmtQty(c.line.pendingIssue) }) : null);
  const bad = chosen.filter(c => problem(c));

  const create = async (submit: boolean) => {
    setError(null);
    if (bad.length) { setError(t('grn.err.fix', { n: bad.length })); return; }
    setSaving(submit ? 'submit' : 'draft');
    try {
      const doc = await invApi.issueFromRequests({
        submit,
        values: { ...(node ? { location: node } : {}), ...(issuedTo.trim() ? { issued_to: issuedTo.trim() } : {}) },
        lines: chosen.map(c => ({ requestLineId: c.id, qty: dec.norm(c.qty), ...(c.batchNo?.trim() ? { batchNo: c.batchNo.trim() } : {}), ...(node ? { location: node } : {}) })),
      });
      void qc.invalidateQueries({ queryKey: stockKeys.inventory });
      void qc.invalidateQueries({ queryKey: docKeys.all('store_issue') });
      toast.success(t('issue.created'));
      router.push(`/docs/store_issue/${doc.id}`);
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
        back={<Link href="/docs/store_issue" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('issue.back')}</Link>}
        title={t('issue.title')}
        description={t('issue.hint')}
        actions={flow.issueWithoutIndent ? <Button asChild variant="secondary"><Link href="/docs/store_issue/new" data-testid="issue-direct"><Plus aria-hidden />{t('issue.direct')}</Link></Button> : undefined}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchBox value={q} onChange={setQ} label={t('issue.search')} testId="issue-search" />
            <LocationSelect value={node} onChange={setNode} allLabel={t('issue.fromRequestLocation')} label={t('issue.from')} className="w-full sm:w-56" testId="issue-from" />
          </div>
          {list.isLoading ? <Skeleton className="h-64 w-full" /> : list.isError ? <InlineAlert>{isApiError(list.error) ? list.error.message : t('stock.loadFailed')}</InlineAlert>
            : rows.length === 0 ? <EmptyState icon={<PackageMinus />} title={t('issue.empty')} description={flow.issueWithoutIndent ? t('issue.emptyHintDirect') : t('issue.emptyHint')} /> : (
              <div className="space-y-3" data-testid="issue-picker">
                {requests.map(g => (
                  <section key={g.id} className="overflow-hidden rounded-lg border border-border" aria-label={g.number ?? ''}>
                    <div className="flex flex-wrap items-center gap-x-3 border-b border-border bg-subtle px-3 py-2">
                      <Link href={`/docs/issue_request/${g.id}`} className="font-semibold hover:underline">{g.number ?? '—'}</Link>
                      <span className="text-sm text-fg-muted">{g.location.name}{g.by ? ` · ${g.by}` : ''}</span>
                    </div>
                    <ul className="divide-y divide-border">
                      {g.lines.map(l => {
                        const pk = picks[l.requestLineId];
                        const k = `${g.number ?? 'ir'}-${l.lineNo}`;
                        const prob = pk ? problem({ ...pk, line: l }) : null;
                        const short = pk && isDecimal(pk.qty) && dec.cmp(pk.qty, l.available) > 0;
                        return (
                          <li key={l.requestLineId} className={cn('px-3 py-2.5', pk && 'bg-accent-soft/40')} data-testid={`issue-line-${k}`}>
                            <div className="flex items-start gap-3">
                              <Checkbox className="mt-1" checked={!!pk} onCheckedChange={c => toggle(l, c === true)} aria-label={t('grn.pickLine', { item: l.item.name, n: l.lineNo })} data-testid={`issue-pick-${k}`} />
                              <div className="min-w-0 flex-1">
                                <p className="truncate font-medium">{l.item.name} <span className="font-normal text-fg-subtle">{l.item.code}</span></p>
                                <p className="text-sm text-fg-muted">{t('issue.facts', { requested: fmtQty(l.requested), issued: fmtQty(l.issued) })}</p>
                              </div>
                              <dl className="flex gap-3 text-right text-xs text-fg-muted">
                                <div><dt>{t('issue.pending')}</dt><dd className="font-semibold tabular-nums text-fg">{fmtQty(l.pendingIssue)} {l.uom}</dd></div>
                                <div><dt>{t('stock.status.available')}</dt><dd className={cn('font-semibold tabular-nums', dec.cmp(l.available, l.pendingIssue) < 0 ? 'text-danger' : 'text-success')} data-testid={`issue-available-${k}`}>{fmtQty(l.available)}</dd></div>
                              </dl>
                            </div>
                            {pk && (
                              <div className="mt-2 grid grid-cols-2 gap-2 pl-7 sm:grid-cols-[8rem_16rem]">
                                <Input inputMode="decimal" className="h-8" value={pk.qty} onChange={e => set(l.requestLineId, { qty: e.target.value })} aria-label={t('issue.qty')} aria-invalid={!!prob || undefined} data-testid={`issue-qty-${k}`} />
                                <BatchPicker itemId={l.item.id} nodeId={node || l.location.id} qty={pk.qty} value={pk.batchNo} onChange={v => set(l.requestLineId, { batchNo: v })} label={t('stock.col.batch')} testId={`issue-batch-${k}`} />
                                {(prob || lineErr?.ref === l.requestLineId) && <p className="col-span-full text-sm text-danger" role="alert">{prob ?? lineErr?.message}</p>}
                                {!prob && short && <p className="col-span-full flex items-center gap-1.5 text-sm text-warning"><AlertTriangle className="size-4" aria-hidden />{t('issue.warn.short', { qty: fmtQty(l.available) })}</p>}
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
          <p className="text-sm text-fg-muted">{chosen.length ? t('issue.willIssue', { n: chosen.length }) : t('issue.previewEmpty')}</p>
          <FormField label={t('issue.issuedTo')}><Input value={issuedTo} maxLength={200} onChange={e => setIssuedTo(e.target.value)} data-testid="issue-issued-to" /></FormField>
          {error && <p role="alert" className="text-sm text-danger" data-testid="issue-error">{error}</p>}
          <Button className="w-full" variant="secondary" disabled={!chosen.length || !!saving} loading={saving === 'draft'} onClick={() => create(false)} data-testid="issue-create">{t('issue.create')}</Button>
          <Button className="w-full" disabled={!chosen.length || !!saving} loading={saving === 'submit'} onClick={() => create(true)} data-testid="issue-create-submit">{t('issue.createSubmit')}</Button>
          <p className="text-xs text-fg-subtle">{t('issue.note')}</p>
          {request && <p className="text-xs"><Link className="text-accent hover:underline" href="/stock/issue">{t('issue.allRequests')}</Link></p>}
        </Card>
      </div>
    </PageBody>
  );
}

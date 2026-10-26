'use client';
import type { DocumentLineRow, DocumentRow } from '@procure/schema';
import { Badge, Button, cn, EmptyState, Input, Segmented, Skeleton, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ClipboardCheck, FileX2, Save, Send } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { docKeys, docsApi } from '@/features/documents/api';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { refLabel } from '@/features/documents/form-model';
import { DocStatusBadge } from '@/features/documents/status';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { stockError } from './api';
import { SearchBox } from './components';

type Filter = 'all' | 'uncounted' | 'diff';
const TYPE = 'stock_count';

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Count sheet for a stock_count document: book qty (frozen by the snapshot) vs counted, with differences highlighted. */
export function CountSheetPage({ id }: { id: string }) {
  const q = useQuery({ queryKey: docKeys.detail(TYPE, id), queryFn: () => docsApi.get(TYPE, id), retry: false });
  if (q.isLoading) return <PageBody><Skeleton className="mb-4 h-8 w-64" /><Skeleton className="h-96 w-full" /></PageBody>;
  if (q.isError || !q.data) {
    return (
      <PageBody>
        <EmptyState icon={<FileX2 />} title={t('stock.count.notFound')} description={isApiError(q.error) ? q.error.message : undefined}
          action={<Button asChild variant="secondary"><Link href="/docs/stock_count">{t('stock.count.backToList')}</Link></Button>} />
      </PageBody>
    );
  }
  return <Sheet key={`${q.data.id}:${q.data.version}`} doc={q.data} />;
}

function Sheet({ doc }: { doc: DocumentRow }) {
  const qc = useQueryClient();
  const editable = doc.allowedActions.includes('edit');
  const canSubmit = doc.allowedActions.includes('submit');
  const [counted, setCounted] = useState<Record<string, string>>(() => Object.fromEntries(doc.lines.map(l => [l.id, str(l.values.counted_qty) ? dec.norm(l.values.counted_qty) : ''])));
  const [remarks, setRemarks] = useState<Record<string, string>>(() => Object.fromEntries(doc.lines.map(l => [l.id, str(l.values.remarks)])));
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<number, string>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const diffOf = (l: DocumentLineRow): string | null => {
    const c = counted[l.id] ?? '';
    return isDecimal(c) ? dec.sub(c, l.values.book_qty ?? '0') : null;
  };
  const stats = useMemo(() => {
    let done = 0; let diffs = 0;
    for (const l of doc.lines) {
      const c = counted[l.id] ?? '';
      if (isDecimal(c)) { done++; if (!dec.isZero(dec.sub(c, l.values.book_qty ?? '0'))) diffs++; }
    }
    return { done, diffs, total: doc.lines.length };
  }, [counted, doc.lines]);

  const rows = doc.lines.filter(l => {
    const c = counted[l.id] ?? '';
    if (filter === 'uncounted' && isDecimal(c)) return false;
    if (filter === 'diff') { const d = diffOf(l); if (d === null || dec.isZero(d)) return false; }
    if (search.trim()) {
      const hay = `${refLabel(l.refs, 'item', l.values.item) ?? ''} ${str(l.values.batch)} ${refLabel(l.refs, 'location', l.values.location) ?? ''}`.toLowerCase();
      if (!hay.includes(search.trim().toLowerCase())) return false;
    }
    return true;
  });

  const invalid = doc.lines.filter(l => (counted[l.id] ?? '') !== '' && !isDecimal(counted[l.id]!));

  const save = async (andSubmit: boolean) => {
    setError(null);
    setServerErrors({});
    if (invalid.length) { setError(t('stock.count.invalid', { n: invalid.length })); return; }
    if (andSubmit && stats.done < stats.total) { setError(t('stock.count.incomplete', { n: stats.total - stats.done })); setFilter('uncounted'); return; }
    setBusy(andSubmit ? 'submit' : 'save');
    try {
      let next = doc;
      if (dirty || andSubmit) {
        next = await docsApi.update(TYPE, doc.id, {
          version: doc.version,
          values: doc.values,
          lines: doc.lines.map(l => ({ id: l.id, values: { ...l.values, counted_qty: counted[l.id] ? dec.norm(counted[l.id]) : null, remarks: remarks[l.id] || null } })),
        });
      }
      if (andSubmit) next = await docsApi.submit(TYPE, doc.id, next.version);
      setDirty(false);
      qc.setQueryData(docKeys.detail(TYPE, doc.id), next);
      void qc.invalidateQueries({ queryKey: docKeys.all(TYPE) });
      toast.success(andSubmit ? t('stock.count.submitted') : t('stock.count.saved'));
    } catch (e) {
      if (isApiError(e)) {
        const per: Record<number, string> = {};
        for (const fe of e.errors) { const m = /^lines\.(\d+)\./.exec(fe.path); if (m) per[Number(m[1])] = fe.message; }
        setServerErrors(per);
        setError(stockError(e).message);
      } else setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const fillBook = () => {
    setCounted(c => Object.fromEntries(doc.lines.map(l => [l.id, c[l.id] || dec.norm(l.values.book_qty ?? '0')])));
    setDirty(true);
  };

  return (
    <PageBody>
      <PageHeader
        back={<Link href={`/docs/${TYPE}/${doc.id}`} className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('stock.count.openDoc')}</Link>}
        title={<span className="flex items-center gap-2">{t('stock.count.sheetTitle', { number: doc.number ?? t('stock.count.draft') })}<DocStatusBadge statusKey={doc.statusKey} label={doc.statusLabel} /></span>}
        description={`${refLabel(doc.refs, 'location', doc.values.location) ?? ''} · ${t('stock.count.progress', { done: stats.done, total: stats.total, diffs: stats.diffs })}`}
        actions={editable ? (
          <>
            <Button variant="secondary" onClick={fillBook} data-testid="count-fill-book">{t('stock.count.fillBook')}</Button>
            <Button variant="secondary" onClick={() => save(false)} loading={busy === 'save'} disabled={!!busy} data-testid="count-save"><Save aria-hidden />{t('common.saveChanges')}</Button>
            {canSubmit && <Button onClick={() => save(true)} loading={busy === 'submit'} disabled={!!busy} data-testid="count-submit"><Send aria-hidden />{t('stock.count.submit')}</Button>}
          </>
        ) : undefined}
      />
      {!editable && <InlineAlert tone="info" className="mb-3">{t('stock.count.readOnly')}</InlineAlert>}
      {error && <InlineAlert className="mb-3" data-testid="count-error">{error}</InlineAlert>}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox value={search} onChange={setSearch} label={t('stock.count.search')} testId="count-search" />
        <Segmented<Filter> label={t('stock.count.filter')} value={filter} onChange={setFilter} data-testid="count-filter"
          options={[{ value: 'all', label: t('stock.count.all', { n: stats.total }) }, { value: 'uncounted', label: t('stock.count.uncounted', { n: stats.total - stats.done }) }, { value: 'diff', label: t('stock.count.diffs', { n: stats.diffs }) }]} />
      </div>

      {rows.length === 0 ? <EmptyState icon={<ClipboardCheck />} title={t('stock.count.noneMatch')} /> : (
        // QA5-BUG-009: below md the rows render as stacked cards (one DOM, CSS only) so the Counted input is on screen at
        // 390 px; from md up it is the usual table.
        <div className="rounded-lg border border-border md:overflow-x-auto" data-testid="count-sheet">
          <table className="block w-full text-sm md:table md:min-w-[44rem]">
            <caption className="sr-only">{t('stock.count.sheetCaption')}</caption>
            <thead className="hidden bg-subtle text-left text-xs text-fg-muted md:table-header-group">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">#</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('stock.col.item')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('stock.col.location')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('stock.col.batch')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('stock.count.book')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('stock.count.counted')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('stock.count.difference')}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t('stock.count.remarks')}</th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border md:table-row-group">
              {rows.map(l => {
                const d = diffOf(l);
                const idx = doc.lines.indexOf(l);
                const bad = (counted[l.id] ?? '') !== '' && !isDecimal(counted[l.id]!);
                const item = refLabel(l.refs, 'item', l.values.item) ?? '—';
                const uom = refLabel(l.refs, 'uom', l.values.uom);
                const tone = d === null ? null : dec.isZero(d) ? 'ok' : dec.cmp(d, '0') < 0 ? 'short' : 'excess';
                return (
                  <tr key={l.id} className={cn('grid grid-cols-2 gap-x-3 gap-y-1.5 p-3 md:table-row md:p-0', tone === 'short' && 'bg-danger-soft/40', tone === 'excess' && 'bg-warning-soft/40')}
                    data-testid={`count-line-${l.lineNo}`} data-diff={d ?? ''}>
                    <td className="hidden px-3 py-2 tabular-nums text-fg-subtle md:table-cell">{l.lineNo}</td>
                    <td className="col-span-2 font-medium md:max-w-64 md:px-3 md:py-2 md:font-normal">
                      <span className="mr-1 tabular-nums text-fg-subtle md:hidden">{l.lineNo}.</span><span className="md:line-clamp-2">{item}</span>
                    </td>
                    <td className="text-xs text-fg-muted md:px-3 md:py-2 md:text-sm">{refLabel(l.refs, 'location', l.values.location) ?? '—'}</td>
                    <td className="text-xs text-fg-muted md:px-3 md:py-2 md:text-sm">
                      <span className="md:hidden">{t('stock.col.batch')}: </span>{str(l.values.batch) || '—'}
                    </td>
                    <td className="self-center tabular-nums md:px-3 md:py-2 md:text-right" data-testid={`count-book-${l.lineNo}`}>
                      <span className="mr-1 text-xs text-fg-muted md:hidden">{t('stock.count.book')}</span>
                      {fmtQty(l.values.book_qty ?? '0')}{uom && <span className="ml-1 text-xs text-fg-subtle">{uom}</span>}
                    </td>
                    <td className="text-right md:px-3 md:py-2">
                      <span className="block text-xs text-fg-muted md:hidden" aria-hidden>{t('stock.count.counted')}</span>
                      {editable ? (
                        <Input inputMode="decimal" className="ml-auto h-8 w-28 text-right" value={counted[l.id] ?? ''} aria-label={t('stock.count.countedFor', { item })}
                          aria-invalid={bad || !!serverErrors[idx] || undefined} onChange={e => { setCounted(c => ({ ...c, [l.id]: e.target.value })); setDirty(true); }}
                          data-testid={`count-qty-${l.lineNo}`} />
                      ) : <span className="tabular-nums">{counted[l.id] ? fmtQty(counted[l.id]) : '—'}</span>}
                      {(bad || serverErrors[idx]) && <span className="block text-xs text-danger">{serverErrors[idx] ?? t('stock.err.qty')}</span>}
                    </td>
                    <td className="self-center tabular-nums md:px-3 md:py-2 md:text-right" data-testid={`count-diff-${l.lineNo}`}>
                      <span className="mr-1 text-xs text-fg-muted md:hidden">{t('stock.count.difference')}</span>
                      {d === null ? <span className="text-fg-subtle">—</span> : tone === 'ok' ? <Badge tone="success">{t('stock.count.match')}</Badge> : (
                        <span className={cn('font-semibold', tone === 'short' ? 'text-danger' : 'text-warning')}>{dec.cmp(d, '0') > 0 ? '+' : ''}{fmtQty(d)}</span>
                      )}
                    </td>
                    <td className="md:px-3 md:py-2">
                      {editable ? <Input className="h-8 w-full md:min-w-36" value={remarks[l.id] ?? ''} maxLength={500} aria-label={t('stock.count.remarksFor', { item })} onChange={e => { setRemarks(r => ({ ...r, [l.id]: e.target.value })); setDirty(true); }} />
                        : <span className="text-fg-muted">{remarks[l.id] || '—'}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PageBody>
  );
}

'use client';
import { Button, Card, CardBody, Skeleton } from '@procure/ui';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, Copy, Pencil } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { ExportMenu } from '@/features/exports/use-export';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useTenantPrincipal } from '@/lib/session';
import { REPORT_PERMS, reportKeys, reportsApi, useCanBuild, useReport, useSources } from './api';
import { chartModel } from './chart-data';
import { initialParams, missingRequired, paramsOf, paramsToSearch } from './params';
import { ParamBar, PERIOD_KEY } from './param-bar';
import { ReportChart } from './report-chart';
import { bucketOf } from './reports-home';
import { ResultsTable } from './results-table';
import { ScheduleDialog } from './schedule-dialog';
import type { ReportResult } from './types';

const PAGE = 200;

/** Merge cursor pages of a detail report into one result. */
function merge(pages: ReportResult[] | undefined): ReportResult | undefined {
  if (!pages?.length) return undefined;
  const [first, ...rest] = pages;
  if (!rest.length) return first;
  const last = pages[pages.length - 1]!;
  return {
    ...first!,
    rows: pages.flatMap(p => p.rows),
    links: first!.links ? pages.flatMap(p => p.links ?? p.rows.map(() => null)) : undefined,
    nextCursor: last.nextCursor,
    truncated: last.truncated,
  };
}

export function ReportViewer({ id }: { id: string }) {
  const report = useReport(id);
  const sources = useSources();
  const p = usePermissions();
  const me = useTenantPrincipal();
  const canBuild = useCanBuild();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const def = report.data?.definition;
  const catalogue = useMemo(() => sources.data?.find(s => def && s.source.kind === def.source.kind && s.source.key === def.source.key), [sources.data, def]);
  const params = useMemo(() => {
    if (!def) return [];
    const list = paramsOf(def, catalogue?.fields);
    // A definition-level period can be overridden per run (`params.datePreset`, resolved by the server).
    if (def.datePreset !== 'none' && !list.some(p => p.key === PERIOD_KEY)) {
      list.unshift({ key: PERIOD_KEY, label: t('report.param.period'), required: false, field: '', op: 'eq', type: 'text', default: def.datePreset });
    }
    return list;
  }, [def, catalogue]);
  const defaults = useMemo(() => initialParams(params, null), [params]);

  // Draft values in the bar; applied values (in the URL) drive the query.
  const applied = useMemo(() => initialParams(params, new URLSearchParams(sp.toString())), [params, sp]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  useEffect(() => { setDraft(applied); }, [applied]);
  const missing = missingRequired(params, applied);

  const run = useInfiniteQuery({
    queryKey: reportKeys.run(id, applied),
    queryFn: ({ pageParam }) => reportsApi.run(id, { params: applied, page: { cursor: pageParam ?? undefined, limit: PAGE } }),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
    enabled: !!def && missing.length === 0,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const result = useMemo(() => merge(run.data?.pages), [run.data]);
  const model = useMemo(() => (def ? chartModel(result, def) : null), [result, def]);

  const apply = useCallback(() => {
    const next = new URLSearchParams(sp.toString());
    for (const k of [...next.keys()]) if (k.startsWith('p.')) next.delete(k);
    for (const [k, v] of Object.entries(paramsToSearch(draft))) next.set(k, v);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    if (JSON.stringify(draft) === JSON.stringify(applied)) void run.refetch();
  }, [sp, draft, applied, router, pathname, run]);

  if (report.isLoading) {
    return <PageBody><Skeleton className="mb-2 h-7 w-72" /><Skeleton className="mb-6 h-4 w-96" /><Skeleton className="mb-4 h-16" /><Skeleton className="h-80" /></PageBody>;
  }
  if (report.isError || !report.data || !def) {
    return (
      <PageBody>
        <InlineAlert data-testid="report-load-error">{isApiError(report.error) ? report.error.message : t('report.loadError')}</InlineAlert>
        <Button asChild variant="link" className="mt-3"><Link href="/reports">{t('report.backToReports')}</Link></Button>
      </PageBody>
    );
  }
  const r = report.data;
  const mine = r.canEdit ?? bucketOf(r, me?.userId) === 'mine';
  const runError = run.error;

  return (
    <PageBody className="max-w-[90rem]">
      <PageHeader
        back={<Link href="/reports" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('report.backToReports')}</Link>}
        title={<span data-testid="report-title">{r.name}</span>}
        description={r.description || catalogue?.label}
        actions={(
          <>
            {canBuild && (mine
              ? <Button asChild variant="ghost" size="sm"><Link href={`/reports/${r.id}/edit`} data-testid="report-edit-link"><Pencil aria-hidden />{t('common.edit')}</Link></Button>
              : <Button asChild variant="ghost" size="sm"><Link href={`/reports/new?from=${r.id}`} data-testid="report-copy-link"><Copy aria-hidden />{t('report.copyToEdit')}</Link></Button>)}
            {p.has(REPORT_PERMS.schedule) && <Button variant="secondary" size="sm" onClick={() => setScheduleOpen(true)} data-testid="report-schedule"><CalendarClock aria-hidden />{t('report.schedule.button')}</Button>}
            {p.hasAny(REPORT_PERMS.export, REPORT_PERMS.view) && (
              <ExportMenu name={r.name} disabled={missing.length > 0} build={format => ({ kind: 'report', source: { reportId: r.id, params: applied }, format })} />
            )}
          </>
        )}
      />

      {params.length > 0 && (
        <ParamBar params={params} values={draft} onChange={(k, v) => setDraft(d => ({ ...d, [k]: v }))} onRun={apply}
          onReset={() => setDraft(defaults)} running={run.isFetching && !run.isFetchingNextPage} dirty={JSON.stringify(draft) !== JSON.stringify(defaults)} missing={missing} />
      )}

      {runError && <InlineAlert className="mb-4" data-testid="report-run-error">{isApiError(runError) ? runError.message : t('report.runError')}</InlineAlert>}
      {missing.length > 0 && params.length === 0 && <InlineAlert tone="info" className="mb-4">{t('report.params.missing', { list: missing.join(', ') })}</InlineAlert>}

      {def.chart && (
        <Card className="mb-4" data-testid="report-chart" data-chart-type={def.chart.type}>
          <CardBody className={run.isFetching && result ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            {model && model.categories.length > 0 ? (
              <ReportChart model={model} height={def.chart.type === 'pie' ? 280 : 300} />
            ) : run.isLoading ? <Skeleton className="h-[300px]" /> : (
              <p className="py-10 text-center text-fg-muted">{t('report.chart.noData')}</p>
            )}
          </CardBody>
        </Card>
      )}

      <div className="mb-2 flex items-center justify-between gap-3 text-sm text-fg-muted">
        <span data-testid="report-row-count">{result ? t('report.rowCount', { n: result.rows.length }) : ' '}</span>
        {(def.groupBy ?? []).length >= 2 && result && result.rows.length > 0 && <span>{t('report.groupHint')}</span>}
      </div>
      <ResultsTable result={result} def={def} loading={run.isLoading} caption={r.name} dim={run.isFetching && !run.isFetchingNextPage && !!result} />
      {run.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => void run.fetchNextPage()} loading={run.isFetchingNextPage} data-testid="report-load-more">{t('report.loadMore')}</Button>
        </div>
      )}

      {scheduleOpen && <ScheduleDialog open={scheduleOpen} onOpenChange={setScheduleOpen} reportId={r.id} reportName={r.name} params={applied} />}
    </PageBody>
  );
}

'use client';
import { Button, EmptyState, Skeleton, StatusBadge, type BadgeTone } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Clock, Download, FileDown, Loader2, TimerOff } from 'lucide-react';
import Link from 'next/link';
import { fileHref } from '@/components/file-upload';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { fmtDateTime, fmtRelative, fmtNumber } from '@/lib/format';
import { exportsApi, reportKeys } from '@/features/reports/api';
import type { ExportJob, ExportStatus } from '@/features/reports/types';
import { exportName, FORMAT_ICON } from './use-export';

const EXPIRY_DAYS = 7;
const tone: Record<ExportStatus, BadgeTone> = { queued: 'neutral', running: 'accent', ready: 'success', failed: 'danger', expired: 'neutral' };
const icon = { queued: Clock, running: Loader2, ready: CheckCircle2, failed: AlertCircle, expired: TimerOff } as const;

function expiresAt(j: ExportJob): string | null {
  if (j.expiresAt) return j.expiresAt;
  const base = j.finishedAt ?? j.createdAt;
  return base ? new Date(new Date(base).getTime() + EXPIRY_DAYS * 86400_000).toISOString() : null;
}

function StatusChip({ status }: { status: ExportStatus }) {
  const Icon = icon[status] ?? Clock;
  return (
    <StatusBadge tone={tone[status] ?? 'neutral'} data-testid="export-status" data-status={status}>
      <Icon className={status === 'running' ? 'size-3.5 animate-spin motion-reduce:animate-none' : 'size-3.5'} aria-hidden />
      {t(`export.status.${status}` as 'export.status.ready')}
    </StatusBadge>
  );
}

/** /exports: the user's export jobs, newest first. Polls while any job is queued or running. */
export function ExportsPage() {
  const jobs = useQuery({
    queryKey: reportKeys.exports,
    queryFn: exportsApi.list,
    refetchInterval: q => ((q.state.data ?? []).some(j => j.status === 'queued' || j.status === 'running') ? 2500 : false),
    retry: false,
  });
  const list = jobs.data ?? [];
  return (
    <PageBody>
      <PageHeader title={t('export.page.title')} description={t('export.page.subtitle', { days: EXPIRY_DAYS })} actions={<Button asChild variant="secondary" size="sm"><Link href="/reports">{t('export.page.toReports')}</Link></Button>} />
      {jobs.isLoading ? (
        <div className="space-y-2" aria-busy="true">{[0, 1, 2].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : jobs.isError ? (
        <div role="alert" className="flex flex-col items-center gap-2 rounded-lg border border-border py-10 text-center">
          <p className="text-fg-muted">{t('export.page.error')}</p>
          <Button variant="secondary" size="sm" onClick={() => void jobs.refetch()}>{t('common.retry')}</Button>
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState icon={<FileDown />} title={t('export.page.empty')} description={t('export.page.emptyBody')} action={<Button asChild size="sm"><Link href="/reports">{t('export.page.toReports')}</Link></Button>} />
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface" data-testid="export-list">
          {list.map(j => {
            const Icon = FORMAT_ICON[j.format as keyof typeof FORMAT_ICON] ?? FileDown;
            const exp = expiresAt(j);
            const expired = j.status === 'expired' || (j.status === 'ready' && exp !== null && new Date(exp).getTime() < Date.now());
            const status: ExportStatus = expired ? 'expired' : j.status;
            return (
              <li key={j.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center" data-testid={`export-row-${j.id}`} data-status={status}>
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded bg-subtle text-fg-muted"><Icon className="size-4" aria-hidden /></span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{j.name || exportName(j.id) || t(`export.kind.${j.kind}` as 'export.kind.report')} <span className="font-normal uppercase text-fg-subtle">{j.format}</span></p>
                    <p className="text-sm text-fg-muted">
                      <time dateTime={j.createdAt} title={fmtDateTime(j.createdAt)}>{t('export.requested', { when: fmtRelative(j.createdAt) })}</time>
                      {j.rowCount != null && <> · {t('export.rows', { n: fmtNumber(j.rowCount) })}</>}
                      {status === 'ready' && exp && <> · <span data-testid="export-expiry">{t('export.expires', { when: fmtRelative(exp) })}</span></>}
                    </p>
                    {j.status === 'failed' && j.error && <p className="mt-1 text-sm text-danger" data-testid="export-error">{j.error}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-3 sm:justify-end">
                  <StatusChip status={status} />
                  {status === 'ready' && j.fileUrl ? (
                    <Button asChild size="sm" variant="secondary">
                      <a href={fileHref(j.fileUrl)} data-testid="export-download"><Download aria-hidden />{t('export.download')}</a>
                    </Button>
                  ) : (
                    <span className="hidden w-[7.5rem] sm:block" aria-hidden />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </PageBody>
  );
}

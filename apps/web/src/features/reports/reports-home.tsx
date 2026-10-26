'use client';
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Input, Segmented, Skeleton, toast,
} from '@procure/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AreaChart, BarChart3, ChartColumnStacked, ChartLine, ChartPie, Copy, FileBarChart2, MoreHorizontal, Pencil, Play, Plus, Search, Table2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import { useTenantPrincipal } from '@/lib/session';
import { reportKeys, reportsApi, useCanBuild, useReports, useSources } from './api';
import type { ReportRow } from './types';

type Bucket = 'all' | 'builtin' | 'mine' | 'shared';

export const chartIcon = { bar: BarChart3, stacked_bar: ChartColumnStacked, line: ChartLine, area: AreaChart, pie: ChartPie } as const;

export function bucketOf(r: ReportRow, userId: string | undefined): Exclude<Bucket, 'all'> {
  if (r.kind === 'builtin') return 'builtin';
  if (r.isMine !== undefined) return r.isMine ? 'mine' : 'shared';
  if (r.ownerUserId && (r.ownerUserId === userId || r.ownerUserId === 'me')) return 'mine';
  return 'shared';
}

export function ReportsHome() {
  const me = useTenantPrincipal();
  const reports = useReports();
  const sources = useSources();
  const canBuild = useCanBuild();
  const router = useRouter();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [bucket, setBucket] = useState<Bucket>('all');
  const [toDelete, setToDelete] = useState<ReportRow | null>(null);

  const sourceLabel = useMemo(() => {
    const m = new Map((sources.data ?? []).map(s => [`${s.source.kind}:${s.source.key}`, s.label]));
    return (r: ReportRow) => m.get(`${r.definition.source.kind}:${r.definition.source.key}`) ?? r.definition.source.key;
  }, [sources.data]);

  const all = reports.data ?? [];
  const counts = useMemo(() => {
    const c = { all: all.length, builtin: 0, mine: 0, shared: 0 };
    for (const r of all) c[bucketOf(r, me?.userId)]++;
    return c;
  }, [all, me?.userId]);
  const needle = q.trim().toLowerCase();
  const filtered = all.filter(r => (bucket === 'all' || bucketOf(r, me?.userId) === bucket)
    && (!needle || r.name.toLowerCase().includes(needle) || (r.description ?? '').toLowerCase().includes(needle) || sourceLabel(r).toLowerCase().includes(needle)));
  const sections: { key: Exclude<Bucket, 'all'>; rows: ReportRow[] }[] = (['mine', 'shared', 'builtin'] as const)
    .map(key => ({ key, rows: filtered.filter(r => bucketOf(r, me?.userId) === key) }))
    .filter(s => s.rows.length);

  const del = useMutation({
    mutationFn: (id: string) => reportsApi.remove(id),
    onSuccess: () => { toast.success(t('report.deleted')); void qc.invalidateQueries({ queryKey: reportKeys.list }); },
  });

  return (
    <PageBody>
      <PageHeader
        title={t('report.home.title')}
        description={t('report.home.subtitle')}
        actions={(
          <>
            <Button asChild variant="ghost" size="sm"><Link href="/exports" data-testid="report-exports-link">{t('report.home.exports')}</Link></Button>
            {canBuild && <Button asChild size="sm"><Link href="/reports/new" data-testid="report-new"><Plus aria-hidden />{t('report.home.new')}</Link></Button>}
          </>
        )}
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:w-80">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t('report.home.search')} aria-label={t('report.home.search')} className="pl-8" data-testid="report-search" />
        </div>
        <div className="overflow-x-auto">
          <Segmented<Bucket>
            label={t('report.home.filter')}
            value={bucket}
            onChange={setBucket}
            data-testid="report-filter"
            options={(['all', 'mine', 'shared', 'builtin'] as const).map(b => ({ value: b, label: <span className="whitespace-nowrap">{t(`report.bucket.${b}` as 'report.bucket.all')} <span className="tabular-nums text-fg-subtle">{counts[b]}</span></span> }))}
          />
        </div>
      </div>

      {reports.isLoading ? (
        <div className="space-y-2" aria-busy="true">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : reports.isError ? (
        <div role="alert" className="flex flex-col items-center gap-2 rounded-lg border border-border py-10 text-center">
          <p className="text-fg-muted">{isApiError(reports.error) ? reports.error.message : t('report.loadError')}</p>
          <Button variant="secondary" size="sm" onClick={() => void reports.refetch()}>{t('common.retry')}</Button>
        </div>
      ) : sections.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState icon={<FileBarChart2 />} title={needle ? t('report.home.noMatch') : t('report.home.empty')} description={needle ? undefined : t('report.home.emptyBody')}
            action={canBuild && !needle ? <Button asChild size="sm"><Link href="/reports/new">{t('report.home.new')}</Link></Button> : undefined} />
        </div>
      ) : (
        <div className="space-y-6" data-testid="report-list">
          {sections.map(s => (
            <section key={s.key} aria-labelledby={`rs-${s.key}`}>
              <h2 id={`rs-${s.key}`} className="mb-2 text-sm font-medium text-fg-muted">{t(`report.section.${s.key}` as 'report.section.mine')}</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
                {s.rows.map(r => {
                  const Icon = r.definition.chart ? chartIcon[r.definition.chart.type] : Table2;
                  const mine = s.key === 'mine';
                  const editable = r.canEdit ?? mine;
                  return (
                    <li key={r.id} className="group flex items-center gap-3 px-4 py-3 hover:bg-subtle/60" data-testid={`report-row-${r.key}`}>
                      <span className="grid size-9 shrink-0 place-items-center rounded bg-accent-soft text-accent"><Icon className="size-4" aria-hidden /></span>
                      <Link href={`/reports/${r.id}`} className="min-w-0 flex-1 focus-visible:outline-none" data-testid={`report-open-${r.key}`}>
                        <span className="block truncate font-medium group-hover:text-accent">{r.name}</span>
                        <span className="block truncate text-sm text-fg-muted">
                          {sourceLabel(r)}
                          {r.description ? ` · ${r.description}` : ''}
                          {s.key === 'shared' && r.ownerName ? ` · ${t('report.by', { name: r.ownerName })}` : ''}
                          {mine && r.updatedAt ? ` · ${t('report.updated', { when: fmtRelative(r.updatedAt) })}` : ''}
                        </span>
                      </Link>
                      <Button asChild variant="secondary" size="sm" className="hidden sm:inline-flex"><Link href={`/reports/${r.id}`} data-testid={`report-run-${r.key}`}><Play aria-hidden />{t('report.run')}</Link></Button>
                      {canBuild && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={t('report.more', { name: r.name })} data-testid={`report-menu-${r.key}`}><MoreHorizontal aria-hidden /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            {editable && <DropdownMenuItem onSelect={() => router.push(`/reports/${r.id}/edit`)} data-testid="report-edit"><Pencil className="size-4" aria-hidden />{t('common.edit')}</DropdownMenuItem>}
                            <DropdownMenuItem onSelect={() => router.push(`/reports/new?from=${r.id}`)} data-testid="report-copy"><Copy className="size-4" aria-hidden />{t('report.copy')}</DropdownMenuItem>
                            {editable && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem destructive onSelect={() => setToDelete(r)} data-testid="report-delete"><Trash2 className="size-4" aria-hidden />{t('report.delete')}</DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      <ConfirmDialog
        testId="confirm-report-delete"
        open={!!toDelete}
        onOpenChange={o => { if (!o) setToDelete(null); }}
        title={t('report.deleteTitle', { name: toDelete?.name ?? '' })}
        description={t('report.deleteBody')}
        confirmLabel={t('report.delete')}
        tone="danger"
        onConfirm={async () => { if (toDelete) await del.mutateAsync(toDelete.id); }}
      />
    </PageBody>
  );
}

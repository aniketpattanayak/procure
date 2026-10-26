'use client';
import { Card, cn, Skeleton } from '@procure/ui';
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ApprovalsWidget } from '@/features/approvals/inbox-widget';
import { useDocTypes } from '@/features/documents/api';
import { useReport } from '@/features/reports/api';
import { chartModel } from '@/features/reports/chart-data';
import { effectiveFormat, formatCompact, formatValue, isNumericType } from '@/features/reports/format';
import { ReportChart } from '@/features/reports/report-chart';
import type { DashboardWidget, DocTypeCounts, ReportResult, WidgetData } from '@/features/reports/types';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { GAP_PX, ROW_PX } from './grid';
import { useWidgetData } from './use-widget-data';

const HEADER_PX = 49;

export function WidgetFrame({ widget, children, action, className }: { widget: DashboardWidget; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <Card className={cn('flex h-full min-h-0 flex-col', className)} data-testid={`widget-${widget.id}`} data-widget-type={widget.type}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="truncate font-semibold">{widget.title || t(`dash.type.${widget.type}` as 'dash.type.kpi')}</h2>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
    </Card>
  );
}

function OpenLink({ href, label }: { href: string; label?: string }) {
  return <Link href={href} className="shrink-0 text-sm text-accent hover:underline">{label ?? t('dash.open')}</Link>;
}

function WidgetError({ error }: { error: unknown }) {
  return <p className="text-sm text-fg-muted" role="alert" data-testid="widget-error">{isApiError(error) ? error.message : t('dash.widgetError')}</p>;
}

function WidgetSkeleton({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-2" aria-busy="true" aria-label={t('common.loading')}>{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className={i === 0 ? 'h-8 w-1/2' : 'h-4'} />)}</div>;
}

function KpiBody({ data, href }: { data: Extract<WidgetData, { type: 'kpi' }>; href?: string }) {
  const fmt = effectiveFormat(data.format, data.valueType ?? 'number');
  // Percent change vs the previous period (server `deltaPct`, else derived from delta / previous).
  const delta = data.deltaPct ?? (data.delta != null && data.previous ? (data.delta / Math.abs(data.previous)) * 100 : null);
  const DeltaIcon = delta === null || delta === 0 ? ArrowRight : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const value = data.value === null ? '—' : Math.abs(data.value) >= 100_000 ? formatCompact(data.value, fmt) : formatValue(data.value, fmt);
  const body = (
    <>
      <span className="block text-3xl font-semibold leading-tight group-hover:text-accent" data-testid="widget-kpi-value" title={data.value === null ? undefined : formatValue(data.value, fmt)}>{value}</span>
      {delta === null && data.label && <span className="mt-1 block text-sm text-fg-muted" data-testid="widget-kpi-label">{data.label}</span>}
      {delta !== null && (
        <span className="mt-1 flex items-center gap-1 text-sm text-fg-muted" data-testid="widget-kpi-delta">
          <DeltaIcon className="size-4" aria-hidden />
          <span className="font-medium text-fg">{`${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`}</span>
          {t('dash.kpi.vsPrevious')}
        </span>
      )}
    </>
  );
  return href ? <Link href={href} className="group block">{body}</Link> : <div>{body}</div>;
}

function DocTypeCountsList({ data, heading }: { data: DocTypeCounts; heading?: string }) {
  const max = Math.max(1, ...data.counts.map(c => c.count));
  return (
    <div data-testid={`widget-doccounts-${data.docTypeKey}`}>
      {heading && (
        <Link href={data.link ?? `/docs/${encodeURIComponent(data.docTypeKey)}`} className="mb-1 flex items-baseline justify-between gap-2 text-sm font-medium text-fg-muted hover:text-fg">
          <span className="truncate">{heading}</span><span className="tabular-nums">{data.total ?? ''}</span>
        </Link>
      )}
      {data.counts.length === 0 ? <p className="text-sm text-fg-muted">{t('dash.docCounts.empty')}</p> : (
        <ul className="-mx-2 space-y-0.5">
          {data.counts.map(c => (
            <li key={c.statusKey}>
              <Link href={c.link ?? `/docs/${encodeURIComponent(data.docTypeKey)}?status=${encodeURIComponent(c.statusKey)}`}
                className="group grid grid-cols-[minmax(0,1fr)_4.5rem_auto_1rem] items-center gap-3 rounded px-2 py-1.5 hover:bg-subtle" data-testid={`widget-doccount-${data.docTypeKey}-${c.statusKey}`}>
                <span className="truncate">{c.label}</span>
                <span className="h-1.5 rounded-full bg-accent-soft" aria-hidden><span className="block h-full rounded-full bg-accent" style={{ width: `${c.count ? Math.max(6, (c.count / max) * 100) : 0}%` }} /></span>
                <span className="text-right font-semibold tabular-nums">{c.count}</span>
                <ChevronRight className="size-4 text-fg-subtle group-hover:text-fg" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocCountsBody({ data }: { data: Extract<WidgetData, { type: 'doc_counts' }> }) {
  const list = data.types ?? [];
  if (!list.length) return <p className="text-sm text-fg-muted">{t('dash.docCounts.empty')}</p>;
  if (list.length === 1) return <DocTypeCountsList data={list[0]!} />;
  return <div className="-mr-2 h-full space-y-4 overflow-y-auto pr-2">{list.map(d => <DocTypeCountsList key={d.docTypeKey} data={d} heading={d.name ?? d.docTypeKey} />)}</div>;
}

function TableBody({ res }: { res: ReportResult }) {
  const cols = res.columns.map(c => ({ ...c, fmt: effectiveFormat('auto', c.type, c.aggregate), num: isNumericType(c.type, c.aggregate) }));
  if (!res.rows.length) return <p className="text-sm text-fg-muted">{t('report.empty.title')}</p>;
  return (
    <div className="-mx-4 -my-3 h-[calc(100%+1.5rem)] overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-subtle text-fg-muted">
          <tr>{cols.map((c, i) => <th key={i} scope="col" className={cn('whitespace-nowrap px-4 py-2 font-medium', c.num ? 'text-right' : 'text-left')}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {res.rows.map((r, ri) => (
            <tr key={ri} className="border-t border-border">
              {cols.map((c, ci) => {
                const text = formatValue(r[ci], c.fmt);
                const link = ci === 0 ? res.links?.[ri] : null;
                return <td key={ci} className={cn('max-w-[14rem] truncate px-4 py-1.5', c.num && 'text-right tabular-nums')}>{link ? <Link href={link} className="text-accent hover:underline">{text}</Link> : text}</td>;
              })}
            </tr>
          ))}
        </tbody>
        {res.totals && (
          <tfoot className="sticky bottom-0 bg-subtle font-semibold">
            <tr className="border-t border-border-strong">{cols.map((c, ci) => <td key={ci} className={cn('px-4 py-1.5', c.num && 'text-right tabular-nums')}>{ci === 0 && (!c.num || res.totals![0] == null) ? t('report.totals') : res.totals![ci] == null ? '' : formatValue(res.totals![ci], c.fmt)}</td>)}</tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function ChartBody({ widget, res }: { widget: DashboardWidget; res: ReportResult }) {
  const report = useReport(widget.reportId);
  const def = report.data?.definition;
  const model = def ? chartModel(res, def.chart ? def : { ...def, chart: guessChart(res) }) : null;
  const height = Math.max(140, widget.h * ROW_PX + (widget.h - 1) * GAP_PX - HEADER_PX - 24 - (model && model.series.length > 1 ? 28 : 0));
  if (report.isLoading) return <Skeleton className="h-full min-h-32" />;
  if (!model || !model.categories.length) return <p className="text-sm text-fg-muted">{t('report.chart.noData')}</p>;
  return <ReportChart model={model} height={height} compact />;
}

/** A report without a chart still charts in a widget: first text column × first numeric column, as bars. */
function guessChart(res: ReportResult) {
  const x = res.columns.find(c => !isNumericType(c.type, c.aggregate));
  const y = res.columns.find(c => isNumericType(c.type, c.aggregate));
  return x && y ? { type: 'bar' as const, x: x.field, series: [y.field] } : undefined;
}

/** Renders one widget by type. `live` = compute from the report directly (designer preview, unsaved changes). */
export function WidgetView({ widget, dashboardId, live = false }: { widget: DashboardWidget; dashboardId: string | null; live?: boolean }) {
  const data = useWidgetData(widget, dashboardId, live);
  const docTypes = useDocTypes(widget.type === 'doc_counts');
  if (widget.type === 'inbox_counts') {
    // The Phase 3 approvals widget, unchanged (test ids inbox-widget-*), inside the grid cell.
    return <div className="h-full [&>section]:h-full" data-testid={`widget-${widget.id}`} data-widget-type="inbox_counts"><ApprovalsWidget className="h-full overflow-auto" /></div>;
  }
  const reportHref = widget.reportId ? `/reports/${widget.reportId}` : undefined;
  const docType = widget.type === 'doc_counts' ? docTypes.data?.find(d => d.key === widget.docTypeKey) : undefined;
  const action = widget.type === 'doc_counts' && widget.docTypeKey
    ? <OpenLink href={`/docs/${encodeURIComponent(widget.docTypeKey)}`} label={t('dash.docCounts.all')} />
    : reportHref && widget.type !== 'kpi' ? <OpenLink href={reportHref} /> : undefined;
  // doc_counts without a type shows every type the viewer can list.
  const missing = widget.type === 'doc_counts' ? false : !widget.reportId;

  return (
    <WidgetFrame widget={{ ...widget, title: widget.title || docType?.pluralName || (widget.type === 'doc_counts' && !widget.docTypeKey ? t('dash.docCounts.allTypes') : '') }} action={action}>
      {missing ? <p className="text-sm text-fg-muted">{t('dash.widget.unconfigured')}</p>
        : data.isLoading ? <WidgetSkeleton rows={widget.type === 'kpi' ? 2 : 4} />
        : data.isError ? <WidgetError error={data.error} />
        : !data.data ? null
        : data.data.type === 'kpi' ? <KpiBody data={data.data} href={reportHref} />
        : data.data.type === 'doc_counts' ? <DocCountsBody data={data.data} />
        : data.data.type === 'chart' ? <ChartBody widget={widget} res={data.data} />
        : <TableBody res={data.data} />}
    </WidgetFrame>
  );
}

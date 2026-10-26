'use client';
import { useQuery } from '@tanstack/react-query';
import { docsApi, useDocTypes } from '@/features/documents/api';
import { dashboardsApi, reportKeys, reportsApi } from '@/features/reports/api';
import type { DashboardWidget, DocTypeCounts, KpiData, ReportResult, WidgetData } from '@/features/reports/types';
import { toNumber } from '@/features/reports/format';

/** KPI from a report run, same rule as the server: the first summarised column's total, else the first number. */
export function kpiFromResult(res: ReportResult): KpiData {
  let i = res.columns.findIndex(c => c.aggregate !== 'none');
  let raw: unknown = null;
  if (i >= 0) raw = res.totals?.[i] ?? (res.rows.length === 1 ? res.rows[0]![i] : null);
  else {
    i = res.columns.findIndex(c => c.type === 'number' || c.type === 'currency');
    raw = i >= 0 ? res.rows[0]?.[i] : null;
  }
  const col = i >= 0 ? res.columns[i] : undefined;
  return { value: toNumber(raw), label: col?.label, valueType: col?.type };
}

async function docCounts(keys: string[]): Promise<DocTypeCounts[]> {
  return Promise.all(keys.slice(0, 12).map(async key => {
    const counts = await docsApi.counts(key, { view: 'document' });
    return {
      docTypeKey: key, link: `/docs/${encodeURIComponent(key)}`, total: counts.reduce((a, c) => a + c.count, 0),
      counts: counts.map(c => ({ ...c, link: `/docs/${encodeURIComponent(key)}?status=${encodeURIComponent(c.statusKey)}` })),
    };
  }));
}

/**
 * Data for one widget. Saved dashboards use POST /dashboards/widgets/:id/data. The designer (unsaved widgets) computes
 * it directly: report run for kpi/chart/table, GET /docs/:type/counts for doc_counts. Chart widgets always run the
 * report, because the rows let a second group become the series (the widget payload carries only the flat chart).
 */
export function useWidgetData(widget: DashboardWidget, dashboardId: string | null, live: boolean) {
  const direct = !dashboardId || live || widget.type === 'chart';
  const types = useDocTypes(direct && widget.type === 'doc_counts' && !widget.docTypeKey);
  const allKeys = (types.data ?? []).filter(d => d.isActive).map(d => d.key);
  return useQuery<WidgetData>({
    queryKey: reportKeys.widget(direct ? null : dashboardId, widget.id, direct ? [widget.type, widget.reportId, widget.docTypeKey, widget.params, allKeys] : widget.type),
    enabled: widget.type !== 'inbox_counts' && (widget.type === 'doc_counts' ? !direct || !!widget.docTypeKey || types.isSuccess : !!widget.reportId),
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      if (!direct) {
        // The server may omit `type`; the widget's own type decides how the payload renders.
        const d = await dashboardsApi.widgetData(widget.id, dashboardId!);
        return { ...d, type: widget.type } as WidgetData;
      }
      if (widget.type === 'doc_counts') return { type: 'doc_counts', types: await docCounts(widget.docTypeKey ? [widget.docTypeKey] : allKeys) };
      const params = (widget.params ?? {}) as Record<string, unknown>;
      const res = await reportsApi.run(widget.reportId!, { params, page: { limit: widget.type === 'table' ? Math.min(200, Number(params.limit) || 20) : 1000 } });
      if (widget.type === 'kpi') return { type: 'kpi', ...kpiFromResult(res), link: `/reports/${widget.reportId}` };
      return { type: widget.type as 'chart' | 'table', ...res };
    },
  });
}

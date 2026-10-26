'use client';
/**
 * Phase 7 client: reports, previews, schedules, exports, dashboards (docs/contracts/phase-7-api.md).
 * One place for paths and query keys. Transport is the real API, or the typed in-memory mock when
 * NEXT_PUBLIC_REPORTS_MOCK=1 or localStorage `procure.reportsMock` = '1' (the backend is built in parallel).
 */
import type { Page } from '@procure/schema';
import { useQuery } from '@tanstack/react-query';
import { api, type RequestOptions } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useSession } from '@/lib/session';
import { asArray } from '@/lib/types';
import type {
  DashboardBody, DashboardRow, ExportBody, ExportJob, ReportDefinition, ReportInputBody, ReportResult, ReportRow, ScheduleBody,
  ScheduleRow, SourceCatalogue, WidgetData,
} from './types';

export function reportsMockOn(): boolean {
  if (process.env.NEXT_PUBLIC_REPORTS_MOCK === '1') return true;
  try { return typeof window !== 'undefined' && window.localStorage.getItem('procure.reportsMock') === '1'; } catch { return false; }
}

let mockMod: Promise<typeof import('./mock')> | null = null;
async function call<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (reportsMockOn()) {
    mockMod ??= import('./mock');
    return (await mockMod).mockCall<T>(path, opts);
  }
  return api<T>(path, opts);
}
type Q = RequestOptions['query'];
const get = <T>(path: string, query?: Q) => call<T>(path, { query });
const post = <T>(path: string, body?: unknown) => call<T>(path, { method: 'POST', body: body ?? {} });
const put = <T>(path: string, body?: unknown) => call<T>(path, { method: 'PUT', body });
const del = <T>(path: string) => call<T>(path, { method: 'DELETE' });
const enc = encodeURIComponent;

export interface RunBody { params: Record<string, unknown>; page?: { cursor?: string; limit?: number } }

export const reportsApi = {
  sources: async () => asArray(await get<SourceCatalogue[] | Page<SourceCatalogue>>('/reports/sources')),
  list: async () => asArray(await get<ReportRow[] | Page<ReportRow>>('/reports')),
  get: (id: string) => get<ReportRow>(`/reports/${enc(id)}`),
  create: (body: ReportInputBody) => post<ReportRow>('/reports', body),
  update: (id: string, body: ReportInputBody & { version?: number }) => put<ReportRow>(`/reports/${enc(id)}`, body),
  remove: (id: string) => del<void>(`/reports/${enc(id)}`),
  run: (id: string, body: RunBody) => post<ReportResult>(`/reports/${enc(id)}/run`, body),
  preview: (definition: ReportDefinition, params: Record<string, unknown>) => post<ReportResult>('/reports/preview', { definition, params }),
  schedules: async (id: string) => asArray(await get<ScheduleRow[] | Page<ScheduleRow>>(`/reports/${enc(id)}/schedules`)),
  addSchedule: (id: string, body: ScheduleBody) => post<ScheduleRow>(`/reports/${enc(id)}/schedules`, body),
  removeSchedule: (id: string, scheduleId: string) => del<void>(`/reports/${enc(id)}/schedules/${enc(scheduleId)}`),
};

export const exportsApi = {
  create: (body: ExportBody) => post<ExportJob>('/exports', body),
  list: async () => asArray(await get<ExportJob[] | Page<ExportJob>>('/exports')),
  get: (id: string) => get<ExportJob>(`/exports/${enc(id)}`),
};

export const dashboardsApi = {
  list: async () => asArray(await get<DashboardRow[] | Page<DashboardRow>>('/dashboards')),
  mine: () => get<DashboardRow>('/dashboards/mine'),
  get: (id: string) => get<DashboardRow>(`/dashboards/${enc(id)}`),
  create: (body: DashboardBody) => post<DashboardRow>('/dashboards', body),
  update: (id: string, body: DashboardBody & { version?: number }) => put<DashboardRow>(`/dashboards/${enc(id)}`, body),
  remove: (id: string) => del<void>(`/dashboards/${enc(id)}`),
  widgetData: (widgetId: string, dashboardId: string) => post<WidgetData>(`/dashboards/widgets/${enc(widgetId)}/data`, { dashboardId }),
};

export const reportKeys = {
  sources: ['reports', 'sources'] as const,
  list: ['reports', 'list'] as const,
  detail: (id: string) => ['reports', 'detail', id] as const,
  run: (id: string, params: unknown) => ['reports', 'run', id, params] as const,
  preview: (def: unknown, params: unknown) => ['reports', 'preview', def, params] as const,
  schedules: (id: string) => ['reports', 'schedules', id] as const,
  exports: ['exports'] as const,
  dashboards: ['dashboards'] as const,
  dashMine: ['dashboards', 'mine'] as const,
  dashboard: (id: string) => ['dashboards', 'detail', id] as const,
  widget: (dashboardId: string | null, widgetId: string, sig: unknown) => ['dashboards', 'widget', dashboardId, widgetId, sig] as const,
};

export const REPORT_PERMS = {
  view: 'reports:action.view',
  build: 'reports:action.build',
  share: 'reports:action.share',
  schedule: 'reports:action.schedule',
  export: 'reports:action.export',
  dashView: 'dashboards:action.view',
  dashEdit: 'dashboards:action.edit',
} as const;

/** Builder needs the plan feature and the permission. */
export function useCanBuild() {
  const p = usePermissions();
  const { features } = useSession();
  return p.has(REPORT_PERMS.build) && (features.has('report_builder') || !p.fromServer || reportsMockOn());
}

export function useSources(enabled = true) {
  const { version, ready } = usePermissions();
  return useQuery({ queryKey: [...reportKeys.sources, version], queryFn: reportsApi.sources, enabled: enabled && ready, staleTime: 5 * 60_000, retry: false });
}

export function useReports() {
  const { version, ready } = usePermissions();
  return useQuery({ queryKey: [...reportKeys.list, version], queryFn: reportsApi.list, enabled: ready, staleTime: 30_000, retry: false });
}

export function useReport(id: string | null | undefined) {
  return useQuery({ queryKey: reportKeys.detail(id ?? ''), queryFn: () => reportsApi.get(id!), enabled: !!id, retry: false });
}

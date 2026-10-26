import { z } from 'zod';
import { Uuid } from './common';

/**
 * REPORTS CONTRACT (Phase 7, frozen). ADR-0015. Reports are data: a source, columns, filters, grouping, totals and
 * an optional chart. The engine compiles them to parameterised SQL over an allow-listed column catalogue per source
 * (never raw SQL from users), applying tenant RLS, the viewer's data scope and field access automatically.
 */

/** Sources: one per document type (document-wise and item-wise), per master, plus engine sources added by modules
 *  (`stock_ledger`, `stock_balance` in Phase 5; `vendor_quote`, `po_followup` in Phase 4). */
export const ReportSource = z.object({
  kind: z.enum(['doc', 'doc_line', 'master', 'engine']),
  key: z.string().min(1).max(80),      // doc type key / master key / engine source key
});

export const ReportColumn = z.object({
  field: z.string().min(1).max(120),   // catalogue field id, e.g. 'number', 'location.name', 'custom.priority', 'qty.pending_approval', 'item.category.name'
  label: z.string().max(80).optional(),
  aggregate: z.enum(['none', 'sum', 'avg', 'min', 'max', 'count', 'count_distinct']).default('none'),
  format: z.enum(['auto', 'number', 'currency', 'percent', 'date', 'datetime', 'text']).default('auto'),
  width: z.number().int().min(40).max(800).optional(),
});

export const ReportFilter = z.object({
  field: z.string(),
  op: z.enum(['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'starts_with', 'is_empty', 'not_empty', 'within_location']),
  value: z.unknown().optional(),
  /** Exposed as a runtime parameter the viewer can change (e.g. date range). */
  param: z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), label: z.string().max(60), required: z.boolean().default(false) }).optional(),
});

export const ReportDefinition = z.object({
  source: ReportSource,
  columns: z.array(ReportColumn).min(1).max(60),
  filters: z.array(ReportFilter).max(30).default([]),
  groupBy: z.array(z.string()).max(4).default([]),
  sort: z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).default('asc') })).max(4).default([]),
  totals: z.boolean().default(true),
  chart: z.object({
    type: z.enum(['bar', 'line', 'pie', 'area', 'stacked_bar']),
    x: z.string(), series: z.array(z.string()).min(1).max(6),
  }).optional(),
  /** Relative date presets resolved at run time in the tenant timezone. */
  datePreset: z.enum(['none', 'today', 'this_week', 'this_month', 'last_month', 'this_fy', 'last_30_days', 'last_90_days']).default('none'),
  rowLimit: z.number().int().min(1).max(100_000).default(10_000),
});
export type ReportDefinition = z.infer<typeof ReportDefinition>;

export const ReportInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  definition: ReportDefinition,
  sharedRoleIds: z.array(Uuid).default([]),
});

export interface CatalogueField {
  id: string; label: string; type: 'text' | 'number' | 'currency' | 'date' | 'datetime' | 'boolean' | 'status' | 'lookup';
  groupable: boolean; filterable: boolean; aggregatable: boolean; path: string[]; // for UI grouping (e.g. ['Item', 'Category'])
}
export interface SourceCatalogue { source: z.infer<typeof ReportSource>; label: string; fields: CatalogueField[] }

export const ReportRunInput = z.object({
  params: z.record(z.string(), z.unknown()).default({}),
  page: z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(1000).default(200) }).default({}),
});
export interface ReportResult {
  columns: { field: string; label: string; type: CatalogueField['type']; aggregate: string }[];
  rows: unknown[][];
  totals: unknown[] | null;
  groups?: { key: unknown[]; rowCount: number; totals: unknown[] }[];
  chart?: { x: unknown[]; series: { name: string; values: number[] }[] };
  nextCursor: string | null;
  truncated: boolean;
  /** Each row's drill-down target, when rows are documents/lines: ['/docs/capex/<id>', …]. */
  links?: (string | null)[];
}

export const ScheduleInput = z.object({
  cron: z.string().regex(/^(\S+\s){4}\S+$/, '5-field cron'),
  format: z.enum(['xlsx', 'csv', 'pdf']).default('xlsx'),
  recipients: z.array(z.union([z.object({ type: z.literal('user'), userId: Uuid }), z.object({ type: z.literal('email'), address: z.string().email() })])).min(1).max(20),
  params: z.record(z.string(), z.unknown()).default({}),
  isActive: z.boolean().default(true),
});

export const ExportRequest = z.object({
  kind: z.enum(['report', 'list', 'master']),
  source: z.record(z.string(), z.unknown()),   // { reportId, params } | { scope: 'doc.capex:item', query: {...} } | { masterKey, view }
  format: z.enum(['xlsx', 'csv', 'pdf']),
});
export interface ExportJobRow { id: string; name?: string; kind: string; format: string; status: 'queued' | 'running' | 'ready' | 'failed' | 'expired'; rowCount: number | null; fileUrl: string | null; error: string | null; createdAt: string; finishedAt: string | null }

/** Dashboards: grid of widgets; each widget runs a saved report (or a built-in metric) and links into a filtered list. */
export const DashboardWidget = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(['kpi', 'chart', 'table', 'inbox_counts', 'doc_counts']),
  title: z.string().max(80),
  reportId: Uuid.optional(),
  /** doc_counts: counts per status of a doc type, each count links to the filtered list. */
  docTypeKey: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  x: z.number().int().min(0).max(11), y: z.number().int().min(0), w: z.number().int().min(1).max(12), h: z.number().int().min(1).max(12),
});
export const DashboardInput = z.object({
  name: z.string().trim().min(1).max(80),
  widgets: z.array(DashboardWidget).max(30),
  sharedRoleIds: z.array(Uuid).default([]),
  isDefaultForRoleIds: z.array(Uuid).default([]),
});

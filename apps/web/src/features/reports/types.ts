/**
 * UI-side shapes for Phase 7 (docs/contracts/phase-7-api.md, packages/schema/src/reports.ts).
 * The schema freezes the inputs and `ReportResult`; list rows, schedules, dashboards and widget data are only named in
 * the contract table, so their shapes live here (tolerant: optional fields the server may omit).
 */
import type { CatalogueField, ExportJobRow, ReportResult, SourceCatalogue } from '@procure/schema';
import type { z } from 'zod';
import type {
  DashboardInput, DashboardWidget as DashboardWidgetSchema, ExportRequest, ReportColumn, ReportDefinition as ReportDefinitionSchema,
  ReportFilter, ReportInput, ReportSource, ScheduleInput,
} from '@procure/schema';

export type { CatalogueField, ExportJobRow, ReportResult, SourceCatalogue };

/** Definitions as the UI edits them (defaults filled in). */
export type ReportDefinition = z.output<typeof ReportDefinitionSchema>;
export type ReportColumnDef = z.output<typeof ReportColumn>;
export type ReportFilterDef = z.output<typeof ReportFilter>;
export type ReportSourceDef = z.output<typeof ReportSource>;
export type ReportInputBody = z.input<typeof ReportInput>;
export type ScheduleBody = z.input<typeof ScheduleInput>;
export type ExportBody = z.input<typeof ExportRequest>;
export type DashboardBody = z.input<typeof DashboardInput>;
export type DashboardWidget = z.output<typeof DashboardWidgetSchema>;
export type WidgetType = DashboardWidget['type'];
export type ChartType = NonNullable<ReportDefinition['chart']>['type'];
export type Aggregate = ReportColumnDef['aggregate'];
export type ColumnFormat = ReportColumnDef['format'];
export type FilterOp = ReportFilterDef['op'];
export type DatePreset = ReportDefinition['datePreset'];
export type ExportFormat = ExportBody['format'];
export type FieldType = CatalogueField['type'];

/** GET /reports row and GET /reports/:id. */
export interface ReportRow {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  kind: 'builtin' | 'custom';
  ownerUserId?: string | null;
  ownerName?: string | null;
  sharedRoleIds?: string[];
  definition: ReportDefinition;
  updatedAt?: string | null;
  version?: number;
  /** Server flags (owner = caller; owner or tenant admin with reports:action.build). */
  isMine?: boolean;
  canEdit?: boolean;
}

/** GET /reports/:id/schedules row. */
export interface ScheduleRow {
  id: string;
  reportId?: string;
  cron: string;
  format: ExportFormat;
  recipients: ScheduleBody['recipients'];
  params?: Record<string, unknown>;
  isActive: boolean;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
}

/** GET /dashboards[/:id], GET /dashboards/mine. */
export interface DashboardRow {
  /** null for the built-in "My work" dashboard (not stored). */
  id: string | null;
  name: string;
  widgets: DashboardWidget[];
  sharedRoleIds?: string[];
  isDefaultForRoleIds?: string[];
  ownerUserId?: string | null;
  /** How /dashboards/mine resolved it. */
  source?: 'role' | 'personal' | 'builtin';
  /** Key of a built-in (read-only) dashboard, e.g. 'my_work'. */
  builtin?: string | null;
  isMine?: boolean;
  canEdit?: boolean;
  version?: number;
  updatedAt?: string | null;
}

/** POST /dashboards/widgets/:id/data, by widget type. */
export interface KpiData { value: number | null; delta?: number | null; /** Change in percent (12.5 = +12.5%). */ deltaPct?: number | null; previous?: number | null; label?: string; format?: ColumnFormat; valueType?: FieldType; link?: string | null }
export interface DocTypeCounts { docTypeKey: string; name?: string; link?: string; total?: number; counts: { statusKey: string; label: string; count: number; link?: string }[] }
/** One doc type (widget.docTypeKey) or every type the viewer can list. */
export interface DocCountsData { types: DocTypeCounts[] }
export type WidgetData =
  | ({ type: 'kpi' } & KpiData)
  | ({ type: 'chart' } & ReportResult)
  | ({ type: 'table' } & ReportResult)
  | ({ type: 'doc_counts' } & DocCountsData);

export type ExportStatus = ExportJobRow['status'];
export interface ExportJob extends ExportJobRow { expiresAt?: string | null }

/** Runtime parameter a viewer can change (from a filter's `param`). */
export interface ReportParam {
  key: string;
  label: string;
  required: boolean;
  field: string;
  op: FilterOp;
  type: FieldType;
  default: unknown;
}

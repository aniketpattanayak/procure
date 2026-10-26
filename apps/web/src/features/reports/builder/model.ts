import type { CatalogueField, FieldType, FilterOp, ReportColumnDef, ReportDefinition, ReportFilterDef, SourceCatalogue } from '../types';

export type Shelf = 'columns' | 'groupBy' | 'filters' | 'sort';
export const SHELVES: Shelf[] = ['columns', 'groupBy', 'filters', 'sort'];
export const LIMITS: Record<Shelf, number> = { columns: 60, groupBy: 4, filters: 30, sort: 4 };

export type Selection = { shelf: Shelf; index: number } | { panel: 'chart' } | { panel: 'settings' } | null;

export const SOURCE_KINDS = ['doc', 'doc_line', 'master', 'engine'] as const;

export function sourceId(s: { kind: string; key: string }) { return `${s.kind}:${s.key}`; }

export function emptyDefinition(source: ReportDefinition['source']): ReportDefinition {
  return { source, columns: [], filters: [], groupBy: [], sort: [], totals: true, datePreset: 'none', rowLimit: 10_000 };
}

export function slugKey(name: string) {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '');
  return (s || 'report').slice(0, 60).padEnd(2, '_');
}

export function paramKey(label: string) {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '');
  return (s || 'param').slice(0, 31);
}

/** Path groups for the field tree: ['Item', 'Category'] → 'Item › Category'. */
export function groupFields(fields: CatalogueField[], q: string) {
  const needle = q.trim().toLowerCase();
  const groups = new Map<string, CatalogueField[]>();
  for (const f of fields) {
    const path = f.path?.length ? f.path.join(' › ') : '—';
    if (needle && !f.label.toLowerCase().includes(needle) && !path.toLowerCase().includes(needle) && !f.id.toLowerCase().includes(needle)) continue;
    groups.set(path, [...(groups.get(path) ?? []), f]);
  }
  return [...groups.entries()].map(([path, list]) => ({ path, fields: list }));
}

export const isNumeric = (t?: FieldType) => t === 'number' || t === 'currency';
export const isDateType = (t?: FieldType) => t === 'date' || t === 'datetime';

export function opsFor(f: CatalogueField | undefined): FilterOp[] {
  const t = f?.type;
  const loc = /^location(\.|$)/.test(f?.id ?? '');
  if (t === 'boolean') return ['eq', 'is_empty', 'not_empty'];
  if (isNumeric(t)) return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'];
  if (isDateType(t)) return ['between', 'eq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'];
  return [...(loc ? (['within_location'] as FilterOp[]) : []), 'eq', 'ne', 'in', 'not_in', 'contains', 'starts_with', 'is_empty', 'not_empty'];
}

export const opTakesValue = (op: FilterOp) => op !== 'is_empty' && op !== 'not_empty';

export function aggregatesFor(f: CatalogueField | undefined): ReportColumnDef['aggregate'][] {
  if (f?.aggregatable || isNumeric(f?.type)) return ['none', 'sum', 'avg', 'min', 'max', 'count', 'count_distinct'];
  if (isDateType(f?.type)) return ['none', 'min', 'max', 'count', 'count_distinct'];
  return ['none', 'count', 'count_distinct'];
}

export function newColumn(f: CatalogueField, grouped: boolean): ReportColumnDef {
  return { field: f.id, aggregate: grouped && isNumeric(f.type) ? 'sum' : 'none', format: 'auto' };
}

export function newFilter(f: CatalogueField): ReportFilterDef {
  return { field: f.id, op: opsFor(f)[0]! };
}

export interface Issue { code: string; message: string; shelf?: Shelf; index?: number }

/** Local checks mirroring what the compiler will reject, so Save/preview are blocked with a reason. */
export function localIssues(def: ReportDefinition, cat: SourceCatalogue | undefined, tr: (k: string, v?: Record<string, string | number>) => string): Issue[] {
  const out: Issue[] = [];
  const field = (id: string) => cat?.fields.find(f => f.id === id);
  if (!def.columns.length) out.push({ code: 'no_columns', message: tr('builder.issue.noColumns'), shelf: 'columns' });
  const grouped = def.groupBy.length > 0;
  def.columns.forEach((c, i) => {
    if (cat && !field(c.field)) out.push({ code: 'unknown_field', message: tr('builder.issue.unknownField', { field: c.field }), shelf: 'columns', index: i });
    if (grouped && c.aggregate === 'none' && !def.groupBy.includes(c.field)) {
      out.push({ code: 'not_grouped', message: tr('builder.issue.notGrouped', { field: c.label || field(c.field)?.label || c.field }), shelf: 'columns', index: i });
    }
  });
  def.groupBy.forEach((g, i) => { if (cat && field(g) && !field(g)!.groupable) out.push({ code: 'not_groupable', message: tr('builder.issue.notGroupable', { field: field(g)!.label }), shelf: 'groupBy', index: i }); });
  const keys = new Set<string>();
  def.filters.forEach((f, i) => {
    if (f.param) {
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(f.param.key)) out.push({ code: 'param_key', message: tr('builder.issue.paramKey'), shelf: 'filters', index: i });
      if (keys.has(f.param.key)) out.push({ code: 'param_dup', message: tr('builder.issue.paramDup', { key: f.param.key }), shelf: 'filters', index: i });
      keys.add(f.param.key);
      if (!f.param.label.trim()) out.push({ code: 'param_label', message: tr('builder.issue.paramLabel'), shelf: 'filters', index: i });
    } else if (opTakesValue(f.op) && (f.value === undefined || f.value === '' || (Array.isArray(f.value) && f.value.every(v => v === '' || v == null)))) {
      out.push({ code: 'filter_value', message: tr('builder.issue.filterValue', { field: field(f.field)?.label ?? f.field }), shelf: 'filters', index: i });
    }
  });
  if (def.chart) {
    const cols = def.columns.map(c => c.field);
    if (!cols.includes(def.chart.x)) out.push({ code: 'chart_x', message: tr('builder.issue.chartX') });
    if (!def.chart.series.length || def.chart.series.some(s => !cols.includes(s))) out.push({ code: 'chart_series', message: tr('builder.issue.chartSeries') });
  }
  return out;
}

/** Strip UI-only noise before sending (empty labels, undefined widths). */
export function cleanDefinition(def: ReportDefinition): ReportDefinition {
  return {
    ...def,
    columns: def.columns.map(c => ({ ...c, label: c.label?.trim() || undefined, width: c.width || undefined })),
    filters: def.filters.map(f => ({ ...f, value: opTakesValue(f.op) ? f.value : undefined, param: f.param ? { ...f.param, label: f.param.label.trim() } : undefined })),
    chart: def.chart && def.chart.series.length ? def.chart : undefined,
  };
}

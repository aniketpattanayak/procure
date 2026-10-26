import { effectiveFormat, formatValue, toNumber } from './format';
import { MAX_SERIES } from './chart-theme';
import type { ColumnFormat, ReportDefinition, ReportResult } from './types';

export interface ChartSeries { key: string; name: string; values: number[]; other?: boolean }
export interface ChartModel {
  type: NonNullable<ReportDefinition['chart']>['type'];
  categories: string[];
  series: ChartSeries[];
  format: Exclude<ColumnFormat, 'auto'>;
  xLabel: string;
}

const OTHER = 'Other';

/** Keep the first MAX_SERIES-1 series (by total) and fold the rest into "Other" when there are more than MAX_SERIES. */
function foldSeries(series: ChartSeries[]): ChartSeries[] {
  if (series.length <= MAX_SERIES) return series;
  const ranked = [...series].sort((a, b) => sum(b.values) - sum(a.values));
  const keep = new Set(ranked.slice(0, MAX_SERIES - 1).map(s => s.key));
  const kept = series.filter(s => keep.has(s.key));
  const rest = series.filter(s => !keep.has(s.key));
  const other = rest[0]!.values.map((_, i) => rest.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  return [...kept, { key: '__other', name: OTHER, values: other, other: true }];
}
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

/**
 * Chart model from a result. The server's `chart` block wins; otherwise it is derived from rows: x = chart.x column,
 * one series per chart.series column. With two group-by fields and one measure, the other group field becomes the
 * series (location × month → one bar per location in each month).
 */
export function chartModel(result: ReportResult | undefined, def: Pick<ReportDefinition, 'chart' | 'groupBy' | 'columns'>): ChartModel | null {
  const chart = def.chart;
  if (!result || !chart) return null;
  const colIdx = (field: string) => result.columns.findIndex(c => c.field === field);
  const xi = colIdx(chart.x);
  const xCol = result.columns[xi];
  const firstSeries = result.columns[colIdx(chart.series[0] ?? '')];
  const fmt = effectiveFormat(def.columns.find(c => c.field === chart.series[0])?.format, firstSeries?.type, firstSeries?.aggregate);
  const xFmt = effectiveFormat(def.columns.find(c => c.field === chart.x)?.format, xCol?.type, xCol?.aggregate);
  const xLabel = xCol?.label ?? chart.x;

  // Rows are the source of truth (they let a second group become the series); the server's `chart` block is used when
  // there are no rows to derive from (dashboard chart widgets), merging repeated categories.
  const rowsUsable = Array.isArray(result.rows) && result.rows.length > 0 && xi >= 0;
  if (!rowsUsable && result.chart && result.chart.x.length) {
    const cats: string[] = [];
    const at = new Map<string, number>();
    result.chart.x.forEach(v => { const l = formatValue(v, xFmt); if (!at.has(l)) { at.set(l, cats.length); cats.push(l); } });
    const series = result.chart.series.map((s, i) => {
      const values = cats.map(() => 0);
      s.values.forEach((v, j) => { const c = at.get(formatValue(result.chart!.x[j], xFmt))!; values[c] = (values[c] ?? 0) + (toNumber(v) ?? 0); });
      return { key: `s${i}`, name: s.name, values };
    });
    return { type: chart.type, categories: cats, series: chart.type === 'pie' ? series.slice(0, 1) : foldSeries(series), format: fmt, xLabel };
  }
  if (!rowsUsable) return null;

  const categories: string[] = [];
  const catIndex = new Map<string, number>();
  const cat = (v: unknown) => {
    const label = formatValue(v, xFmt);
    if (!catIndex.has(label)) { catIndex.set(label, categories.length); categories.push(label); }
    return catIndex.get(label)!;
  };
  const measures = chart.series.map(colIdx).filter(i => i >= 0);
  const pivotField = (def.groupBy ?? []).length >= 2 && measures.length === 1 && chart.type !== 'pie' ? def.groupBy!.find(g => g !== chart.x) : undefined;
  const pi = pivotField ? colIdx(pivotField) : -1;

  const bySeries = new Map<string, { name: string; values: Map<number, number> }>();
  const order: string[] = [];
  for (const row of result.rows ?? []) {
    const c = cat(row[xi]);
    if (pi >= 0) {
      const pCol = result.columns[pi]!;
      const name = formatValue(row[pi], effectiveFormat('auto', pCol.type));
      if (!bySeries.has(name)) { bySeries.set(name, { name, values: new Map() }); order.push(name); }
      const s = bySeries.get(name)!;
      s.values.set(c, (s.values.get(c) ?? 0) + (toNumber(row[measures[0]!]) ?? 0));
    } else {
      for (const mi of measures) {
        const key = result.columns[mi]!.field;
        if (!bySeries.has(key)) { bySeries.set(key, { name: result.columns[mi]!.label, values: new Map() }); order.push(key); }
        const s = bySeries.get(key)!;
        s.values.set(c, (s.values.get(c) ?? 0) + (toNumber(row[mi]) ?? 0));
      }
    }
  }
  // Date-like categories read left to right in time order.
  if (xCol && (xCol.type === 'date' || xCol.type === 'datetime' || /^\d{4}-(\d{2}|Q\d)$/.test(categories[0] ?? ''))) {
    const sorted = [...categories].sort();
    const remap = sorted.map(c => catIndex.get(c)!);
    categories.splice(0, categories.length, ...sorted);
    for (const s of bySeries.values()) {
      const next = new Map<number, number>();
      remap.forEach((oldIdx, newIdx) => { if (s.values.has(oldIdx)) next.set(newIdx, s.values.get(oldIdx)!); });
      s.values = next;
    }
  }
  const series = order.map((k, i) => {
    const s = bySeries.get(k)!;
    return { key: `s${i}`, name: s.name, values: categories.map((_, ci) => s.values.get(ci) ?? 0) };
  });
  return { type: chart.type, categories, series: chart.type === 'pie' ? series.slice(0, 1) : foldSeries(series), format: fmt, xLabel };
}

/** Recharts row objects: { x, s0, s1, … }. */
export function toRows(m: ChartModel) {
  return m.categories.map((x, i) => {
    const row: Record<string, string | number> = { x };
    for (const s of m.series) row[s.key] = s.values[i] ?? 0;
    return row;
  });
}

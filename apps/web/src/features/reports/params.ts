import type { CatalogueField, DatePreset, ReportDefinition, ReportParam } from './types';

export const DATE_PRESETS: Exclude<DatePreset, 'none'>[] = ['today', 'this_week', 'this_month', 'last_month', 'last_30_days', 'last_90_days', 'this_fy'];

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Browser-side resolution of a preset into [from, to] (inclusive dates), used to show the range and to fill a
 * `between` date parameter. The server resolves `definition.datePreset` itself in the tenant timezone.
 */
export function resolvePreset(preset: DatePreset, fyStartMonth = 4, now = new Date()): [string, string] | null {
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = new Date(y, m, now.getDate());
  const add = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  switch (preset) {
    case 'today': return [isoDay(today), isoDay(today)];
    case 'this_week': { const dow = (today.getDay() + 6) % 7; return [isoDay(add(today, -dow)), isoDay(add(today, 6 - dow))]; }
    case 'this_month': return [isoDay(new Date(y, m, 1)), isoDay(new Date(y, m + 1, 0))];
    case 'last_month': return [isoDay(new Date(y, m - 1, 1)), isoDay(new Date(y, m, 0))];
    case 'last_30_days': return [isoDay(add(today, -29)), isoDay(today)];
    case 'last_90_days': return [isoDay(add(today, -89)), isoDay(today)];
    case 'this_fy': {
      const start = fyStartMonth - 1;
      const fyYear = m >= start ? y : y - 1;
      return [isoDay(new Date(fyYear, start, 1)), isoDay(new Date(fyYear + 1, start, 0))];
    }
    default: return null;
  }
}

/** Viewer parameters from filters that expose `param`. */
export function paramsOf(def: ReportDefinition, fields: CatalogueField[] | undefined): ReportParam[] {
  const byId = new Map((fields ?? []).map(f => [f.id, f]));
  return (def.filters ?? []).filter(f => f.param).map(f => ({
    key: f.param!.key,
    label: f.param!.label,
    required: !!f.param!.required,
    field: f.field,
    op: f.op,
    type: f.op === 'within_location' ? 'lookup' : byId.get(f.field)?.type ?? guessType(f.field, f.value),
    default: f.value,
  }));
}

function guessType(field: string, value: unknown): CatalogueField['type'] {
  if (/(_at|date)$/.test(field)) return 'date';
  if (typeof value === 'number') return 'number';
  return 'text';
}

/** Initial parameter values: the URL wins, then the filter's own value. */
export function initialParams(params: ReportParam[], fromUrl: URLSearchParams | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    const raw = fromUrl?.get(`p.${p.key}`);
    if (raw !== null && raw !== undefined) {
      out[p.key] = p.op === 'between' || p.op === 'in' || p.op === 'not_in' ? raw.split(',') : raw;
    } else if (p.default !== undefined && p.default !== null && p.default !== '') {
      out[p.key] = p.default;
    }
  }
  return out;
}

export function paramsToSearch(values: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue;
    out[`p.${k}`] = Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** Missing required parameters (labels), so the viewer can say what to fill before running. */
export function missingRequired(params: ReportParam[], values: Record<string, unknown>) {
  return params.filter(p => {
    if (!p.required) return false;
    const v = values[p.key];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.every(x => x === '' || x == null));
  }).map(p => p.label);
}

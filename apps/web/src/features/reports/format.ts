import { fmtDate, fmtDateTime } from '@/lib/format';
import type { ColumnFormat, FieldType } from './types';

const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = new Intl.NumberFormat('en-IN', { style: 'percent', maximumFractionDigits: 1 });

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

export function isNumericType(type: FieldType | undefined, aggregate?: string) {
  if (aggregate === 'count' || aggregate === 'count_distinct') return true;
  return type === 'number' || type === 'currency';
}

/** Resolved display format for a result column. */
export function effectiveFormat(format: ColumnFormat | undefined, type: FieldType | undefined, aggregate?: string): Exclude<ColumnFormat, 'auto'> {
  if (format && format !== 'auto') return format;
  if (aggregate === 'count' || aggregate === 'count_distinct') return 'number';
  if (type === 'currency') return 'currency';
  if (type === 'number') return 'number';
  if (type === 'date') return 'date';
  if (type === 'datetime') return 'datetime';
  return 'text';
}

export function formatValue(v: unknown, format: Exclude<ColumnFormat, 'auto'>): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  switch (format) {
    case 'number': { const n = toNumber(v); return n === null ? String(v) : num.format(n); }
    case 'currency': { const n = toNumber(v); return n === null ? String(v) : money.format(n); }
    case 'percent': { const n = toNumber(v); return n === null ? String(v) : pct.format(n); }
    case 'date': return typeof v === 'string' ? fmtDate(v) : String(v);
    case 'datetime': return typeof v === 'string' ? fmtDateTime(v) : String(v);
    default:
      if (typeof v === 'object') {
        const o = v as { name?: unknown; label?: unknown };
        return String(o.name ?? o.label ?? JSON.stringify(v));
      }
      return String(v);
  }
}

/** Axis ticks and KPI values: 1.2K, 3.4L style compaction (Indian locale). */
export function formatCompact(v: number, format: Exclude<ColumnFormat, 'auto'> = 'number') {
  if (format === 'percent') return pct.format(v);
  const a = Math.abs(v);
  const short = (n: number, unit: string) => `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: n >= 100 ? 0 : 1 }).format(n)}${unit}`;
  if (a >= 1e7) return short(v / 1e7, ' Cr');
  if (a >= 1e5) return short(v / 1e5, ' L');
  if (a >= 1e3) return short(v / 1e3, 'K');
  return num.format(v);
}

/**
 * Relative date presets (contract `ReportDefinition.datePreset`), resolved in the tenant's calendar. Pure: the caller
 * passes "today" in the tenant timezone and the fiscal-year start month. Ranges are inclusive [from, to] dates.
 */
export type DatePreset = 'none' | 'today' | 'this_week' | 'this_month' | 'last_month' | 'this_fy' | 'last_30_days' | 'last_90_days';
export interface DateRange { from: string; to: string }

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const toMs = (d: string) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day);
};
const fromMs = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
export const addDays = (d: string, n: number) => fromMs(toMs(d) + n * DAY);
const monthStart = (y: number, m: number) => `${y}-${pad(m)}-01`; // m: 1-12 (may overflow handled by caller)
const lastDayOfMonth = (y: number, m: number) => fromMs(Date.UTC(y, m, 1) - DAY); // m: 1-12

/** Start year of the fiscal year containing `today` (e.g. 2026-03-31 with April start → 2025). */
export function fyStartYear(today: string, fyStartMonth: number): number {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const start = Math.min(12, Math.max(1, Math.trunc(fyStartMonth) || 4));
  return m >= start ? y : y - 1;
}

function fyRange(startYear: number, fyStartMonth: number): DateRange {
  const sm = Math.min(12, Math.max(1, Math.trunc(fyStartMonth) || 4));
  const from = monthStart(startYear, sm);
  const endY = sm === 1 ? startYear : startYear + 1;
  const endM = sm === 1 ? 12 : sm - 1;
  return { from, to: lastDayOfMonth(endY, endM) };
}

export function presetRange(preset: DatePreset, today: string, fyStartMonth: number): DateRange | null {
  const [y, m] = today.split('-').map(Number) as [number, number];
  switch (preset) {
    case 'none': return null;
    case 'today': return { from: today, to: today };
    case 'this_week': {
      // ISO weeks: Monday start.
      const dow = (new Date(toMs(today)).getUTCDay() + 6) % 7;
      const from = addDays(today, -dow);
      return { from, to: addDays(from, 6) };
    }
    case 'this_month': return { from: monthStart(y, m), to: lastDayOfMonth(y, m) };
    case 'last_month': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: monthStart(py, pm), to: lastDayOfMonth(py, pm) };
    }
    case 'this_fy': return fyRange(fyStartYear(today, fyStartMonth), fyStartMonth);
    case 'last_30_days': return { from: addDays(today, -29), to: today };
    case 'last_90_days': return { from: addDays(today, -89), to: today };
  }
}

/** The comparable previous period (KPI delta): yesterday, last week, the month before, last FY, the prior N days. */
export function previousRange(preset: DatePreset, today: string, fyStartMonth: number): DateRange | null {
  const cur = presetRange(preset, today, fyStartMonth);
  if (!cur) return null;
  switch (preset) {
    case 'this_month': case 'last_month': {
      const [y, m] = cur.from.split('-').map(Number) as [number, number];
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: monthStart(py, pm), to: lastDayOfMonth(py, pm) };
    }
    case 'this_fy': return fyRange(fyStartYear(today, fyStartMonth) - 1, fyStartMonth);
    default: {
      const days = Math.round((toMs(cur.to) - toMs(cur.from)) / DAY) + 1;
      return { from: addDays(cur.from, -days), to: addDays(cur.from, -1) };
    }
  }
}

/** 'YYYY-MM-DD' of an instant in a timezone (falls back to UTC for an unknown zone). */
export function localDate(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export const isDateStr = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && fromMs(toMs(v)) === v;

/**
 * Numbering patterns (pure). Tokens: {PREFIX} (doc type key upper-cased), {LOC} location code, {FY} '2026-27',
 * {FYS} '26-27', {YYYY}, {YY}, {MM}, {SEQ:n} zero-padded sequence. Literal text is kept as typed.
 */
export type ResetPolicy = 'never' | 'fy' | 'month';

export interface NumberContext {
  prefix: string;
  locationCode: string;
  /** 'YYYY-MM-DD' — the document date. */
  date: string;
  /** 1–12; April = 4 (India). */
  fyStartMonth: number;
}

/** Financial year of a date: start year plus '2026-27' / '26-27' labels (a January start gives '2026' / '26'). */
export function financialYear(date: string, fyStartMonth: number): { start: number; fy: string; fys: string } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const startMonth = Math.min(12, Math.max(1, Math.trunc(fyStartMonth) || 4));
  const start = m >= startMonth ? y : y - 1;
  if (startMonth === 1) return { start, fy: String(start), fys: String(start % 100).padStart(2, '0') };
  const end = (start + 1) % 100;
  return { start, fy: `${start}-${String(end).padStart(2, '0')}`, fys: `${String(start % 100).padStart(2, '0')}-${String(end).padStart(2, '0')}` };
}

/** Counter period for a reset policy: 'all', the FY label, or 'YYYY-MM'. */
export function periodOf(reset: ResetPolicy, date: string, fyStartMonth: number): string {
  if (reset === 'never') return 'all';
  if (reset === 'month') return date.slice(0, 7);
  return financialYear(date, fyStartMonth).fy;
}

export const SEQ_RE = /\{SEQ:([1-9])\}/;

export function renderNumber(pattern: string, c: NumberContext, seq: number | bigint): string {
  const fy = financialYear(c.date, c.fyStartMonth);
  const [y, m] = c.date.split('-') as [string, string];
  return pattern
    .replace(/\{PREFIX\}/g, c.prefix.toUpperCase())
    .replace(/\{LOC\}/g, c.locationCode)
    .replace(/\{FYS\}/g, fy.fys)
    .replace(/\{FY\}/g, fy.fy)
    .replace(/\{YYYY\}/g, y)
    .replace(/\{YY\}/g, y.slice(2))
    .replace(/\{MM\}/g, m)
    .replace(/\{SEQ:([1-9])\}/g, (_s, n: string) => String(seq).padStart(Number(n), '0'));
}

/** Unknown `{TOKEN}`s in a pattern (shown as validation errors). */
export function unknownTokens(pattern: string): string[] {
  const known = /^(PREFIX|LOC|FY|FYS|YYYY|YY|MM|SEQ:[1-9])$/;
  return [...pattern.matchAll(/\{([^}]*)\}/g)].map(m => m[1]!).filter(t => !known.test(t));
}

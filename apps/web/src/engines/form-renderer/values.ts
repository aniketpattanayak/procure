/**
 * Value helpers shared by the renderer, the grid and validation. Numbers travel as decimal strings ("1250.50"),
 * never floats; formatting for display uses Intl with en-IN grouping (lakh/crore) by default.
 */
import type { DataField, Field, GridColumn } from '@procure/schema';

export const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && v !== null && 'from' in v && !(v as { from?: string }).from && !(v as { to?: string }).to);

export const NUMERIC_TYPES = new Set(['number', 'decimal', 'currency', 'percentage']);

/** Decimal places for a numeric field (number = 0; others default 2). */
export function precisionOf(f: { type: string; precision?: number }): number {
  if (f.type === 'number') return 0;
  return f.precision ?? 2;
}

/** Normalise free typing into a decimal string ('' when not a number). Allows a trailing dot while typing. */
export function sanitizeDecimal(raw: string, allowNegative = true): string {
  let s = raw.replace(/[,\s₹$€£]/g, '');
  if (!allowNegative) s = s.replace(/-/g, '');
  const m = s.match(/^-?\d*\.?\d*/);
  return m ? m[0] : '';
}

/** Fix a decimal string to `places` (half-up, string arithmetic, no float drift). */
export function toFixedDecimal(s: string, places: number): string {
  if (s === '' || s === '-' || s === '.') return '';
  const neg = s.startsWith('-');
  let [int = '0', frac = ''] = (neg ? s.slice(1) : s).split('.');
  int = int.replace(/^0+(?=\d)/, '') || '0';
  if (frac.length > places) {
    const roundUp = Number(frac[places]) >= 5;
    frac = frac.slice(0, places);
    if (roundUp) {
      const digits = (int + frac).split('').map(Number);
      let i = digits.length - 1;
      while (i >= 0) {
        if (digits[i]! < 9) { digits[i]!++; break; }
        digits[i] = 0;
        i--;
      }
      if (i < 0) digits.unshift(1);
      const all = digits.join('');
      int = all.slice(0, all.length - places) || '0';
      frac = all.slice(all.length - places);
    }
  }
  frac = frac.padEnd(places, '0');
  const out = places > 0 ? `${int}.${frac}` : int;
  return neg && /[1-9]/.test(out) ? `-${out}` : out;
}

export function compareDecimal(a: string, b: number): number {
  const n = Number(a);
  return n === b ? 0 : n < b ? -1 : 1;
}

const groupCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, places: number, currency?: string) {
  const k = `${locale}|${places}|${currency ?? ''}`;
  let f = groupCache.get(k);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, currency
        ? { style: 'currency', currency, minimumFractionDigits: places, maximumFractionDigits: places }
        : { minimumFractionDigits: places, maximumFractionDigits: places });
    } catch {
      f = new Intl.NumberFormat(locale, { minimumFractionDigits: places, maximumFractionDigits: places });
    }
    groupCache.set(k, f);
  }
  return f;
}

/**
 * Grouped display of a decimal string. Integer part is grouped with Intl on a BigInt (exact for any length); the
 * fraction is kept as typed and padded, so "12345678.5" -> "1,23,45,678.50" in en-IN.
 */
export function formatDecimal(value: unknown, places: number, opts: { currency?: string; percent?: boolean; locale?: string } = {}): string {
  if (value === null || value === undefined || value === '') return '';
  const s = toFixedDecimal(String(value), places);
  if (!s) return String(value);
  const locale = opts.locale ?? 'en-IN';
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  let grouped: string;
  try {
    grouped = new Intl.NumberFormat(locale).format(BigInt(int!));
  } catch {
    grouped = int!;
  }
  let body = frac ? `${grouped}.${frac}` : grouped;
  if (opts.currency) {
    // Take the symbol placement from Intl, apply it to the exact digits.
    const parts = nf(locale, places, opts.currency).formatToParts(0);
    const sym = parts.find(p => p.type === 'currency')?.value ?? opts.currency;
    const symFirst = parts.findIndex(p => p.type === 'currency') < parts.findIndex(p => p.type === 'integer');
    body = symFirst ? `${sym}${body}` : `${body} ${sym}`;
  }
  if (opts.percent) body = `${body}%`;
  return neg ? `-${body}` : body;
}

export function currencySymbol(currency: string, locale = 'en-IN'): string {
  try {
    return nf(locale, 0, currency).formatToParts(0).find(p => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

/** Default value for a fresh form, from field defaults. */
export function defaultFor(f: DataField | GridColumn, today: string): unknown {
  const d = (f as { default?: unknown }).default;
  if (f.type === 'date' && d === 'today') return today;
  if (d === undefined || d === null) {
    if (f.type === 'grid') return Array.from({ length: f.minRows }, () => ({ _row: newRowId() }));
    return undefined;
  }
  if (NUMERIC_TYPES.has(f.type) && typeof d === 'number') return toFixedDecimal(String(d), precisionOf(f));
  return d;
}

export function initialValues(fields: Field[], today: string, existing: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const f of fields) {
    if (f.type === 'tab' || f.type === 'section' || f.type === 'divider' || f.type === 'help' || f.removed) continue;
    if (f.key in out) continue;
    const d = defaultFor(f, today);
    if (d !== undefined) out[f.key] = d;
  }
  return out;
}

export function newRowId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ------------------------------------------------------------------ Indian tax ids

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** GSTIN check digit (mod-36 Luhn variant), same rule the server applies. */
export function gstinValid(v: string): boolean {
  if (!GSTIN_RE.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const code = GSTIN_CHARS.indexOf(v[i]!);
    const prod = code * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  return GSTIN_CHARS[check] === v[14];
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_RE = /^\+?[0-9][0-9\s-]{6,18}$/;
export function urlValid(v: string) {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

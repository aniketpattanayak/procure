/**
 * Exact decimal arithmetic on decimal strings (quantities travel as strings, never floats). Fixed scale of 6
 * places covers every quantity precision the forms allow; results are trimmed of trailing zeros.
 */
const SCALE = 6;
const F = 10n ** BigInt(SCALE);

export const DEC_RE = /^\d+(\.\d+)?$/;

export function toUnits(v: unknown): bigint {
  if (v === null || v === undefined || v === '') return 0n;
  const s = String(v).trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === '-' || s === '.') return 0n;
  const neg = s.startsWith('-');
  const [i = '0', f = ''] = (neg ? s.slice(1) : s).split('.');
  const n = BigInt(i || '0') * F + BigInt((f + '0'.repeat(SCALE)).slice(0, SCALE) || '0');
  return neg ? -n : n;
}

export function fromUnits(n: bigint): string {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const int = abs / F;
  const frac = (abs % F).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

export const dec = {
  add: (...xs: unknown[]) => fromUnits(xs.reduce<bigint>((s, x) => s + toUnits(x), 0n)),
  sub: (a: unknown, b: unknown) => fromUnits(toUnits(a) - toUnits(b)),
  cmp: (a: unknown, b: unknown) => { const x = toUnits(a); const y = toUnits(b); return x === y ? 0 : x < y ? -1 : 1; },
  isZero: (a: unknown) => toUnits(a) === 0n,
  gt0: (a: unknown) => toUnits(a) > 0n,
  max0: (a: unknown) => { const x = toUnits(a); return fromUnits(x < 0n ? 0n : x); },
  norm: (a: unknown) => fromUnits(toUnits(a)),
  /** Share of `part` in `whole` as 0–100 (display only). */
  pct: (part: unknown, whole: unknown) => { const w = toUnits(whole); return w === 0n ? 0 : Number((toUnits(part) * 10000n) / w) / 100; },
};

/** Whether the text is a valid non-negative decimal (allows "12." while typing → invalid until completed). */
export function isDecimal(s: string) {
  return DEC_RE.test(s.trim());
}

/** Display a decimal string with en-IN grouping, keeping its own places (no rounding of quantities). */
export function fmtQty(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = fromUnits(toUnits(v));
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  let g = i!;
  try { g = new Intl.NumberFormat('en-IN').format(BigInt(i!)); } catch { /* keep raw */ }
  return `${neg ? '-' : ''}${g}${f ? `.${f}` : ''}`;
}

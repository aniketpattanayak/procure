/**
 * Client-side previews for quotes (display only; the server computes the figures that count).
 * Rates are shown with 2–4 decimals; quantities stay exact decimal strings via documents/decimal.
 */
export interface SlabLike { fromQty: string; toQty?: string; rate?: string; discountPct?: string }

const n = (v: unknown) => {
  const x = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(x) ? x : 0;
};
export const num = n;

/** The slab that applies at `qty` (highest `fromQty` ≤ qty whose `toQty` is open or ≥ qty). */
export function slabAt(slabs: SlabLike[], qty: number): SlabLike | null {
  let best: SlabLike | null = null;
  for (const s of slabs) {
    const from = n(s.fromQty);
    const to = s.toQty === undefined || s.toQty === '' ? Infinity : n(s.toQty);
    if (qty >= from && qty <= to && (!best || from >= n(best.fromQty))) best = s;
  }
  return best;
}

export function effectiveRate(base: unknown, slabs: SlabLike[], qty: number): number {
  const s = slabAt(slabs, qty);
  if (!s) return n(base);
  if (s.rate !== undefined && s.rate !== '') return n(s.rate);
  return n(base) * (1 - n(s.discountPct) / 100);
}

export function freightPerUnit(freight: unknown, basis: 'lump_sum' | 'per_unit' | undefined, qty: number): number {
  if (basis === 'per_unit') return n(freight);
  return qty > 0 ? n(freight) / qty : 0;
}

/** Default landed cost formula (`procurement.landed_cost_formula` default). */
export function landedPerUnit(rate: number, taxPct: unknown, fpu: number): number {
  return rate * (1 + n(taxPct) / 100) + fpu;
}

/** Problems in a slab list, by row index (overlaps, from > to, missing value). */
export function slabIssues(slabs: SlabLike[]): Record<number, 'range' | 'overlap' | 'value'> {
  const out: Record<number, 'range' | 'overlap' | 'value'> = {};
  slabs.forEach((s, i) => {
    const hasRate = s.rate !== undefined && s.rate !== '';
    const hasPct = s.discountPct !== undefined && s.discountPct !== '';
    if (hasRate === hasPct) out[i] = 'value';
    else if (s.toQty !== undefined && s.toQty !== '' && n(s.toQty) < n(s.fromQty)) out[i] = 'range';
  });
  const sorted = slabs.map((s, i) => ({ i, from: n(s.fromQty), to: s.toQty === undefined || s.toQty === '' ? Infinity : n(s.toQty) })).sort((a, b) => a.from - b.from);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k]!.from <= sorted[k - 1]!.to && out[sorted[k]!.i] === undefined) out[sorted[k]!.i] = 'overlap';
  }
  return out;
}

export function fmtRate(v: unknown, currency = 'INR', maxDigits = 2): string {
  const x = n(v);
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, maxDigits) }).format(x);
  } catch {
    return `${currency} ${x.toFixed(2)}`;
  }
}

export function fmtPct(v: unknown): string {
  const x = n(v);
  return `${Number.isInteger(x) ? x : x.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** "12 Nov" (short, same-year friendly). */
export function fmtShortDate(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

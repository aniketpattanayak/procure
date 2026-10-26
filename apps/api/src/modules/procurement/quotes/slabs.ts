import { evaluate } from '@procure/formula';
import Decimal from 'decimal.js';

/**
 * Pure quote maths (unit-tested table-driven): slab validation, slab application at a quantity, freight per unit and
 * landed cost through the tenant formula. Decimal strings in, decimal strings out — no floats.
 */
export interface Slab { fromQty: string; toQty?: string; rate?: string; discountPct?: string }
export interface SlabIssue { path: string; message: string }

const D = (v: string | number) => new Decimal(v);
export const fmt = (d: Decimal, dp = 4): string => d.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

/** Slabs sorted by fromQty must be consistent (to ≥ from, discount ≤ 100) and must not overlap; an open-ended slab must be last. */
export function validateSlabs(slabs: Slab[]): SlabIssue[] {
  const issues: SlabIssue[] = [];
  const order = slabs.map((s, i) => ({ s, i })).sort((a, b) => D(a.s.fromQty).cmp(D(b.s.fromQty)));
  order.forEach(({ s, i }, k) => {
    if (s.toQty !== undefined && D(s.toQty).lt(D(s.fromQty))) issues.push({ path: `slabs.${i}.toQty`, message: 'Slab "to" quantity must not be below "from".' });
    if (s.discountPct !== undefined && D(s.discountPct).gt(100)) issues.push({ path: `slabs.${i}.discountPct`, message: 'Discount cannot exceed 100%.' });
    const next = order[k + 1];
    if (!next) return;
    if (s.toQty === undefined) issues.push({ path: `slabs.${i}.toQty`, message: 'Only the last slab may be open-ended.' });
    else if (D(next.s.fromQty).lte(D(s.toQty))) issues.push({ path: `slabs.${next.i}.fromQty`, message: 'Slabs overlap.' });
  });
  return issues;
}

/** Rate at `qty`: the matching slab's absolute rate, or the base rate less its discount; no matching slab → base rate. */
export function effectiveRate(quotedRate: string, slabs: Slab[], qty: string): string {
  const q = D(qty);
  const hit = slabs.find(s => q.gte(D(s.fromQty)) && (s.toQty === undefined || q.lte(D(s.toQty))));
  if (!hit) return fmt(D(quotedRate));
  if (hit.rate !== undefined) return fmt(D(hit.rate));
  return fmt(D(quotedRate).times(D(100).minus(D(hit.discountPct ?? '0'))).dividedBy(100));
}

export function freightPerUnit(freight: string, basis: 'lump_sum' | 'per_unit', qty: string): string {
  if (basis === 'per_unit') return fmt(D(freight));
  const q = D(qty);
  return q.isZero() ? '0' : fmt(D(freight).dividedBy(q));
}

export const DEFAULT_LANDED_FORMULA = 'rate * (1 + tax_pct / 100) + freight_per_unit';

export interface LandedInput { rate: string; qty: string; freight: string; freight_per_unit: string; tax_pct: string; lead_time_days: number | null; moq: string | null }

/** Landed cost per unit via the tenant formula; a formula error falls back to the default formula. */
export function landedCost(formula: string, v: LandedInput, today = new Date().toISOString().slice(0, 10)): { perUnit: string; usedDefault: boolean } {
  const values = { ...v, moq: v.moq ?? '0', lead_time_days: v.lead_time_days ?? 0 };
  const run = (src: string) => evaluate(src, { values, today, defaultPrecision: 4 });
  let r = run(formula);
  let usedDefault = false;
  if (r.error || safeDec(r.value) === null) {
    r = run(DEFAULT_LANDED_FORMULA);
    usedDefault = true;
  }
  return { perUnit: fmt(safeDec(r.value) ?? D(0)), usedDefault };
}

function safeDec(v: unknown): Decimal | null {
  try {
    if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) return D(v);
  } catch {
    return null;
  }
  return null;
}

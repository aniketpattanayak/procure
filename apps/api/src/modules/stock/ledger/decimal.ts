import Decimal from 'decimal.js';

/** Exact decimal arithmetic for stock (numeric(18,4) qty/value, numeric(18,6) unit cost). Never floats. */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

const DEC_RE = /^-?\d{1,14}(\.\d{1,12})?$/;

export const dec = (v: string | number | null | undefined): Dec => new D(v === null || v === undefined || v === '' ? 0 : v);
export const isDec = (v: unknown): v is string => typeof v === 'string' && DEC_RE.test(v.trim());

/** Quantity / value (4 dp) as a canonical string ("12.5", "0"). */
export const q4 = (d: Dec): string => d.toDecimalPlaces(4).toFixed();
/** Unit cost (6 dp) as a canonical string. */
export const c6 = (d: Dec): string => d.toDecimalPlaces(6).toFixed();
/** Rounds to 4 dp (stored precision of qty and value). */
export const r4 = (d: Dec): Dec => d.toDecimalPlaces(4);
/** Normalises a stored numeric ("10.5000") to canonical form ("10.5"). */
export const canon = (v: string | number | null | undefined): string => dec(v).toFixed();

import type Decimal from 'decimal.js';
import type { FormulaType } from '@procure/schema';
import { formatIsoDate, parseIsoDate } from './dates';
import { D, isDec, type Dec } from './util';

/** A calendar date as a day number (days since 1970-01-01). */
export class DateV {
  constructor(readonly days: number) {}
}

/** Runtime value. Empty text is always normalised to null. */
export type RV = Dec | string | boolean | null | DateV | readonly string[];

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Decimal from a decimal string / JS number / Decimal, or undefined when it isn't one. */
export function toDecimal(raw: unknown): Dec | undefined {
  if (isDec(raw)) return new D(raw);
  if (typeof raw === 'number') return Number.isFinite(raw) ? new D(raw) : undefined;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.length > 0 && s.length <= 100 && NUMERIC.test(s)) {
      const d = new D(s);
      return d.isFinite() ? d : undefined;
    }
  }
  return undefined;
}

export class ConversionError {
  constructor(readonly expected: string) {}
}

/**
 * Raw stored value -> runtime value, guided by the declared type of the field. Throws ConversionError when the
 * stored value cannot be the declared type (e.g. 'abc' in a number field).
 */
export function toRuntime(raw: unknown, type: FormulaType): RV {
  if (raw === undefined || raw === null || raw === '') return null;
  switch (type) {
    case 'number': {
      const d = toDecimal(raw);
      if (d === undefined) throw new ConversionError('a number');
      return d;
    }
    case 'date': {
      const days = typeof raw === 'string' ? parseIsoDate(raw) : null;
      if (days === null) throw new ConversionError("a date ('YYYY-MM-DD')");
      return new DateV(days);
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 'TRUE') return true;
      if (raw === 'false' || raw === 'FALSE') return false;
      throw new ConversionError('TRUE/FALSE');
    case 'text':
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
      throw new ConversionError('text');
    case 'list':
      if (Array.isArray(raw)) {
        const items = raw
          .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
          .map(String);
        return items.length === 0 ? null : items;
      }
      if (typeof raw === 'string') return [raw];
      throw new ConversionError('a list');
    default:
      return inferRuntime(raw);
  }
}

/** Untyped value -> runtime value by its shape: numbers and numeric strings, ISO dates, booleans, lists, text. */
export function inferRuntime(raw: unknown): RV {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'boolean') return raw;
  const d = toDecimal(raw);
  if (d !== undefined) return d;
  if (typeof raw === 'string') {
    const days = parseIsoDate(raw);
    return days === null ? raw : new DateV(days);
  }
  if (Array.isArray(raw)) return toRuntime(raw, 'list');
  return null; // objects (daterange, files…) are not formula values
}

/** Plain decimal text: no exponent, no trailing zeros, never '-0'. */
export function plainNumber(d: Dec): string {
  return d.isZero() ? '0' : d.toFixed();
}

/** Text form used by & / CONCAT / TEXT: numbers plain, dates ISO, booleans TRUE/FALSE, empty ''. */
export function toText(v: RV): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof DateV) return formatIsoDate(v.days);
  if (isDec(v)) return plainNumber(v);
  return v.join(', ');
}

export const textOrNull = (s: string): string | null => (s === '' ? null : s);

/** Round with the given mode to `places` decimal places (negative = tens, hundreds…). */
export function roundTo(x: Dec, places: number, mode: Decimal.Rounding): Dec {
  if (places >= 0) return x.toDecimalPlaces(places, mode);
  const f = new D(10).pow(-places);
  return x.div(f).toDecimalPlaces(0, mode).times(f);
}

/** Fixed-places decimal string, half-up, never '-0.00'. */
export function fixed(x: Dec, places: number): string {
  const r = x.toDecimalPlaces(places, D.ROUND_HALF_UP);
  return (r.isZero() ? r.abs() : r).toFixed(places);
}

/** Runtime value -> JSON-friendly output (numbers as decimal strings, dates ISO). */
export function toOutput(v: RV, precision?: number): unknown {
  if (v instanceof DateV) return formatIsoDate(v.days);
  if (isDec(v)) return precision === undefined ? plainNumber(v) : fixed(v, precision);
  if (Array.isArray(v)) return [...(v as string[])];
  return v;
}

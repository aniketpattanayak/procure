import Decimal from 'decimal.js';
import type { FormulaError } from '@procure/schema';

/**
 * Private decimal.js constructor: 40 significant digits (>= 34 required), half-up rounding. Exponents are capped at
 * +/-1000 so an expression can never build a million-digit number; overflow becomes Infinity, which the evaluator
 * reports as a runtime error. A clone keeps the global Decimal untouched for other packages.
 */
export const D = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1000,
  toExpPos: 1000,
  maxE: 1000,
  minE: -1000,
});
export type Dec = Decimal;

export const isDec = (v: unknown): v is Dec => D.isDecimal(v);

/** Thrown internally; always carries a contract-shaped FormulaError. */
export class Fail {
  constructor(public readonly error: FormulaError) {}
}

export function fail(code: FormulaError['code'], message: string, start?: number, end?: number): never {
  throw new Fail({ code, message, start, end });
}

const hasOwnProp = Object.prototype.hasOwnProperty;

/** Own-property read only: never walks the prototype chain, so 'constructor' / '__proto__' read as absent. */
export function own<T>(obj: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
  return hasOwnProp.call(obj, key) ? obj[key] : undefined;
}

/** Copy own enumerable props without ever triggering the `__proto__` setter. */
export function safeCopy(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (k === '__proto__')
      Object.defineProperty(out, k, { value: src[k], enumerable: true, writable: true, configurable: true });
    else out[k] = src[k];
  }
  return out;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

/** Closest candidate within edit distance 2 (case-insensitive), ties broken by candidate order. */
export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  const lower = name.toLowerCase();
  for (const c of candidates) {
    if (c === '*') continue;
    const d = levenshtein(lower, c.toLowerCase());
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export const didYouMean = (s: string | undefined): string => (s === undefined ? '' : ` Did you mean '${s}'?`);

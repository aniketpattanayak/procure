import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluate, parse } from '../src';
import { daysFromCivil, formatIsoDate } from '../src/dates';
import { TODAY } from './helpers';

const ev = (src: string, values: Record<string, unknown> = {}) => evaluate(src, { values, today: TODAY });

/** Exact decimal text of bigint / 10^scale. */
function dec(n: bigint, scale: number): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(scale + 1, '0');
  const body = scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
  return (neg ? '-' : '') + body;
}
/** Canonical form (what the engine prints): no trailing zeros, no '-0'. */
function canon(n: bigint, scale: number): string {
  if (n === 0n) return '0';
  let s = dec(n, scale);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

const big = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n });
const scale = fc.integer({ min: 0, max: 8 });

describe('property-based (fast-check)', () => {
  it('parse and evaluate never throw on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), s => {
        const p = parse(s);
        expect(p.ast === null).toBe(p.errors.length > 0);
        const r = ev(s, { qty: '2', name: 'x', lines: [{ a: '1' }] });
        expect(r.error === undefined || typeof r.error.message === 'string').toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('parse never throws on token soup', () => {
    const tok = fc.constantFrom(
      'qty',
      'lines.a',
      '1',
      '2.5',
      "'t'",
      '(',
      ')',
      ',',
      '+',
      '-',
      '*',
      '/',
      '%',
      '&',
      '=',
      '<>',
      '<=',
      'AND',
      'OR',
      'NOT',
      '!',
      'SUM(',
      'IF(',
      'NULL',
      'TRUE',
      ' ',
    );
    fc.assert(
      fc.property(fc.array(tok, { maxLength: 60 }), toks => {
        const src = toks.join(' ');
        parse(src);
        ev(src, { qty: '3', lines: [{ a: '1' }] });
      }),
      { numRuns: 3000 },
    );
  });

  it('addition, subtraction and multiplication are exact', () => {
    fc.assert(
      fc.property(big, big, scale, scale, (a, b, sa, sb) => {
        const s = Math.max(sa, sb);
        const A = a * 10n ** BigInt(s - sa);
        const B = b * 10n ** BigInt(s - sb);
        expect(ev(`x + y`, { x: dec(a, sa), y: dec(b, sb) }).value).toBe(canon(A + B, s));
        expect(ev(`x - y`, { x: dec(a, sa), y: dec(b, sb) }).value).toBe(canon(A - B, s));
      }),
    );
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }),
        scale,
        scale,
        (a, b, sa, sb) => {
          expect(ev('x * y', { x: dec(a, sa), y: dec(b, sb) }).value).toBe(canon(a * b, sa + sb));
        },
      ),
    );
  });

  it('ROUND is half-up (away from zero) at any place', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 5 }),
        (n, s, p) => {
          fc.pre(p < s);
          const f = 10n ** BigInt(s - p);
          const abs = n < 0n ? -n : n;
          const q = (abs * 2n + f) / (2n * f); // half-up on magnitude
          const r = n < 0n ? -q : q;
          expect(ev(`ROUND(x, ${p})`, { x: dec(n, s) }).value).toBe(canon(r, p));
        },
      ),
    );
  });

  it('ADD_DAYS and DAYS_BETWEEN are inverse; matches day-number arithmetic', () => {
    const date = fc.integer({ min: daysFromCivil(1900, 1, 1), max: daysFromCivil(2200, 12, 31) });
    fc.assert(
      fc.property(date, fc.integer({ min: -40000, max: 40000 }), (d, n) => {
        const iso = formatIsoDate(d);
        const added = ev(`ADD_DAYS(d, ${n})`, { d: iso }).value as string;
        expect(added).toBe(formatIsoDate(d + n));
        expect(ev('DAYS_BETWEEN(a, b)', { a: iso, b: added }).value).toBe(String(n));
        expect(ev('b - a', { a: iso, b: added }).value).toBe(String(n));
      }),
    );
  });

  it('day numbers agree with UTC epoch arithmetic', () => {
    fc.assert(
      fc.property(fc.integer({ min: -700000, max: 2900000 }), d => {
        // Reference uses UTC millis only (no local-time parsing), purely as an oracle in the test.
        expect(formatIsoDate(d)).toBe(new globalThis.Date(d * 86400000).toISOString().slice(0, 10));
      }),
    );
  });

  it('comparisons are consistent with subtraction', () => {
    fc.assert(
      fc.property(big, big, scale, (a, b, s) => {
        const vals = { x: dec(a, s), y: dec(b, s) };
        expect(ev('x < y', vals).value).toBe(a < b);
        expect(ev('x = y', vals).value).toBe(a === b);
        expect(ev('x >= y', vals).value).toBe(a >= b);
      }),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { FUNCTIONS, parse } from '../src';
import { FN_SPECS } from '../src/functions';
import { err, val } from './helpers';

const lines = [
  {
    _row: 'r1',
    item: 'A',
    qty: '10',
    rate: '2.5',
    amount: '25',
    taxable: true,
    status: 'Open',
    delivery: '2026-11-05',
  },
  {
    _row: 'r2',
    item: 'B',
    qty: '4',
    rate: '10',
    amount: '40',
    taxable: false,
    status: 'Rejected',
    delivery: '2026-10-30',
  },
  { _row: 'r3', item: 'C', qty: null, rate: '1.25', amount: '0.5', taxable: true, status: 'Open', delivery: null },
];
const V = { lines, tags: ['red', 'blue'], none: [] as string[] };

describe('IF / IFS', () => {
  it('IF', () => {
    expect(val("IF(1 < 2, 'yes', 'no')")).toBe('yes');
    expect(val("IF(1 > 2, 'yes', 'no')")).toBe('no');
    expect(val("IF(1 > 2, 'yes')")).toBeNull();
  });
  it('slab-style IFS', () => {
    const slab = 'IFS(total > 100000, total * 0.05, total > 50000, total * 0.03, total > 10000, total * 0.01, 0)';
    expect(val(slab, { total: '200000' }, { defaultPrecision: 2 })).toBe('10000.00');
    expect(val(slab, { total: '100000' }, { defaultPrecision: 2 })).toBe('3000.00');
    expect(val(slab, { total: '50000.01' }, { defaultPrecision: 2 })).toBe('1500.00');
    expect(val(slab, { total: '12345' }, { defaultPrecision: 2 })).toBe('123.45');
    expect(val(slab, { total: '10000' }, { defaultPrecision: 2 })).toBe('0.00');
    expect(val(slab, {}, { defaultPrecision: 2 })).toBe('0.00');
  });
  it('IFS without default returns empty', () => {
    expect(val('IFS(FALSE, 1, FALSE, 2)')).toBeNull();
    expect(val('IFS(FALSE, 1, TRUE, 2)')).toBe('2');
  });
});

describe('number functions', () => {
  it.each([
    ['ROUND(2.675, 2)', '2.68'],
    ['ROUND(2.5)', '3'],
    ['ROUND(-2.5)', '-3'],
    ['ROUND(2.4999)', '2'],
    ['ROUND(1234.5, -2)', '1200'],
    ['ROUND(1250, -2)', '1300'],
    ['ROUND(NULL, 2)', '0'],
    ['ROUND(1.23456789, 4.9)', '1.2346'],
    ['FLOOR(2.7)', '2'],
    ['FLOOR(-2.1)', '-3'],
    ['FLOOR(2.789, 2)', '2.78'],
    ['FLOOR(1299, -2)', '1200'],
    ['CEIL(2.1)', '3'],
    ['CEIL(-2.9)', '-2'],
    ['CEIL(2.781, 2)', '2.79'],
    ['CEIL(1201, -2)', '1300'],
    ['ABS(-3.5)', '3.5'],
    ['ABS(3)', '3'],
    ['ABS(NULL)', '0'],
  ])('%s = %s', (src, expected) => expect(val(src)).toBe(expected));
  it('places out of range', () => {
    expect(err('ROUND(1, 21)')).toMatchObject({
      code: 'RUNTIME',
      message: 'Decimal places must be between -20 and 20',
      start: 9,
      end: 11,
    });
    expect(err('ROUND(1, x)', { x: 'abc' })).toMatchObject({ code: 'RUNTIME' });
  });
});

describe('aggregates', () => {
  it('SUM / AVG / MIN / MAX / COUNT over a grid column', () => {
    expect(val('SUM(lines.amount)', V)).toBe('65.5');
    expect(val('SUM(lines.qty * lines.rate)', V)).toBe('65');
    expect(val('AVG(lines.qty)', V)).toBe('7'); // nulls skipped
    expect(val('MIN(lines.rate)', V)).toBe('1.25');
    expect(val('MAX(lines.rate)', V)).toBe('10');
    expect(val('MAX(lines.delivery)', V)).toBe('2026-11-05');
    expect(val('MIN(lines.delivery)', V)).toBe('2026-10-30');
    expect(val('COUNT(lines)', V)).toBe('3');
    expect(val('COUNT(lines.qty)', V)).toBe('2');
    expect(val('COUNT(lines, lines.delivery)', V)).toBe('5');
  });
  it('scalar forms', () => {
    expect(val('SUM(1, 2, 3.5)')).toBe('6.5');
    expect(val('SUM(1, NULL)')).toBe('1');
    expect(val('AVG(1, 2, 2)', {}, { defaultPrecision: 2 })).toBe('1.67');
    expect(val('MIN(3, 1, 2)')).toBe('1');
    expect(val('MAX(3, 1, 2)')).toBe('3');
    expect(val('MIN(NULL, 4)')).toBe('4');
    expect(val("MAX(DATE('2024-02-29'), DATE('2024-03-01'))")).toBe('2024-03-01');
    expect(val('COUNT(1, NULL, 2)')).toBe('2');
    expect(val('SUM(lines.amount, 10)', V)).toBe('75.5');
  });
  it('empty sets', () => {
    expect(val('SUM(lines.amount)', { lines: [] })).toBe('0');
    expect(val('AVG(lines.amount)', { lines: [{ amount: null }] })).toBeNull();
    expect(val('MIN(lines.amount)', { lines: [{ amount: null }] })).toBeNull();
    expect(val('COUNT(lines)', { lines: [{ a: 1 }], other: 'x' })).toBe('1');
    expect(val('MAX(NULL)')).toBeNull();
  });
  it('multiselect COUNT / CONTAINS / ISBLANK', () => {
    expect(val('COUNT(tags)', V)).toBe('2');
    expect(val('COUNT(none)', V)).toBe('0');
    expect(val("CONTAINS(tags, 'red')", V)).toBe(true);
    expect(val("CONTAINS(tags, 'Red')", V)).toBe(false);
    expect(val('ISBLANK(none)', V)).toBe(true);
    expect(val('ISBLANK(tags)', V)).toBe(false);
  });
  it('SUMIF / COUNTIF', () => {
    expect(val('SUMIF(lines.amount, lines.taxable = TRUE)', V)).toBe('25.5');
    expect(val('SUMIF(lines.amount, lines.taxable)', V)).toBe('25.5');
    expect(val('SUMIF(lines.amount, NOT lines.taxable)', V)).toBe('40');
    expect(val("COUNTIF(lines.status = 'Open')", V)).toBe('2');
    expect(val("COUNTIF(lines.status = 'Closed')", V)).toBe('0');
    expect(val("SUMIF(lines.qty, lines.status = 'Open' AND lines.qty > 5)", V)).toBe('10');
  });
  it('runtime mixing of dates and numbers', () => {
    expect(err('MIN(a, b)', { a: '2026-01-01', b: '5' })).toMatchObject({
      code: 'RUNTIME',
      message: 'MIN cannot mix dates and numbers',
    });
    expect(err('SUM(a)', { a: 'abc' })).toMatchObject({ code: 'RUNTIME' });
    expect(err('AVG(a)', { a: 'abc' })).toMatchObject({ code: 'RUNTIME' });
    expect(err('MAX(a)', { a: 'abc' })).toMatchObject({ code: 'RUNTIME' });
  });
});

describe('COALESCE / ISBLANK', () => {
  it('COALESCE', () => {
    expect(val("COALESCE(NULL, '', 'x', 'y')")).toBe('x');
    expect(val('COALESCE(a, 0)')).toBe('0');
    expect(val('COALESCE(NULL)')).toBeNull();
  });
  it('ISBLANK', () => {
    expect(val('ISBLANK(NULL)')).toBe(true);
    expect(val("ISBLANK('')")).toBe(true);
    expect(val("ISBLANK(' ')")).toBe(false);
    expect(val('ISBLANK(0)')).toBe(false);
    expect(val('ISBLANK(x)', { x: '' })).toBe(true);
  });
});

describe('text functions', () => {
  it.each([
    ["CONCAT('a', 1, TRUE, NULL, 2.50)", 'a1TRUE2.5'],
    ["UPPER('abc')", 'ABC'],
    ["LOWER('ÄB')", 'äb'],
    ["TRIM('  x y  ')", 'x y'],
    ["LEFT('GSTIN', 2)", 'GS'],
    ["LEFT('abc')", 'a'],
    ["LEFT('abc', 10)", 'abc'],
    ["RIGHT('abcd', 2)", 'cd'],
    ["RIGHT('abc')", 'c'],
    ["RIGHT('abc', 99)", 'abc'],
    ["LEFT('😀ab', 1)", '😀'],
    ['TEXT(1234.5, 2)', '1234.50'],
    ['TEXT(2.675, 2)', '2.68'],
    ['TEXT(-0.001, 2)', '0.00'],
    ['TEXT(5)', '5'],
    ["TEXT(DATE('2026-01-02'))", '2026-01-02'],
    ['TEXT(1.5, 0)', '2'],
  ])('%s = %s', (src, expected) => expect(val(src)).toBe(expected));
  it('empty results are null', () => {
    expect(val('CONCAT(NULL)')).toBeNull();
    expect(val("TRIM('   ')")).toBeNull();
    expect(val("LEFT('abc', 0)")).toBeNull();
    expect(val("LEFT('abc', -1)")).toBeNull();
    expect(val("RIGHT('abc', 0)")).toBeNull();
    expect(val('UPPER(NULL)')).toBeNull();
    expect(val('LOWER(NULL)')).toBeNull();
    expect(val('TEXT(NULL, 2)')).toBeNull();
  });
  it('LEN counts characters', () => {
    expect(val("LEN('héllo')")).toBe('5');
    expect(val("LEN('😀')")).toBe('1');
    expect(val('LEN(NULL)')).toBe('0');
  });
  it('CONTAINS on text', () => {
    expect(val("CONTAINS('Hello', 'ell')")).toBe(true);
    expect(val("CONTAINS('Hello', 'ELL')")).toBe(false);
    expect(val("CONTAINS(NULL, 'x')")).toBe(false);
    expect(val("CONTAINS('x', NULL)")).toBe(false);
  });
  it('TEXT places out of range', () => expect(err('TEXT(1, 21)')).toMatchObject({ code: 'RUNTIME' }));
});

describe('FUNCTIONS metadata', () => {
  it('covers the minimum set from the contract', () => {
    const names = FUNCTIONS.map(f => f.name);
    for (const n of [
      'IF',
      'IFS',
      'AND',
      'OR',
      'NOT',
      'ROUND',
      'FLOOR',
      'CEIL',
      'ABS',
      'MIN',
      'MAX',
      'SUM',
      'AVG',
      'COUNT',
      'SUMIF',
      'COUNTIF',
      'COALESCE',
      'ISBLANK',
      'TODAY',
      'DAYS_BETWEEN',
      'ADD_DAYS',
      'YEAR',
      'MONTH',
      'DAY',
      'CONCAT',
      'UPPER',
      'LOWER',
      'TRIM',
      'LEN',
      'LEFT',
      'RIGHT',
      'CONTAINS',
      'TEXT',
    ]) {
      expect(names).toContain(n);
    }
  });
  it('every entry is complete, frozen and its example parses', () => {
    expect(Object.isFrozen(FUNCTIONS)).toBe(true);
    for (const f of FUNCTIONS) {
      expect(f.signature.startsWith(f.name)).toBe(true);
      expect(f.description.length).toBeGreaterThan(5);
      expect(parse(f.example).errors).toEqual([]);
      expect(FN_SPECS.has(f.name)).toBe(true);
    }
  });
});

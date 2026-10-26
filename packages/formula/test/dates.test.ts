import { describe, expect, it } from 'vitest';
import { civilFromDays, daysFromCivil, formatIsoDate, fromYmd, isLeapYear, parseIsoDate } from '../src/dates';
import { err, TODAY, val } from './helpers';

describe('calendar core', () => {
  it('epoch and round trips', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(civilFromDays(0)).toEqual([1970, 1, 1]);
    expect(formatIsoDate(daysFromCivil(1, 1, 1))).toBe('0001-01-01');
    expect(formatIsoDate(daysFromCivil(9999, 12, 31))).toBe('9999-12-31');
    expect(civilFromDays(daysFromCivil(1600, 2, 29))).toEqual([1600, 2, 29]);
  });
  it('leap years', () => {
    expect([1900, 2000, 2023, 2024, 2100].map(isLeapYear)).toEqual([false, true, false, true, false]);
  });
  it('strict ISO parsing', () => {
    expect(parseIsoDate('2024-02-29')).not.toBeNull();
    expect(parseIsoDate('2023-02-29')).toBeNull();
    expect(parseIsoDate('2026-04-31')).toBeNull();
    expect(parseIsoDate('2026-13-01')).toBeNull();
    expect(parseIsoDate('2026-1-01')).toBeNull();
    expect(parseIsoDate('0000-01-01')).toBeNull();
    expect(parseIsoDate('2026-01-01T00:00')).toBeNull();
    expect(fromYmd(2026, 1.5, 1)).toBeNull();
  });
});

describe('date maths in formulas (no timezone drift)', () => {
  it.each([
    ["ADD_DAYS('2024-02-28', 1)", '2024-02-29'],
    ["ADD_DAYS('2023-02-28', 1)", '2023-03-01'],
    ["ADD_DAYS('2100-02-28', 1)", '2100-03-01'],
    ["ADD_DAYS('2000-02-28', 1)", '2000-02-29'],
    ["ADD_DAYS('2025-12-31', 1)", '2026-01-01'],
    ["ADD_DAYS('2026-03-01', -1)", '2026-02-28'],
    ["ADD_DAYS('2024-03-01', -1)", '2024-02-29'],
    ["ADD_DAYS('2026-01-31', 30)", '2026-03-02'],
    ["ADD_DAYS('2026-03-29', 1)", '2026-03-30'], // EU DST weekend
    ["ADD_DAYS('2026-11-01', 1)", '2026-11-02'], // US DST weekend
    ["ADD_DAYS('2026-01-01', 1.9)", '2026-01-02'],
    ["ADD_DAYS('2026-01-01', 365)", '2027-01-01'],
    ["ADD_DAYS('2024-01-01', 366)", '2025-01-01'],
    ["DATE('2026-01-31') + 1", '2026-02-01'],
    ["1 + DATE('2026-01-31')", '2026-02-01'],
    ["DATE('2026-01-01') - 1", '2025-12-31'],
    ['DATE(2024, 2, 29)', '2024-02-29'],
    ['TODAY()', TODAY],
    ['TODAY() + 10', '2026-11-01'],
  ])('%s = %s', (src, expected) => expect(val(src)).toBe(expected));

  it.each([
    ["DAYS_BETWEEN('2024-02-28', '2024-03-01')", '2'],
    ["DAYS_BETWEEN('2023-02-28', '2023-03-01')", '1'],
    ["DAYS_BETWEEN('2025-12-31', '2026-01-01')", '1'],
    ["DAYS_BETWEEN('2026-01-01', '2025-01-01')", '-365'],
    ["DAYS_BETWEEN('2024-01-01', '2025-01-01')", '366'],
    ["DATE('2026-03-01') - DATE('2026-02-01')", '28'],
    ["DATE('2024-03-01') - DATE('2024-02-01')", '29'],
    ["YEAR('2024-02-29')", '2024'],
    ["MONTH('2024-02-29')", '2'],
    ["DAY('2024-02-29')", '29'],
  ])('%s = %s', (src, expected) => expect(val(src)).toBe(expected));

  it('date-typed values from context', () => {
    expect(val('d + 1', { d: '2024-12-31' })).toBe('2025-01-01');
    expect(val('e - d', { d: '2024-12-31', e: '2025-03-01' })).toBe('60');
    expect(val('d > e', { d: '2024-12-31', e: '2025-03-01' })).toBe(false);
  });

  it('empty dates', () => {
    expect(val('ADD_DAYS(NULL, 1)')).toBeNull();
    expect(val("ADD_DAYS('2026-01-01', NULL)")).toBe('2026-01-01');
    expect(val("DAYS_BETWEEN(NULL, '2026-01-01')")).toBeNull();
    expect(val("DAYS_BETWEEN('2026-01-01', NULL)")).toBeNull();
    expect(val('YEAR(NULL)')).toBeNull();
    expect(val('DATE(NULL)')).toBeNull();
    expect(val('d - x', { d: '2026-01-05' })).toBe('2026-01-05'); // untyped empty = 0 days
    expect(val('x + d', { d: '2026-01-05' })).toBe('2026-01-05');
    expect(val('x - d', { d: '2026-01-05' })).toBeNull();
  });

  it('errors', () => {
    expect(err('DATE(2023, 2, 29)')).toMatchObject({ code: 'RUNTIME', message: '2023-2-29 is not a valid date' });
    expect(err("DATE('2026-13-01')")).toMatchObject({
      code: 'RUNTIME',
      message: "Expected a date but got '2026-13-01'",
    });
    expect(err("ADD_DAYS('9999-12-31', 1)")).toMatchObject({ code: 'RUNTIME', message: 'Date is out of range' });
    expect(err("ADD_DAYS('2026-01-01', 1e10)")).toMatchObject({ code: 'RUNTIME', message: 'Date is out of range' });
    expect(err('TODAY()', {}, { today: 'not-a-date' })).toMatchObject({ code: 'RUNTIME' });
    expect(err('a + b', { a: '2026-01-01', b: '2026-01-02' })).toMatchObject({
      code: 'RUNTIME',
      message: 'Cannot add two dates',
    });
    expect(err('a - b', { a: '5', b: '2026-01-02' })).toMatchObject({
      code: 'RUNTIME',
      message: 'Cannot subtract a date from a number',
    });
    expect(err('YEAR(x)', { x: 'abc' })).toMatchObject({ code: 'RUNTIME' });
    expect(err('DATE(1e7, 1, 1)')).toMatchObject({ code: 'RUNTIME' });
  });
});

/** Pure parts of the report engine: date presets (tenant calendar, FY boundaries), cron, CSV cells. */
import { describe, expect, it } from 'vitest';
import { CronError, nextRun, parseCron } from '../src/modules/reports/cron';
import { fyStartYear, localDate, presetRange, previousRange } from '../src/modules/reports/presets';
import { csvCell } from '../src/modules/reports/writers';

describe('date presets', () => {
  it('today / this week (Monday start) / this month / last month', () => {
    expect(presetRange('none', '2026-10-22', 4)).toBeNull();
    expect(presetRange('today', '2026-10-22', 4)).toEqual({ from: '2026-10-22', to: '2026-10-22' });
    expect(presetRange('this_week', '2026-10-22', 4)).toEqual({ from: '2026-10-19', to: '2026-10-25' }); // Thu → Mon..Sun
    expect(presetRange('this_week', '2026-10-25', 4)).toEqual({ from: '2026-10-19', to: '2026-10-25' }); // Sunday
    expect(presetRange('this_month', '2026-02-10', 4)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(presetRange('this_month', '2028-02-10', 4)).toEqual({ from: '2028-02-01', to: '2028-02-29' }); // leap year
    expect(presetRange('last_month', '2026-01-15', 4)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('last_30_days', '2026-03-01', 4)).toEqual({ from: '2026-01-31', to: '2026-03-01' });
    expect(presetRange('last_90_days', '2026-03-31', 4)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
  });

  it('this_fy honours the tenant FY start, at the boundaries', () => {
    // India: April–March
    expect(presetRange('this_fy', '2026-03-31', 4)).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(presetRange('this_fy', '2026-04-01', 4)).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    // calendar-year FY
    expect(presetRange('this_fy', '2026-01-01', 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(presetRange('this_fy', '2026-12-31', 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    // July start (Australia)
    expect(presetRange('this_fy', '2026-06-30', 7)).toEqual({ from: '2025-07-01', to: '2026-06-30' });
    expect(presetRange('this_fy', '2026-07-01', 7)).toEqual({ from: '2026-07-01', to: '2027-06-30' });
    expect(fyStartYear('2026-03-31', 4)).toBe(2025);
    expect(fyStartYear('2026-04-01', 0)).toBe(2026); // invalid month falls back to April
  });

  it('previous periods for KPI deltas', () => {
    expect(previousRange('today', '2026-03-01', 4)).toEqual({ from: '2026-02-28', to: '2026-02-28' });
    expect(previousRange('this_month', '2026-03-15', 4)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(previousRange('last_month', '2026-01-15', 4)).toEqual({ from: '2025-11-01', to: '2025-11-30' });
    expect(previousRange('this_fy', '2026-05-01', 4)).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(previousRange('this_week', '2026-10-22', 4)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(previousRange('last_30_days', '2026-03-01', 4)).toEqual({ from: '2026-01-01', to: '2026-01-30' });
    expect(previousRange('none', '2026-03-01', 4)).toBeNull();
  });

  it('local dates follow the tenant timezone', () => {
    const at = new Date('2026-03-31T20:00:00Z'); // 01:30 on 1 April in India
    expect(localDate(at, 'Asia/Kolkata')).toBe('2026-04-01');
    expect(localDate(at, 'UTC')).toBe('2026-03-31');
    expect(localDate(at, 'Not/AZone')).toBe('2026-03-31');
  });
});

describe('cron', () => {
  it('parses lists, ranges, steps and names', () => {
    const s = parseCron('*/15 9-17 * JAN,jul mon-fri');
    expect([...s.minutes]).toEqual([0, 15, 30, 45]);
    expect(s.hours.has(9) && s.hours.has(17) && !s.hours.has(18)).toBe(true);
    expect([...s.months].sort((a, b) => a - b)).toEqual([1, 7]);
    expect([...s.dow].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 * * 7').dow]).toEqual([0]);
    expect(() => parseCron('0 9 * *')).toThrow(CronError);
    expect(() => parseCron('61 9 * * *')).toThrow(CronError);
    expect(() => parseCron('0 9 * * x')).toThrow(CronError);
    expect(() => parseCron('*/0 9 * * *')).toThrow(CronError);
    expect(() => parseCron('5-1 9 * * *')).toThrow(CronError);
  });

  it('next run is evaluated in the tenant timezone', () => {
    // 09:00 IST = 03:30 UTC
    expect(nextRun('0 9 * * *', new Date('2026-10-22T00:00:00Z'), 'Asia/Kolkata')!.toISOString()).toBe('2026-10-22T03:30:00.000Z');
    expect(nextRun('0 9 * * *', new Date('2026-10-22T03:30:00Z'), 'Asia/Kolkata')!.toISOString()).toBe('2026-10-23T03:30:00.000Z');
    // Mondays 08:00 in New York across the DST change (EDT → EST on 1 Nov 2026)
    expect(nextRun('0 8 * * 1', new Date('2026-10-27T00:00:00Z'), 'America/New_York')!.toISOString()).toBe('2026-11-02T13:00:00.000Z');
    expect(nextRun('30 2 * * *', new Date('2026-03-08T00:00:00Z'), 'America/New_York')!.toISOString()).toBe('2026-03-09T06:30:00.000Z'); // 02:30 skipped on DST day
    // day-of-month OR day-of-week when both are restricted
    expect(nextRun('0 0 13 * 5', new Date('2026-10-01T00:00:00Z'), 'UTC')!.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    // 31st only in long months; Feb 30 never
    expect(nextRun('0 0 31 * *', new Date('2026-04-01T00:00:00Z'), 'UTC')!.toISOString()).toBe('2026-05-31T00:00:00.000Z');
    expect(nextRun('0 0 30 2 *', new Date('2026-01-01T00:00:00Z'), 'UTC')).toBeNull();
    expect(nextRun(parseCron('15 * * * *'), new Date('2026-10-22T10:20:00Z'), 'Bad/Zone')!.toISOString()).toBe('2026-10-22T11:15:00.000Z');
  });
});

describe('csv cells', () => {
  it('quotes and guards against formula injection', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(true)).toBe('true');
  });
});

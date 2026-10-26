/**
 * Pure proleptic-Gregorian calendar arithmetic on day numbers (days since 1970-01-01). No `Date` objects, so there
 * is no timezone or DST drift anywhere. Algorithms: H. Hinnant, "chrono-compatible low-level date algorithms".
 */

export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

export const MIN_DAY = daysFromCivil(1, 1, 1);
export const MAX_DAY = daysFromCivil(9999, 12, 31);

/** Day number for a valid calendar date, else null. */
export function fromYmd(y: number, m: number, d: number): number | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse strict 'YYYY-MM-DD' into a day number; null when malformed or not a real date (e.g. 2026-02-30). */
export function parseIsoDate(s: string): number | null {
  const m = ISO.exec(s);
  if (!m) return null;
  return fromYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

export function formatIsoDate(days: number): string {
  const [y, m, d] = civilFromDays(days);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

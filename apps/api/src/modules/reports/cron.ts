/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) evaluated in a tenant timezone. Pure.
 * Supports `*`, lists, ranges, steps (`*\/15`, `1-5/2`) and JAN–DEC / SUN–SAT names; day-of-week 0 and 7 are Sunday.
 * Classic semantics: when both day-of-month and day-of-week are restricted, a day matches either.
 */
export interface CronSpec { minutes: Set<number>; hours: Set<number>; dom: Set<number>; months: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export class CronError extends Error {}

function parseField(raw: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>();
  const num = (s: string): number => {
    const lower = s.toLowerCase();
    if (names) {
      const i = names.indexOf(lower);
      if (i >= 0) return i + (min === 1 ? 1 : 0);
    }
    if (!/^\d{1,2}$/.test(s)) throw new CronError(`"${s}" is not a valid value`);
    return Number(s);
  };
  for (const part of raw.split(',')) {
    if (!part) throw new CronError('empty list item');
    const [range, stepRaw] = part.split('/') as [string, string | undefined];
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (stepRaw !== undefined && (!/^\d{1,2}$/.test(stepRaw) || step < 1)) throw new CronError(`"${part}" has an invalid step`);
    let lo: number;
    let hi: number;
    if (range === '*') { lo = min; hi = max; } else if (range.includes('-')) {
      const [a, b] = range.split('-') as [string, string];
      lo = num(a); hi = num(b);
    } else { lo = num(range); hi = stepRaw === undefined ? lo : max; }
    if (lo < min || hi > max || lo > hi) throw new CronError(`"${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError('A schedule needs 5 fields: minute hour day month weekday');
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
  const dowSet = parseField(dow, 0, 7, DAYS);
  if (dowSet.has(7)) { dowSet.delete(7); dowSet.add(0); }
  return {
    minutes: parseField(mi, 0, 59), hours: parseField(h, 0, 23), dom: parseField(dom, 1, 31), months: parseField(mo, 1, 12, MONTHS),
    dow: dowSet, domAny: dom === '*' || dom.startsWith('*/'), dowAny: dow === '*' || dow.startsWith('*/'),
  };
}

/** Wall-clock parts of an instant in a timezone. */
function wall(at: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute) };
}

/** The instant whose wall clock in tz is the given naive UTC-encoded time (null when it does not exist, e.g. DST gap). */
function instantOf(naive: number, tz: string): number | null {
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const w = wall(guess, tz);
    const asNaive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
    const diff = naive - asNaive;
    if (diff === 0) return guess;
    guess += diff;
  }
  return null;
}

function dayMatches(s: CronSpec, y: number, mo: number, d: number): boolean {
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const domOk = s.dom.has(d);
  const dowOk = s.dow.has(dow);
  if (s.domAny && s.dowAny) return true;
  if (s.domAny) return dowOk;
  if (s.dowAny) return domOk;
  return domOk || dowOk;
}

/** First run strictly after `after` (minute resolution) in timezone `tz`; null when none within ~5 years. */
export function nextRun(spec: CronSpec | string, after: Date, tz: string): Date | null {
  const s = typeof spec === 'string' ? parseCron(spec) : spec;
  let zone = tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { zone = 'UTC'; }
  const w = wall(after.getTime(), zone);
  // naive wall time cursor (UTC-encoded), starting at the next whole minute
  let t = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) + 60_000;
  const limit = t + 5 * 366 * 86_400_000;
  while (t < limit) {
    const d = new Date(t);
    const y = d.getUTCFullYear(); const mo = d.getUTCMonth() + 1; const day = d.getUTCDate(); const h = d.getUTCHours(); const mi = d.getUTCMinutes();
    if (!s.months.has(mo)) { t = Date.UTC(y, mo, 1); continue; }
    if (!dayMatches(s, y, mo, day)) { t = Date.UTC(y, mo - 1, day + 1); continue; }
    if (!s.hours.has(h)) { t = Date.UTC(y, mo - 1, day, h + 1); continue; }
    if (!s.minutes.has(mi)) { t += 60_000; continue; }
    const at = instantOf(t, zone);
    if (at !== null && at > after.getTime()) return new Date(at);
    t += 60_000;
  }
  return null;
}

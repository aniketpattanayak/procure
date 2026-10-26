import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import type { ValueField } from './definition';
import { isEmpty, NUMERIC_TYPES } from './definition';

/**
 * Per-type value validators for the record save pipeline (pure, synchronous). Existence checks for lookups and
 * files, formulas and unique checks run later in the pipeline. Every validator returns the normalised value to store
 * (`undefined` = empty) plus errors keyed by path (`field`, `lines.3.qty`).
 */
export interface ValueIssue {
  path: string;
  message: string;
}

export interface ValidateOptions {
  /** Stored value before this save: lets old records keep options that were since made inactive. */
  previous?: unknown;
  /** Evaluates a date-bound expression (minDate/maxDate) to 'YYYY-MM-DD' or null. */
  evalDate?: (expr: string) => string | null;
}

export interface ValidateResult {
  value: unknown;
  errors: ValueIssue[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuidString = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// ------------------------------------------------------------------------------------------- primitives

/** Canonical decimal string ("0012.50" -> "12.5"), or null if not a plain decimal. Never uses floats for storage. */
export function canonicalDecimal(v: unknown): string | null {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else if (typeof v === 'string') {
    s = v.trim();
  } else return null;
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(s) ?? /^([+-])?()\.(\d+)$/.exec(s);
  if (!m) return null;
  const int = (m[2] ?? '').replace(/^0+(?=\d)/, '') || '0';
  const frac = (m[3] ?? '').replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return m[1] === '-' && out !== '0' ? `-${out}` : out;
}

/**
 * Stored decimal places of a numeric field (contract decision, QA phase 2): number = 0, decimal/currency/percentage =
 * `precision` (default 2). Values are stored and returned normalised to it, like formula outputs ("100" -> "100.00").
 */
export const numericPlaces = (field: { type: string; precision?: number }) => (field.type === 'number' ? 0 : field.precision ?? 2);

/** Pads a canonical decimal (at most `places` decimals) to exactly `places` decimals. */
export function toPlaces(canon: string, places: number): string {
  if (places === 0) return canon;
  const [int, frac = ''] = canon.split('.');
  return `${int}.${frac.padEnd(places, '0')}`;
}

export const decimalPlaces = (canon: string) => (canon.includes('.') ? canon.split('.')[1]!.length : 0);

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export const isValidTime = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function isValidDateTime(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d)(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.exec(s);
  return !!m && isValidDate(m[1]) && !Number.isNaN(Date.parse(s));
}

/**
 * SEC8-003: `regex` field patterns are written by tenant form designers and run on the shared API process. A
 * catastrophic-backtracking pattern such as (a+)+b would block the event loop for every tenant, so the test runs
 * in a vm context with a hard time limit. Returns null when the limit is hit.
 */
export const REGEX_TIME_LIMIT_MS = 50;
const regexSandbox = vm.createContext({ re: /x/, s: '' });
const regexRunner = new vm.Script('re.test(s)');
export function boundedTest(re: RegExp, s: string, timeoutMs = REGEX_TIME_LIMIT_MS): boolean | null {
  const box = regexSandbox as { re: RegExp; s: string };
  box.re = re; box.s = s;
  try {
    return regexRunner.runInContext(regexSandbox, { timeout: timeoutMs }) === true;
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null;
    throw e;
  } finally {
    box.re = /x/; box.s = '';
  }
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isValidEmail = (s: string) => s.length <= 254 && EMAIL_RE.test(s) && !s.includes('..');

/** http/https only (no javascript:, data:, ftp: ...). */
export function isValidUrl(s: string): boolean {
  if (s.length > 2000) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** GSTIN: 2-digit state + PAN + entity number + 'Z' + mod-36 check character. */
export function isValidGstin(s: string): boolean {
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) return false;
  const state = Number(s.slice(0, 2));
  if (state < 1 || state > 99) return false;
  if (!isValidPan(s.slice(2, 12))) return false;
  return gstinCheckChar(s.slice(0, 14)) === s[14];
}

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]!);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36]!;
}

/** PAN: AAAAA9999A; 4th letter is the holder type (P, C, H, F, A, T, B, L, J, G). */
export const isValidPan = (s: string) => /^[A-Z]{3}[PCHFATBLJG][A-Z][0-9]{4}[A-Z]$/.test(s);

const CALLING_CODES: Record<string, string> = {
  IN: '91', US: '1', CA: '1', GB: '44', AE: '971', SG: '65', AU: '61', DE: '49', FR: '33', SA: '966', NP: '977', BD: '880',
  LK: '94', MY: '60', JP: '81', CN: '86', ZA: '27', KE: '254', NG: '234', QA: '974', OM: '968', KW: '965', BH: '973',
};

/** E.164-ish: '+<country><number>' with 8–15 digits; national numbers get the field's default country code. */
export function normalizePhone(raw: string, defaultCountry = 'IN'): string | null {
  const s = raw.trim().replace(/[\s().-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  if (/^00[1-9]\d{7,14}$/.test(s)) return `+${s.slice(2)}`;
  const cc = CALLING_CODES[defaultCountry.toUpperCase()];
  const national = s.replace(/^0+/, '');
  if (cc && /^[1-9]\d{5,13}$/.test(national) && (cc + national).length >= 8 && (cc + national).length <= 15) return `+${cc}${national}`;
  return null;
}

// ------------------------------------------------------------------------------------------- validator

type F = ValueField & Record<string, unknown>;

export function validateValue(field: ValueField, raw: unknown, path: string, opts: ValidateOptions = {}): ValidateResult {
  const f = field as F;
  const errors: ValueIssue[] = [];
  const fail = (message: string, p = path): ValidateResult => {
    errors.push({ path: p, message });
    return { value: undefined, errors };
  };
  if (field.type === 'formula') return { value: undefined, errors }; // computed by the server
  if (isEmpty(raw) && field.type !== 'grid') return { value: undefined, errors };
  const label = field.label;

  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'regex': {
      if (typeof raw !== 'string') return fail(`${label} must be text.`);
      const v = field.type === 'textarea' ? raw : raw.trim();
      if (!v) return { value: undefined, errors };
      const max = (f.maxLength as number | undefined) ?? (field.type === 'textarea' ? 10000 : 1000);
      if (f.minLength !== undefined && v.length < (f.minLength as number)) return fail(`${label} must be at least ${f.minLength} characters.`);
      if (v.length > max) return fail(`${label} must be at most ${max} characters.`);
      if (field.type === 'regex') {
        let re: RegExp;
        try {
          re = new RegExp(`^(?:${field.pattern})$`);
        } catch {
          return fail(`${label} has an invalid pattern; ask your administrator to fix the form.`);
        }
        const ok = boundedTest(re, v);
        if (ok === null) return fail(`${label} could not be checked: the field's pattern is too complex. Ask your administrator to simplify it.`);
        if (!ok) return fail(field.patternMessage || 'Invalid format');
      }
      return { value: v, errors };
    }
    case 'number':
    case 'decimal':
    case 'currency':
    case 'percentage': {
      const canon = canonicalDecimal(raw);
      if (canon === null) return fail(`${label} must be a number.`);
      const places = numericPlaces(field);
      if (decimalPlaces(canon) > places) {
        return fail(places === 0 ? `${label} must be a whole number.` : `${label} allows at most ${places} decimal places.`);
      }
      const n = Number(canon);
      if (f.min !== undefined && n < (f.min as number)) return fail(`${label} must be at least ${f.min}.`);
      if (f.max !== undefined && n > (f.max as number)) return fail(`${label} must be at most ${f.max}.`);
      return { value: toPlaces(canon, places), errors };
    }
    case 'date': {
      if (!isValidDate(raw)) return fail(`${label} must be a date (YYYY-MM-DD).`);
      for (const [k, cmp, word] of [['minDate', -1, 'on or after'], ['maxDate', 1, 'on or before']] as const) {
        const expr = f[k] as string | undefined;
        if (!expr || !opts.evalDate) continue;
        const bound = opts.evalDate(expr);
        if (bound && isValidDate(bound) && Math.sign(raw.localeCompare(bound)) === cmp) return fail(`${label} must be ${word} ${bound}.`);
      }
      return { value: raw, errors };
    }
    case 'time':
      return isValidTime(raw) ? { value: raw, errors } : fail(`${label} must be a time (HH:mm).`);
    case 'datetime':
      return isValidDateTime(raw) ? { value: raw, errors } : fail(`${label} must be a date and time with a time zone (ISO 8601).`);
    case 'daterange': {
      const r = raw as { from?: unknown; to?: unknown };
      if (typeof raw !== 'object' || Array.isArray(raw) || !isValidDate(r.from) || !isValidDate(r.to)) {
        return fail(`${label} needs a start and end date (YYYY-MM-DD).`);
      }
      if ((r.from as string) > (r.to as string)) return fail(`${label}: the start date is after the end date.`);
      return { value: { from: r.from, to: r.to }, errors };
    }
    case 'select':
    case 'radio': {
      if (typeof raw !== 'string') return fail(`${label} must be one of the listed options.`);
      const opt = field.options.find(o => o.value === raw);
      if (!opt || (opt.inactive && opts.previous !== raw)) return fail(`"${raw}" is not an option for ${label}.`);
      return { value: raw, errors };
    }
    case 'multiselect': {
      if (!Array.isArray(raw) || raw.some(x => typeof x !== 'string')) return fail(`${label} must be a list of options.`);
      const prev = new Set(Array.isArray(opts.previous) ? (opts.previous as string[]) : []);
      const vals = [...new Set(raw as string[])];
      for (const v of vals) {
        const opt = field.options.find(o => o.value === v);
        if (!opt || (opt.inactive && !prev.has(v))) return fail(`"${v}" is not an option for ${label}.`);
      }
      if (field.maxSelected && vals.length > field.maxSelected) return fail(`Choose at most ${field.maxSelected} for ${label}.`);
      return { value: vals, errors };
    }
    case 'checkbox':
    case 'toggle':
      return typeof raw === 'boolean' ? { value: raw, errors } : fail(`${label} must be true or false.`);
    case 'lookup':
    case 'file':
    case 'image':
    case 'signature':
      return isUuidString(raw) ? { value: raw.toLowerCase(), errors } : fail(`${label} has an invalid reference.`);
    case 'multilookup':
    case 'files': {
      if (!Array.isArray(raw) || raw.some(x => !isUuidString(x))) return fail(`${label} has an invalid reference.`);
      const vals = [...new Set((raw as string[]).map(x => x.toLowerCase()))];
      const max = field.type === 'files' ? field.maxFiles : field.maxSelected;
      if (max && vals.length > max) return fail(`${label} allows at most ${max}.`);
      return { value: vals, errors };
    }
    case 'email': {
      if (typeof raw !== 'string') return fail(`${label} must be an email address.`);
      const v = raw.trim();
      return isValidEmail(v) ? { value: v, errors } : fail(`${label} must be a valid email address.`);
    }
    case 'phone': {
      if (typeof raw !== 'string') return fail(`${label} must be a phone number.`);
      const v = normalizePhone(raw, field.defaultCountry);
      return v ? { value: v, errors } : fail(`${label} must be a valid phone number, e.g. +91 98765 43210.`);
    }
    case 'url': {
      if (typeof raw !== 'string') return fail(`${label} must be a web address.`);
      const v = raw.trim();
      return isValidUrl(v) ? { value: v, errors } : fail(`${label} must be a web address starting with http:// or https://.`);
    }
    case 'gstin': {
      if (typeof raw !== 'string') return fail(`${label} must be a GSTIN.`);
      const v = raw.trim().toUpperCase();
      return isValidGstin(v) ? { value: v, errors } : fail(`${label} is not a valid GSTIN (15 characters; check digit must match).`);
    }
    case 'pan': {
      if (typeof raw !== 'string') return fail(`${label} must be a PAN.`);
      const v = raw.trim().toUpperCase();
      return isValidPan(v) ? { value: v, errors } : fail(`${label} is not a valid PAN (format AAAPA9999A).`);
    }
    case 'grid':
      return validateGrid(field, raw, path, opts);
    default:
      return fail(`${label} has an unsupported type.`);
  }
}

function validateGrid(field: Extract<ValueField, { type: 'grid' }>, raw: unknown, path: string, opts: ValidateOptions): ValidateResult {
  const errors: ValueIssue[] = [];
  const rows = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(rows) || rows.some(r => typeof r !== 'object' || r === null || Array.isArray(r))) {
    return { value: undefined, errors: [{ path, message: `${field.label} must be a list of rows.` }] };
  }
  if (rows.length < field.minRows) errors.push({ path, message: `${field.label} needs at least ${field.minRows} row(s).` });
  if (rows.length > field.maxRows) errors.push({ path, message: `${field.label} allows at most ${field.maxRows} rows.` });
  const prevRows = new Map<string, Record<string, unknown>>();
  if (Array.isArray(opts.previous)) for (const r of opts.previous as Record<string, unknown>[]) if (typeof r?._row === 'string') prevRows.set(r._row, r);
  const seen = new Set<string>();
  const out = (rows as Record<string, unknown>[]).map((row, i) => {
    let id = isUuidString(row._row) ? row._row.toLowerCase() : randomUUID();
    if (seen.has(id)) id = randomUUID();
    seen.add(id);
    const prev = prevRows.get(id);
    const cleaned: Record<string, unknown> = { _row: id };
    for (const col of field.columns) {
      if (col.removed) {
        if (prev && prev[col.key] !== undefined) cleaned[col.key] = prev[col.key];
        continue;
      }
      const r = validateValue(col, row[col.key], `${path}.${i}.${col.key}`, { ...opts, previous: prev?.[col.key] });
      errors.push(...r.errors);
      if (r.value !== undefined) cleaned[col.key] = r.value;
    }
    return cleaned;
  });
  return { value: out.length ? out : undefined, errors };
}

/** Default for a new record when the field is absent (dates: 'today' resolves to the tenant's date). */
export function defaultValue(field: ValueField, today: string): unknown {
  const d = (field as { default?: unknown }).default;
  if (d === undefined) return undefined;
  if (field.type === 'date' && d === 'today') return today;
  if (NUMERIC_TYPES.has(field.type) && (typeof d === 'number' || typeof d === 'string')) {
    const canon = canonicalDecimal(d);
    return canon === null ? undefined : toPlaces(canon, numericPlaces(field as { type: string; precision?: number }));
  }
  return d;
}

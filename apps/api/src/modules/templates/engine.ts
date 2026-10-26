import { ErrorCode } from '@procure/schema';
import Handlebars from 'handlebars';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { AppError } from '../../core/errors';
import { amountInWords, formatDate, formatMoney, formatNumber, qrSvg } from './format';

/**
 * Sandboxed Handlebars (contract "Rendering safety"): an isolated environment with only the fixed helper set
 * (unknown helpers are compile errors), HTML escaping on, prototype access off, template ≤ 200 KB, render ≤ 2 s
 * (enforced with a vm watchdog that interrupts the synchronous render) and output ≤ 5 MB. Never performs I/O.
 */
export const MAX_TEMPLATE_BYTES = 200_000;
export const RENDER_TIMEOUT_MS = 2000;
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export const HELPERS = ['formatDate', 'formatMoney', 'formatNumber', 'upper', 'lower', 'eq', 'ifEq', 'qrCode', 'amountInWords'] as const;

type Opts = Handlebars.HelperOptions & { data?: { root?: Record<string, unknown> } };
const isOpts = (x: unknown): x is Opts => !!x && typeof x === 'object' && 'hash' in (x as object) && 'data' in (x as object);
/** Positional helper arguments without the trailing options object. */
const argsOf = (raw: IArguments | unknown[]): { args: unknown[]; opts: Opts | undefined } => {
  const list = Array.from(raw as unknown[]);
  const last = list[list.length - 1];
  return isOpts(last) ? { args: list.slice(0, -1), opts: last } : { args: list, opts: undefined };
};
const rootOf = (o: Opts | undefined): Record<string, unknown> => (o?.data?.root ?? {}) as Record<string, unknown>;
const tenantOf = (o: Opts | undefined) => (rootOf(o).tenant ?? {}) as { currency?: string; timezone?: string };
const str = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v));

function buildEnv(): typeof Handlebars {
  const hb = Handlebars.create();
  // Built-in `log` writes to the server console; templates don't need it.
  hb.unregisterHelper('log');
  hb.registerHelper('formatDate', function (this: unknown, ...raw: unknown[]) {
    const { args, opts } = argsOf(raw);
    const fmt = typeof args[1] === 'string' ? args[1] : undefined;
    return formatDate(args[0], fmt, tenantOf(opts).timezone ?? 'Asia/Kolkata');
  });
  hb.registerHelper('formatMoney', function (this: unknown, ...raw: unknown[]) {
    const { args, opts } = argsOf(raw);
    const cur = typeof args[1] === 'string' && args[1] ? args[1] : tenantOf(opts).currency ?? 'INR';
    return formatMoney(args[0], cur);
  });
  hb.registerHelper('formatNumber', function (this: unknown, ...raw: unknown[]) {
    const { args, opts } = argsOf(raw);
    const places = args[1] === undefined || args[1] === null ? 2 : Number(args[1]);
    return formatNumber(args[0], places, (tenantOf(opts).currency ?? 'INR') === 'INR');
  });
  hb.registerHelper('upper', (...raw: unknown[]) => str(argsOf(raw).args[0]).toUpperCase());
  hb.registerHelper('lower', (...raw: unknown[]) => str(argsOf(raw).args[0]).toLowerCase());
  hb.registerHelper('eq', (...raw: unknown[]) => {
    const { args } = argsOf(raw);
    return looseEq(args[0], args[1]);
  });
  hb.registerHelper('ifEq', function (this: unknown, a: unknown, b: unknown, options: Handlebars.HelperOptions) {
    if (!isOpts(options) || typeof options.fn !== 'function') return '';
    return looseEq(a, b) ? options.fn(this) : options.inverse(this);
  });
  hb.registerHelper('qrCode', (...raw: unknown[]) => {
    const { args, opts } = argsOf(raw);
    const size = Number((opts?.hash as Record<string, unknown> | undefined)?.size ?? args[1] ?? 96);
    return new hb.SafeString(qrSvg(args[0], size));
  });
  hb.registerHelper('amountInWords', function (this: unknown, ...raw: unknown[]) {
    const { args, opts } = argsOf(raw);
    const cur = typeof args[1] === 'string' && args[1] ? args[1] : tenantOf(opts).currency ?? 'INR';
    return amountInWords(args[0], cur);
  });
  return hb;
}

/** Numbers and numeric strings compare by value ('10.00' eq 10); everything else strictly. */
function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const num = (x: unknown) => (typeof x === 'number' || (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x)) ? Number(x) : NaN);
  const na = num(a);
  const nb = num(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return a !== null && b !== null && a !== undefined && b !== undefined && typeof a !== 'object' && String(a) === String(b);
}

const KNOWN_HELPERS: Record<string, boolean> = {
  ...Object.fromEntries(HELPERS.map(h => [h, true])),
  // built-ins that stay available
  if: true, unless: true, each: true, with: true, lookup: true, log: false, helperMissing: false, blockHelperMissing: false,
};

const RUNTIME_OPTIONS: Handlebars.RuntimeOptions = {
  allowProtoPropertiesByDefault: false,
  allowProtoMethodsByDefault: false,
  allowCallsToHelperMissing: false,
};

export class TemplateRenderError extends AppError {
  constructor(code: 'TEMPLATE_TOO_LARGE' | 'TEMPLATE_SYNTAX' | 'TEMPLATE_TIMEOUT' | 'TEMPLATE_OUTPUT_TOO_LARGE' | 'TEMPLATE_RENDER', message: string, path = 'body') {
    super(400, `${ErrorCode.VALIDATION}.${code}`, message, { reason: code }, [{ path, message }]);
  }
}

/** One isolated Handlebars environment + compile cache + time-boxed execution. */
export class TemplateEngine {
  private readonly hb = buildEnv();
  private readonly cache = new Map<string, Handlebars.TemplateDelegate>();
  private readonly sandbox = vm.createContext({ __run: (): unknown => undefined });
  private readonly runner = new vm.Script('__run()');

  /** Compiles (cached by content hash). Throws TemplateRenderError for size or syntax problems. */
  compile(source: string, path = 'body'): Handlebars.TemplateDelegate {
    if (typeof source !== 'string') throw new TemplateRenderError('TEMPLATE_SYNTAX', 'The template is empty.', path);
    if (Buffer.byteLength(source, 'utf8') > MAX_TEMPLATE_BYTES) {
      throw new TemplateRenderError('TEMPLATE_TOO_LARGE', `Templates can be at most ${MAX_TEMPLATE_BYTES / 1000} KB.`, path);
    }
    const key = createHash('sha1').update(source).digest('hex');
    const hit = this.cache.get(key);
    if (hit) return hit;
    let fn: Handlebars.TemplateDelegate;
    try {
      fn = this.hb.compile(source, { strict: false, noEscape: false, knownHelpers: KNOWN_HELPERS, knownHelpersOnly: true });
      // Handlebars compiles lazily: force it now so syntax errors surface at save time.
      fn({}, { ...RUNTIME_OPTIONS });
    } catch (e) {
      throw new TemplateRenderError('TEMPLATE_SYNTAX', `The template has an error: ${cleanMessage(e)}`, path);
    }
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, fn);
    return fn;
  }

  /** Throws TemplateRenderError when the source does not compile (used on save). */
  check(source: string, path = 'body') {
    this.compile(source, path);
  }

  /** Renders with the context; ≤ RENDER_TIMEOUT_MS of CPU and ≤ MAX_OUTPUT_BYTES of output. */
  render(source: string, context: Record<string, unknown>, path = 'body', timeoutMs = RENDER_TIMEOUT_MS): string {
    const fn = this.compile(source, path);
    const data = safeContext(context);
    let out: unknown;
    (this.sandbox as { __run: () => unknown }).__run = () => fn(data, { ...RUNTIME_OPTIONS });
    try {
      out = this.runner.runInContext(this.sandbox, { timeout: timeoutMs });
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new TemplateRenderError('TEMPLATE_TIMEOUT', `Rendering took longer than ${timeoutMs / 1000} s. Simplify the template.`, path);
      }
      throw new TemplateRenderError('TEMPLATE_RENDER', `The template could not be rendered: ${cleanMessage(e)}`, path);
    } finally {
      (this.sandbox as { __run: () => unknown }).__run = () => undefined;
    }
    const s = String(out ?? '');
    if (s.length > MAX_OUTPUT_BYTES) throw new TemplateRenderError('TEMPLATE_OUTPUT_TOO_LARGE', 'The rendered output is larger than 5 MB.', path);
    return s;
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

/**
 * Plain-data copy of a render context: drops prototype-related keys (e.g. an own "__proto__" key from parsed JSON),
 * turns Dates into ISO strings and caps depth. Templates therefore only ever see JSON-like data.
 */
export function safeContext(v: unknown, depth = 0): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (depth > 25) return undefined;
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Handlebars.SafeString) return v;
  if (Array.isArray(v)) return v.map(x => safeContext(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = safeContext((v as Record<string, unknown>)[k], depth + 1);
  }
  return out;
}

function cleanMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n').filter(Boolean).slice(0, 4).join(' ').slice(0, 400);
}

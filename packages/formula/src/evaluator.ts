import type { FormulaType } from '@procure/schema';
import { civilFromDays, formatIsoDate, fromYmd, MAX_DAY, MIN_DAY, parseIsoDate } from './dates';
import type { BinaryNode, Binding, CallNode, Node, RefNode } from './parser';
import { ConversionError, DateV, fixed, roundTo, textOrNull, toDecimal, toRuntime, toText, type RV } from './values';
import { D, fail, isDec, own, type Dec } from './util';

type Rec = Record<string, unknown>;

/** Everything a checked AST needs at runtime. Rows/lookups are mutable so one Env serves a whole grid. */
export class Env {
  /** Row being iterated by an aggregate (grid.column refs read it). */
  aggRow: Rec | null = null;

  constructor(
    public values: Rec,
    public lookups: Record<string, Rec | null> | undefined,
    public today: string,
    public row: Rec | undefined = undefined,
    public rowLookups: Record<string, Rec | null> | undefined = undefined,
    /** Declared column types for grid rows: grid -> column -> type. */
    public gridTypes: Record<string, Record<string, FormulaType>> = {},
  ) {}

  rows(grid: string): Rec[] {
    const raw = own(this.values, grid);
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is Rec => r !== null && typeof r === 'object' && !Array.isArray(r));
  }
}

function rawOf(b: Binding, env: Env): unknown {
  switch (b.kind) {
    case 'field':
      return own(env.values, b.key);
    case 'row':
      return own(env.row, b.key);
    case 'lattr':
      return own(own(env.lookups, b.key), b.attr!);
    case 'rlattr':
      return own(own(env.rowLookups, b.key), b.attr!);
    case 'gcol':
      return own(env.aggRow, b.attr!);
    default: // 'grid' is handled by COUNT; 'free' is an unknown name in lenient mode
      return null;
  }
}

function readRef(node: RefNode, env: Env): RV {
  const b = node.binding!;
  try {
    return toRuntime(rawOf(b, env), b.type);
  } catch (e) {
    /* v8 ignore next */
    if (!(e instanceof ConversionError)) throw e;
    const shown = node.attr === undefined ? node.name : `${node.name}.${node.attr}`;
    return fail('RUNTIME', `'${shown}' does not hold ${e.expected}`, node.start, node.end);
  }
}

// ---------------------------------------------------------------------------------------------
// Coercions
// ---------------------------------------------------------------------------------------------

const describe = (v: RV): string =>
  v instanceof DateV
    ? `the date ${formatIsoDate(v.days)}`
    : typeof v === 'boolean'
      ? v
        ? 'TRUE'
        : 'FALSE'
      : Array.isArray(v)
        ? 'a list'
        : `'${String(v)}'`;

function toNum(v: RV, node: Node): Dec {
  if (v === null) return new D(0);
  if (isDec(v)) return v;
  const d = typeof v === 'string' ? toDecimal(v) : undefined;
  if (d !== undefined) return d;
  return fail('RUNTIME', `Expected a number but got ${describe(v)}`, node.start, node.end);
}

function toDate(v: RV, node: Node): DateV | null {
  if (v === null || v instanceof DateV) return v;
  if (typeof v === 'string') {
    const days = parseIsoDate(v);
    if (days !== null) return new DateV(days);
  }
  return fail('RUNTIME', `Expected a date but got ${describe(v)}`, node.start, node.end);
}

function truthy(v: RV, node: Node): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  return fail('RUNTIME', `Expected TRUE/FALSE but got ${describe(v)}`, node.start, node.end);
}

function finite(d: Dec, node: Node): Dec {
  if (!d.isFinite()) fail('RUNTIME', 'Number is too large', node.start, node.end);
  return d;
}

function intArg(v: RV, node: Node, lo: number, hi: number, what: string): number {
  const n = toNum(v, node).trunc();
  if (n.lt(lo) || n.gt(hi)) fail('RUNTIME', `${what} must be between ${lo} and ${hi}`, node.start, node.end);
  return n.toNumber();
}

function addDays(d: DateV, n: Dec, node: Node): DateV {
  const days = n.trunc();
  if (days.abs().gt(MAX_DAY - MIN_DAY)) fail('RUNTIME', 'Date is out of range', node.start, node.end);
  const r = d.days + days.toNumber();
  if (r < MIN_DAY || r > MAX_DAY) fail('RUNTIME', 'Date is out of range', node.start, node.end);
  return new DateV(r);
}

// ---------------------------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------------------------

function addSub(node: BinaryNode, a: RV, b: RV): RV {
  const plus = node.op === '+';
  // An empty operand that is statically a date makes date arithmetic empty.
  if ((a === null && node.leftType === 'date') || (b === null && node.rightType === 'date')) return null;
  const ad = a instanceof DateV;
  const bd = b instanceof DateV;
  if (ad || bd) {
    if (ad && bd) {
      if (plus) fail('RUNTIME', 'Cannot add two dates', node.start, node.end);
      return new D(a.days - b.days);
    }
    if (ad) return addDays(a, plus ? toNum(b, node.right) : toNum(b, node.right).neg(), node);
    if (a === null) return plus ? b : null;
    if (!plus) fail('RUNTIME', 'Cannot subtract a date from a number', node.start, node.end);
    return addDays(b as DateV, toNum(a, node.left), node);
  }
  const x = toNum(a, node.left);
  const y = toNum(b, node.right);
  return finite(plus ? x.plus(y) : x.minus(y), node);
}

/** -1 / 0 / 1, or undefined when the values cannot be ordered. */
function order(a: Exclude<RV, null>, b: Exclude<RV, null>): number | undefined {
  if (isDec(a) && isDec(b)) return a.cmp(b);
  if (a instanceof DateV && b instanceof DateV) return Math.sign(a.days - b.days);
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return typeof a === 'boolean' && typeof b === 'boolean' ? (a === b ? 0 : undefined) : undefined;
  }
  if (Array.isArray(a) || Array.isArray(b)) return undefined;
  // Mixed number/text: numeric compare when the text is a number, else compare as text. Date/text: ISO text.
  if (isDec(a) && typeof b === 'string') {
    const d = toDecimal(b);
    if (d !== undefined) return a.cmp(d);
  }
  if (typeof a === 'string' && isDec(b)) {
    const d = toDecimal(a);
    if (d !== undefined) return d.cmp(b);
  }
  const x = toText(a);
  const y = toText(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

function compare(node: BinaryNode, a: RV, b: RV): boolean {
  const op = node.op;
  if (a === null || b === null) {
    // null = null is TRUE; exactly one null is "not equal"; ordering with null is FALSE.
    const both = a === null && b === null;
    return op === '=' ? both : op === '!=' ? !both : false;
  }
  const c = typeof a === 'boolean' && op !== '=' && op !== '!=' ? undefined : order(a, b);
  if (c === undefined) {
    if (op === '=' || op === '!=') return op === '!=';
    return fail('RUNTIME', `Cannot order ${describe(a)} and ${describe(b)}`, node.start, node.end);
  }
  switch (op) {
    case '=':
      return c === 0;
    case '!=':
      return c !== 0;
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    default:
      return c >= 0;
  }
}

function binary(node: BinaryNode, env: Env): RV {
  const op = node.op;
  if (op === 'AND') return truthy(ev(node.left, env), node.left) && truthy(ev(node.right, env), node.right);
  if (op === 'OR') return truthy(ev(node.left, env), node.left) || truthy(ev(node.right, env), node.right);
  const a = ev(node.left, env);
  const b = ev(node.right, env);
  switch (op) {
    case '&':
      return textOrNull(toText(a) + toText(b));
    case '+':
    case '-':
      return addSub(node, a, b);
    case '*':
      return finite(toNum(a, node.left).times(toNum(b, node.right)), node);
    case '/':
    case '%': {
      const y = toNum(b, node.right);
      if (y.isZero()) fail('RUNTIME', 'Division by zero', node.start, node.end);
      const x = toNum(a, node.left);
      return finite(op === '/' ? x.div(y) : x.mod(y), node);
    }
    default:
      return compare(node, a, b);
  }
}

// ---------------------------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------------------------

/** Values of one aggregate argument: per row of its grid, or the single scalar value. */
function argValues(node: CallNode, i: number, env: Env): RV[] {
  const arg = node.args[i]!;
  const grid = node.argGrids?.[i] ?? null;
  if (grid === null) return [ev(arg, env)];
  return eachRow(env, grid, () => ev(arg, env));
}

function eachRow<T>(env: Env, grid: string, fn: () => T): T[] {
  const prev = env.aggRow;
  const out: T[] = [];
  try {
    for (const row of env.rows(grid)) {
      env.aggRow = row;
      out.push(fn());
    }
  } finally {
    env.aggRow = prev;
  }
  return out;
}

function nonNull(node: CallNode, env: Env): { v: Exclude<RV, null>; at: Node }[] {
  const out: { v: Exclude<RV, null>; at: Node }[] = [];
  node.args.forEach((arg, i) => {
    for (const v of argValues(node, i, env)) if (v !== null) out.push({ v, at: arg });
  });
  return out;
}

function minMax(node: CallNode, env: Env): RV {
  const vals = nonNull(node, env);
  let best: Dec | DateV | null = null;
  for (const { v, at } of vals) {
    const x: Dec | DateV = v instanceof DateV ? v : toNum(v, at);
    if (best === null) {
      best = x;
      continue;
    }
    if (best instanceof DateV !== x instanceof DateV)
      fail('RUNTIME', `${node.name} cannot mix dates and numbers`, at.start, at.end);
    const c = order(x, best)!;
    if (node.name === 'MIN' ? c < 0 : c > 0) best = x;
  }
  return best;
}

function count(node: CallNode, env: Env): RV {
  let n = 0;
  node.args.forEach((arg, i) => {
    if (arg.type === 'ref' && arg.binding?.kind === 'grid') {
      n += env.rows(arg.binding.key).length;
      return;
    }
    for (const v of argValues(node, i, env)) {
      if (Array.isArray(v)) n += v.length;
      else if (v !== null) n++;
    }
  });
  return new D(n);
}

function call(node: CallNode, env: Env): RV {
  const a = node.args;
  const arg = (i: number): RV => ev(a[i]!, env);
  switch (node.name) {
    case 'IF':
      return truthy(arg(0), a[0]!) ? arg(1) : a.length > 2 ? arg(2) : null;
    case 'IFS': {
      for (let i = 0; i + 1 < a.length; i += 2) if (truthy(arg(i), a[i]!)) return arg(i + 1);
      return a.length % 2 === 1 ? arg(a.length - 1) : null;
    }
    case 'AND':
      return a.every(x => truthy(ev(x, env), x));
    case 'OR':
      return a.some(x => truthy(ev(x, env), x));
    case 'NOT':
      return !truthy(arg(0), a[0]!);
    case 'COALESCE':
      for (const x of a) {
        const v = ev(x, env);
        if (v !== null) return v;
      }
      return null;
    case 'ISBLANK': {
      const v = arg(0);
      return v === null || v === '' || (Array.isArray(v) && v.length === 0);
    }
    case 'ROUND':
    case 'FLOOR':
    case 'CEIL': {
      const x = toNum(arg(0), a[0]!);
      const places = a.length > 1 ? intArg(arg(1), a[1]!, -20, 20, 'Decimal places') : 0;
      const mode = node.name === 'ROUND' ? D.ROUND_HALF_UP : node.name === 'FLOOR' ? D.ROUND_FLOOR : D.ROUND_CEIL;
      return roundTo(x, places, mode);
    }
    case 'ABS':
      return toNum(arg(0), a[0]!).abs();
    case 'MIN':
    case 'MAX':
      return minMax(node, env);
    case 'SUM': {
      let s = new D(0);
      for (const { v, at } of nonNull(node, env)) s = s.plus(toNum(v, at));
      return finite(s, node);
    }
    case 'AVG': {
      const vals = nonNull(node, env);
      if (vals.length === 0) return null;
      let s = new D(0);
      for (const { v, at } of vals) s = s.plus(toNum(v, at));
      return finite(s, node).div(vals.length);
    }
    case 'COUNT':
      return count(node, env);
    case 'SUMIF': {
      let s = new D(0);
      eachRow(env, node.grid!, () => {
        if (truthy(arg(1), a[1]!)) s = s.plus(toNum(arg(0), a[0]!));
      });
      return finite(s, node);
    }
    case 'COUNTIF':
      return new D(eachRow(env, node.grid!, () => truthy(arg(0), a[0]!)).filter(Boolean).length);
    case 'TODAY': {
      const days = parseIsoDate(env.today);
      if (days === null)
        fail(
          'RUNTIME',
          `TODAY() needs the context date as 'YYYY-MM-DD' (got '${String(env.today)}')`,
          node.start,
          node.end,
        );
      return new DateV(days);
    }
    case 'DATE': {
      if (a.length === 1) return toDate(arg(0), a[0]!);
      const [y, m, d] = [0, 1, 2].map(i => intArg(arg(i), a[i]!, -1e6, 1e6, 'Date parts'));
      const days = fromYmd(y!, m!, d!);
      if (days === null) fail('RUNTIME', `${y}-${m}-${d} is not a valid date`, node.start, node.end);
      return new DateV(days);
    }
    case 'DAYS_BETWEEN': {
      const s = toDate(arg(0), a[0]!);
      const e = toDate(arg(1), a[1]!);
      return s === null || e === null ? null : new D(e.days - s.days);
    }
    case 'ADD_DAYS': {
      const d = toDate(arg(0), a[0]!);
      return d === null ? null : addDays(d, toNum(arg(1), a[1]!), node);
    }
    case 'YEAR':
    case 'MONTH':
    case 'DAY': {
      const d = toDate(arg(0), a[0]!);
      if (d === null) return null;
      const parts = civilFromDays(d.days);
      return new D(parts[node.name === 'YEAR' ? 0 : node.name === 'MONTH' ? 1 : 2]);
    }
    case 'CONCAT':
      return textOrNull(a.map(x => toText(ev(x, env))).join(''));
    case 'UPPER':
      return textOrNull(toText(arg(0)).toUpperCase());
    case 'LOWER':
      return textOrNull(toText(arg(0)).toLowerCase());
    case 'TRIM':
      return textOrNull(toText(arg(0)).trim());
    case 'LEN':
      return new D(Array.from(toText(arg(0))).length);
    case 'LEFT':
    case 'RIGHT': {
      const chars = Array.from(toText(arg(0)));
      const n = a.length > 1 ? Math.max(0, intArg(arg(1), a[1]!, -1e6, 1e6, 'Length')) : 1;
      const part = node.name === 'LEFT' ? chars.slice(0, n) : chars.slice(Math.max(0, chars.length - n));
      return textOrNull(part.join(''));
    }
    case 'CONTAINS': {
      const hay = arg(0);
      const needle = arg(1);
      if (hay === null || needle === null) return false;
      const t = toText(needle);
      return Array.isArray(hay) ? hay.includes(t) : toText(hay).includes(t);
    }
    case 'TEXT': {
      const v = arg(0);
      if (a.length === 1 || v === null) return textOrNull(toText(v));
      const places = intArg(arg(1), a[1]!, 0, 20, 'Decimal places');
      return fixed(toNum(v, a[0]!), places);
    }
    /* v8 ignore next 2 */
    default:
      return fail('UNKNOWN_FUNCTION', `Unknown function '${node.name}'`, node.start, node.end);
  }
}

/** Evaluate a checked AST. Throws Fail (code RUNTIME) on runtime problems. */
export function ev(node: Node, env: Env): RV {
  switch (node.type) {
    case 'number':
      return (node.dec ??= new D(node.value));
    case 'string':
      return textOrNull(node.value);
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'ref':
      return readRef(node, env);
    case 'unary': {
      const v = ev(node.operand, env);
      return node.op === 'NOT' ? !truthy(v, node.operand) : toNum(v, node.operand).neg();
    }
    case 'binary':
      return binary(node, env);
    case 'call':
      return call(node, env);
  }
}

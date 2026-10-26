import type { CompiledFormula, FormulaError, FormulaScope, FormulaType } from '@procure/schema';
import { parseIsoDate } from './dates';
import { FN_NAMES, FN_SPECS } from './functions';
import { parseOrThrow, type Binding, type CallNode, type Node, type RefNode } from './parser';
import { didYouMean, Fail, own, suggest } from './util';

export interface CheckOptions {
  /** Unknown names resolve to empty values instead of UNKNOWN_FIELD (used by standalone `evaluate`). */
  lenient?: boolean;
  /** Names that exist on the form but may not be referenced (layout elements, removed fields) -> reason. */
  blocked?: ReadonlyMap<string, string>;
}

interface AggCtx {
  grid: string | null;
}

const TYPE_LABEL: Record<FormulaType, string> = {
  number: 'a number',
  text: 'text',
  date: 'a date',
  boolean: 'TRUE/FALSE',
  list: 'a multi-select list',
  any: 'a value',
  null: 'empty',
};

const LIST_MSG = 'Multi-select values can only be used with COUNT(…), CONTAINS(…) or ISBLANK(…)';
const AGG_FNS = 'SUM, AVG, MIN, MAX or COUNT';

const loose = (t: FormulaType): boolean => t === 'any' || t === 'null';

/** True when a value of type `actual` may be used where `expected` is required. */
export function compatible(actual: FormulaType, expected: FormulaType | undefined): boolean {
  if (expected === undefined || expected === 'any' || expected === 'null') return true;
  return actual === expected || loose(actual);
}

export class Checker {
  readonly errors: FormulaError[] = [];
  readonly deps: string[] = [];
  private readonly depSet = new Set<string>();
  private readonly rowCols: Record<string, FormulaType> | undefined;

  constructor(
    private readonly scope: FormulaScope,
    private readonly opts: CheckOptions = {},
  ) {
    this.rowCols = scope.rowOf !== undefined ? own(scope.grids, scope.rowOf) : undefined;
  }

  private err(code: FormulaError['code'], message: string, node: { start: number; end: number }): FormulaType {
    this.errors.push({ code, message, start: node.start, end: node.end });
    return 'any';
  }

  private dep(d: string): void {
    if (!this.depSet.has(d)) {
      this.depSet.add(d);
      this.deps.push(d);
    }
  }

  private bind(node: RefNode, b: Binding, dep: string): FormulaType {
    node.binding = b;
    this.dep(dep);
    return b.type;
  }

  // -------------------------------------------------------------------------------------------
  // References
  // -------------------------------------------------------------------------------------------

  private unknownName(node: RefNode, extra: Iterable<string>): FormulaType {
    const shown = node.attr === undefined ? node.name : `${node.name}.${node.attr}`;
    const reason = this.opts.blocked?.get(node.name);
    if (reason !== undefined) return this.err('UNKNOWN_FIELD', `'${node.name}' ${reason}`, node);
    if (this.opts.lenient)
      return this.bind(node, { kind: 'free', key: node.name, attr: node.attr, type: 'any' }, shown);
    const s = suggest(node.name, extra);
    return this.err('UNKNOWN_FIELD', `Unknown field '${node.name}'.${didYouMean(s)}`, node);
  }

  private candidates(): string[] {
    return [...Object.keys(this.rowCols ?? {}), ...Object.keys(this.scope.fields), ...Object.keys(this.scope.grids)];
  }

  private lookupAttrs(key: string, rowGrid?: string): Record<string, FormulaType> | undefined {
    const la = this.scope.lookupAttributes;
    if (rowGrid !== undefined) {
      const q = own(la, `${rowGrid}.${key}`);
      if (q !== undefined) return q;
      if (own(this.scope.fields, key) !== undefined) return undefined;
    }
    return own(la, key);
  }

  private attrType(node: RefNode, attrs: Record<string, FormulaType>): FormulaType | undefined {
    const attr = node.attr!;
    const t = own(attrs, attr) ?? own(attrs, '*');
    if (t !== undefined) return t;
    if (this.opts.lenient) return 'any';
    this.err(
      'UNKNOWN_FIELD',
      `Lookup '${node.name}' has no attribute '${attr}'.${didYouMean(suggest(attr, Object.keys(attrs)))}`,
      node,
    );
    return undefined;
  }

  private notLookup(node: RefNode): FormulaType {
    if (this.opts.lenient)
      return this.bind(
        node,
        { kind: 'free', key: node.name, attr: node.attr, type: 'any' },
        `${node.name}.${node.attr}`,
      );
    return this.err(
      'UNKNOWN_FIELD',
      `'${node.name}' is not a lookup field, so '${node.name}.${node.attr}' is not valid`,
      node,
    );
  }

  private ref(node: RefNode, agg: AggCtx | null, countArg: boolean): FormulaType {
    const { name, attr } = node;
    const sc = this.scope;
    const rowOf = sc.rowOf;
    if (attr === undefined) {
      const rt = this.rowCols ? own(this.rowCols, name) : undefined;
      if (rt !== undefined) return this.bind(node, { kind: 'row', key: name, type: rt }, `${rowOf}.${name}`);
      const ft = own(sc.fields, name);
      if (ft !== undefined) return this.bind(node, { kind: 'field', key: name, type: ft }, name);
      if (own(sc.grids, name) !== undefined) {
        if (!countArg) {
          return this.err(
            'AGGREGATE_REQUIRED',
            `Grid '${name}' holds many rows; use COUNT(${name}) or an aggregate such as SUM(${name}.column)`,
            node,
          );
        }
        return this.bind(node, { kind: 'grid', key: name, type: 'number' }, name);
      }
      return this.unknownName(node, this.candidates());
    }
    // Dotted reference.
    if (this.rowCols && own(this.rowCols, name) !== undefined) {
      const attrs = this.lookupAttrs(name, rowOf);
      if (attrs === undefined) return this.notLookup(node);
      const t = this.attrType(node, attrs);
      if (t === undefined) return 'any';
      return this.bind(node, { kind: 'rlattr', key: name, attr, type: t }, `${rowOf}.${name}`);
    }
    const cols = own(sc.grids, name);
    if (cols !== undefined) {
      const ct = own(cols, attr);
      if (ct === undefined) {
        return this.err(
          'UNKNOWN_FIELD',
          `Grid '${name}' has no column '${attr}'.${didYouMean(suggest(attr, Object.keys(cols)))}`,
          node,
        );
      }
      if (agg === null) {
        return this.err(
          'AGGREGATE_REQUIRED',
          `'${name}.${attr}' reads every row of grid '${name}'; wrap it in ${AGG_FNS}, e.g. SUM(${name}.${attr})`,
          node,
        );
      }
      if (agg.grid !== null && agg.grid !== name) {
        return this.err(
          'TYPE',
          `One aggregate can only read one grid, but this reads '${agg.grid}' and '${name}'`,
          node,
        );
      }
      agg.grid = name;
      return this.bind(node, { kind: 'gcol', key: name, attr, type: ct }, `${name}.${attr}`);
    }
    if (own(sc.fields, name) !== undefined) {
      const attrs = this.lookupAttrs(name);
      if (attrs === undefined) return this.notLookup(node);
      const t = this.attrType(node, attrs);
      if (t === undefined) return 'any';
      return this.bind(node, { kind: 'lattr', key: name, attr, type: t }, `${name}.${attr}`);
    }
    return this.unknownName(node, this.candidates());
  }

  // -------------------------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------------------------

  check(node: Node, agg: AggCtx | null, countArg = false): FormulaType {
    switch (node.type) {
      case 'number':
        return 'number';
      case 'string':
        return 'text';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'ref':
        return this.ref(node, agg, countArg);
      case 'unary': {
        const t = this.check(node.operand, agg);
        if (node.op === 'NOT') {
          this.wantBool(node.operand, t);
          return 'boolean';
        }
        this.wantNum(node.operand, t, 'Minus');
        return 'number';
      }
      case 'binary':
        return this.binary(node, agg);
      case 'call':
        return this.call(node, agg);
    }
  }

  private wantBool(node: Node, t: FormulaType): void {
    if (t !== 'boolean' && !loose(t)) this.err('TYPE', `Expected TRUE/FALSE here but got ${TYPE_LABEL[t]}`, node);
  }

  private wantNum(node: Node, t: FormulaType, what: string): void {
    if (t === 'list') this.err('TYPE', LIST_MSG, node);
    else if (t !== 'number' && !loose(t)) this.err('TYPE', `${what} needs a number but got ${TYPE_LABEL[t]}`, node);
  }

  private want(node: Node, t: FormulaType, expected: FormulaType, fn: string): void {
    if (expected === 'date' && node.type === 'string' && parseIsoDate(node.value) !== null) return; // '2026-03-31'
    if (t === 'list' && expected !== 'list') this.err('TYPE', LIST_MSG, node);
    else if (!compatible(t, expected))
      this.err('TYPE', `${fn} needs ${TYPE_LABEL[expected]} here but got ${TYPE_LABEL[t]}`, node);
  }

  private noList(node: Node, t: FormulaType): void {
    if (t === 'list') this.err('TYPE', LIST_MSG, node);
  }

  private binary(node: Extract<Node, { type: 'binary' }>, agg: AggCtx | null): FormulaType {
    const lt = this.check(node.left, agg);
    const rt = this.check(node.right, agg);
    node.leftType = lt;
    node.rightType = rt;
    const op = node.op;
    switch (op) {
      case 'AND':
      case 'OR':
        this.wantBool(node.left, lt);
        this.wantBool(node.right, rt);
        return 'boolean';
      case '&':
        this.noList(node.left, lt);
        this.noList(node.right, rt);
        return 'text';
      case '=':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        this.comparable(node, lt, rt, op === '=' || op === '!=');
        return 'boolean';
      case '+':
      case '-':
        return this.addSub(node, lt, rt);
      default:
        this.wantNum(node.left, lt, `'${op}'`);
        this.wantNum(node.right, rt, `'${op}'`);
        return 'number';
    }
  }

  private comparable(node: Node, lt: FormulaType, rt: FormulaType, equality: boolean): void {
    if (lt === 'list' || rt === 'list') {
      this.err('TYPE', LIST_MSG, node);
      return;
    }
    if (loose(lt) || loose(rt)) return;
    if (lt === rt) {
      if (lt === 'boolean' && !equality) this.err('TYPE', 'TRUE/FALSE values can only be compared with = or !=', node);
      return;
    }
    const pair = new Set([lt, rt]);
    if (pair.has('date') && pair.has('text')) return; // ISO text vs date
    this.err('TYPE', `Cannot compare ${TYPE_LABEL[lt]} with ${TYPE_LABEL[rt]}`, node);
  }

  private addSub(node: Extract<Node, { type: 'binary' }>, lt: FormulaType, rt: FormulaType): FormulaType {
    const op = node.op;
    if (lt === 'list' || rt === 'list') return this.err('TYPE', LIST_MSG, node);
    if (lt === 'text' || rt === 'text') {
      return this.err('TYPE', op === '+' ? 'Cannot add text; use & to join text' : 'Cannot subtract text', node);
    }
    if (lt === 'boolean' || rt === 'boolean') return this.err('TYPE', `Cannot use TRUE/FALSE with '${op}'`, node);
    const ld = lt === 'date';
    const rd = rt === 'date';
    if (op === '+') {
      if (ld && rd) return this.err('TYPE', 'Cannot add two dates; use DAYS_BETWEEN or date - date', node);
      if (ld || rd) return 'date';
      return lt === 'any' || rt === 'any' ? 'any' : 'number';
    }
    if (ld && rd) return 'number';
    if (rd) return lt === 'number' ? this.err('TYPE', 'Cannot subtract a date from a number', node) : 'any';
    if (ld) return rt === 'any' ? 'any' : 'date';
    return lt === 'any' || rt === 'any' ? 'any' : 'number';
  }

  private unify(types: { t: FormulaType; node: Node }[], what: string, at: Node): FormulaType {
    let out: FormulaType = 'null';
    for (const { t, node } of types) {
      if (t === 'list') {
        this.err('TYPE', LIST_MSG, node);
        return 'any';
      }
      if (t === 'null' || t === out) continue;
      if (t === 'any' || out === 'any') {
        out = 'any';
        continue;
      }
      if (out === 'null') {
        out = t;
        continue;
      }
      return this.err('TYPE', `${what} return different types: ${TYPE_LABEL[out]} and ${TYPE_LABEL[t]}`, at);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------------------------

  private call(node: CallNode, agg: AggCtx | null): FormulaType {
    const spec = FN_SPECS.get(node.name);
    const nameSpan = { start: node.start, end: node.start + node.name.length };
    if (spec === undefined) {
      this.err(
        'UNKNOWN_FUNCTION',
        `Unknown function '${node.name}'.${didYouMean(suggest(node.name, FN_NAMES))}`,
        nameSpan,
      );
      for (const a of node.args) this.check(a, agg);
      return 'any';
    }
    const n = node.args.length;
    if (n < spec.min || n > spec.max || (node.name === 'DATE' && n === 2)) {
      const range =
        node.name === 'DATE'
          ? '1 or 3 arguments'
          : spec.min === spec.max
            ? `${spec.min} argument${spec.min === 1 ? '' : 's'}`
            : spec.max === Infinity
              ? `at least ${spec.min} argument${spec.min === 1 ? '' : 's'}`
              : `${spec.min} to ${spec.max} arguments`;
      this.err('ARITY', `${node.name} expects ${range} but got ${n}`, node);
      const argAgg = spec.aggregate || node.name === 'SUMIF' || node.name === 'COUNTIF' ? { grid: null } : agg;
      for (const a of node.args) this.check(a, argAgg);
      return 'any';
    }
    if (spec.aggregate) return this.aggregate(node);
    if (node.name === 'SUMIF' || node.name === 'COUNTIF') return this.conditional(node);

    const a = node.args;
    const ts = a.map(x => this.check(x, agg));
    const t = (i: number): FormulaType => ts[i]!;
    const name = node.name;
    switch (name) {
      case 'IF':
        this.want(a[0]!, t(0), 'boolean', name);
        return this.unify(
          a.slice(1).map((x, i) => ({ t: t(i + 1), node: x })),
          'IF branches',
          node,
        );
      case 'IFS': {
        const vals: { t: FormulaType; node: Node }[] = [];
        for (let i = 0; i < n; i++) {
          if (i % 2 === 0 && i < n - 1) this.want(a[i]!, t(i), 'boolean', name);
          else vals.push({ t: t(i), node: a[i]! });
        }
        return this.unify(vals, 'IFS values', node);
      }
      case 'AND':
      case 'OR':
      case 'NOT':
        a.forEach((x, i) => this.want(x, t(i), 'boolean', name));
        return 'boolean';
      case 'COALESCE':
        return this.unify(
          a.map((x, i) => ({ t: t(i), node: x })),
          'COALESCE arguments',
          node,
        );
      case 'ISBLANK':
        return 'boolean';
      case 'ROUND':
      case 'FLOOR':
      case 'CEIL':
      case 'ABS':
        a.forEach((x, i) => this.want(x, t(i), 'number', name));
        return 'number';
      case 'TODAY':
        return 'date';
      case 'DATE':
        if (n === 1) this.want(a[0]!, t(0), 'text', name);
        else a.forEach((x, i) => this.want(x, t(i), 'number', name));
        return 'date';
      case 'DAYS_BETWEEN':
        a.forEach((x, i) => this.want(x, t(i), 'date', name));
        return 'number';
      case 'ADD_DAYS':
        this.want(a[0]!, t(0), 'date', name);
        this.want(a[1]!, t(1), 'number', name);
        return 'date';
      case 'YEAR':
      case 'MONTH':
      case 'DAY':
        this.want(a[0]!, t(0), 'date', name);
        return 'number';
      case 'CONCAT':
        a.forEach((x, i) => this.noList(x, t(i)));
        return 'text';
      case 'UPPER':
      case 'LOWER':
      case 'TRIM':
      case 'LEN':
        this.want(a[0]!, t(0), 'text', name);
        return name === 'LEN' ? 'number' : 'text';
      case 'LEFT':
      case 'RIGHT':
        this.want(a[0]!, t(0), 'text', name);
        if (n > 1) this.want(a[1]!, t(1), 'number', name);
        return 'text';
      case 'CONTAINS':
        if (t(0) !== 'list') this.want(a[0]!, t(0), 'text', name);
        this.want(a[1]!, t(1), 'text', name);
        return 'boolean';
      default: // TEXT
        this.noList(a[0]!, t(0));
        if (n > 1) this.want(a[1]!, t(1), 'number', name);
        return 'text';
    }
  }

  private aggregate(node: CallNode): FormulaType {
    const name = node.name;
    const grids: (string | null)[] = [];
    const ts: FormulaType[] = [];
    for (const arg of node.args) {
      const actx: AggCtx = { grid: null };
      const t = this.check(arg, actx, name === 'COUNT');
      grids.push(actx.grid);
      ts.push(t);
      if (name === 'COUNT') continue;
      if (name === 'SUM' || name === 'AVG') {
        this.want(arg, t, 'number', name);
      } else if (t === 'list') {
        this.err('TYPE', LIST_MSG, arg);
      } else if (t !== 'number' && t !== 'date' && !loose(t)) {
        this.err('TYPE', `${name} needs numbers or dates but got ${TYPE_LABEL[t]}`, arg);
      }
    }
    node.argGrids = grids;
    if (name === 'MIN' || name === 'MAX') {
      const typed = ts
        .map((t, i) => ({ t, node: node.args[i]! }))
        .filter(({ t }) => t === 'number' || t === 'date' || loose(t));
      const r = this.unify(typed, `${name} arguments`, node);
      return r === 'null' ? 'number' : r;
    }
    return 'number';
  }

  private conditional(node: CallNode): FormulaType {
    const actx: AggCtx = { grid: null };
    const ts = node.args.map(a => this.check(a, actx));
    if (node.name === 'SUMIF') {
      this.want(node.args[0]!, ts[0]!, 'number', 'SUMIF');
      this.want(node.args[1]!, ts[1]!, 'boolean', 'SUMIF');
    } else {
      this.want(node.args[0]!, ts[0]!, 'boolean', 'COUNTIF');
    }
    if (actx.grid === null)
      this.err(
        'TYPE',
        `${node.name} must refer to a grid column, e.g. ${node.name === 'SUMIF' ? 'SUMIF(lines.amount, lines.taxable = TRUE)' : "COUNTIF(lines.status = 'Open')"}`,
        node,
      );
    node.grid = actx.grid;
    return 'number';
  }
}

const TYPE_NAME: Record<FormulaType, string> = {
  number: 'a number',
  text: 'text',
  date: 'a date',
  boolean: 'TRUE/FALSE',
  list: 'a list',
  any: 'a value',
  null: 'nothing',
};

export interface Checked {
  ast: Node | null;
  compiled: CompiledFormula;
}

/** Parse + type-check. Never throws. */
export function compileInternal(
  src: string,
  scope: FormulaScope,
  expected?: FormulaType,
  opts: CheckOptions = {},
): Checked {
  let ast: Node;
  try {
    ast = parseOrThrow(src);
  } catch (e) {
    /* v8 ignore next */
    if (!(e instanceof Fail)) throw e;
    return { ast: null, compiled: { ok: false, errors: [e.error], resultType: 'any', deps: [] } };
  }
  const c = new Checker(scope, opts);
  const resultType = c.check(ast, null);
  const isoLiteral = expected === 'date' && ast.type === 'string' && parseIsoDate(ast.value) !== null;
  if (c.errors.length === 0 && !isoLiteral && !compatible(resultType, expected)) {
    c.errors.push({
      code: 'TYPE',
      message: `This formula returns ${TYPE_NAME[resultType]} but ${TYPE_NAME[expected!]} is expected`,
      start: ast.start,
      end: ast.end,
    });
  }
  return { ast, compiled: { ok: c.errors.length === 0, errors: c.errors, resultType, deps: c.deps } };
}

/** Public: compile a formula against a scope (design-time check). */
export function compile(src: string, scope: FormulaScope, expected?: FormulaType): CompiledFormula {
  return compileInternal(src, scope, expected).compiled;
}

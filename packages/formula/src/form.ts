import type {
  FormDefinition,
  FormDefinitionIssue,
  FormEvaluationResult,
  FormulaContext,
  FormulaError,
  FormulaScope,
  FormulaType,
} from '@procure/schema';
import { compileInternal, type CheckOptions } from './checker';
import { Env, ev } from './evaluator';
import type { Node } from './parser';
import { DateV, fixed, textOrNull, toDecimal, toOutput, toText, type RV } from './values';
import { formatIsoDate, parseIsoDate } from './dates';
import { Fail, isDec, own, safeCopy } from './util';

/** Structural view of a field; tolerant of raw JSON that skipped Zod defaults. */
interface LooseField {
  key: string;
  type: string;
  removed?: boolean;
  hidden?: boolean;
  required?: boolean;
  readOnly?: boolean;
  visibleWhen?: string;
  requiredWhen?: string;
  readOnlyWhen?: string;
  expr?: string;
  resultType?: 'number' | 'text' | 'date' | 'boolean';
  precision?: number;
  minDate?: string;
  maxDate?: string;
  columns?: LooseField[];
}

const LAYOUT = new Set(['tab', 'section', 'divider', 'help']);
const NUMBER_TYPES = new Set(['number', 'decimal', 'currency', 'percentage']);
const TEXT_TYPES = new Set([
  'text',
  'textarea',
  'email',
  'phone',
  'url',
  'gstin',
  'pan',
  'regex',
  'select',
  'radio',
  'time',
  'datetime',
  'lookup',
  'file',
  'image',
  'signature',
]);
const LIST_TYPES = new Set(['multiselect', 'multilookup', 'files']);
const WHEN_KEYS = ['visibleWhen', 'requiredWhen', 'readOnlyWhen'] as const;

const fieldsOf = (def: FormDefinition): LooseField[] =>
  Array.isArray(def?.fields) ? (def.fields as unknown as LooseField[]) : [];
const columnsOf = (f: LooseField): LooseField[] => (Array.isArray(f.columns) ? f.columns : []);
const active = (f: LooseField): boolean => f !== null && typeof f === 'object' && f.removed !== true;

/** Formula type of a stored field, or undefined when it cannot be referenced (daterange, grid, layout). */
function typeOfField(f: LooseField): FormulaType | undefined {
  if (NUMBER_TYPES.has(f.type)) return 'number';
  if (f.type === 'date') return 'date';
  if (f.type === 'checkbox' || f.type === 'toggle') return 'boolean';
  if (LIST_TYPES.has(f.type)) return 'list';
  if (f.type === 'formula') return f.resultType ?? 'number';
  if (TEXT_TYPES.has(f.type)) return 'text';
  return undefined;
}

function lookupAttrsFor(key: string, given: FormulaScope['lookupAttributes'] | undefined): Record<string, FormulaType> {
  const g = own(given, key);
  return g !== undefined ? { ...g, code: 'text', name: 'text' } : { code: 'text', name: 'text', '*': 'any' };
}

/**
 * Scope for formulas on this form. Header lookups are keyed by field key ('vendor'); lookup columns inside a grid by
 * '<grid>.<column>' ('lines.item'). A lookup without supplied attributes accepts any attribute (type 'any', key '*').
 */
export function scopeFromDefinition(
  def: FormDefinition,
  lookupAttributes?: FormulaScope['lookupAttributes'],
): FormulaScope {
  const fields: Record<string, FormulaType> = {};
  const grids: Record<string, Record<string, FormulaType>> = {};
  const la: Record<string, Record<string, FormulaType>> = {};
  for (const f of fieldsOf(def)) {
    if (!active(f) || LAYOUT.has(f.type)) continue;
    if (f.type === 'grid') {
      const cols: Record<string, FormulaType> = {};
      for (const c of columnsOf(f)) {
        if (!active(c)) continue;
        const t = typeOfField(c);
        if (t !== undefined) cols[c.key] = t;
        if (c.type === 'lookup') la[`${f.key}.${c.key}`] = lookupAttrsFor(`${f.key}.${c.key}`, lookupAttributes);
      }
      grids[f.key] = cols;
      continue;
    }
    const t = typeOfField(f);
    if (t !== undefined) fields[f.key] = t;
    if (f.type === 'lookup') la[f.key] = lookupAttrsFor(f.key, lookupAttributes);
  }
  return { fields, grids, lookupAttributes: la };
}

// ---------------------------------------------------------------------------------------------
// Collecting expressions
// ---------------------------------------------------------------------------------------------

interface ExprSite {
  path: string;
  src: unknown;
  expected: FormulaType;
  /** Set for grid column formulas. */
  rowOf?: string;
  /** Dependency-graph node id for formula fields: 'total' or 'lines.amount'. */
  nodeId?: string;
}

interface FormulaNode {
  id: string;
  path: string;
  field: LooseField;
  grid?: string;
  index: number;
}

function blockedFor(def: FormDefinition, grid?: LooseField): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of fieldsOf(def)) {
    if (f === null || typeof f !== 'object') continue;
    if (f.removed === true) m.set(f.key, 'was removed from this form and cannot be used in formulas');
    else if (LAYOUT.has(f.type)) m.set(f.key, `is a ${f.type} (layout element) and holds no value`);
    else if (f.type === 'daterange') m.set(f.key, 'is a date range; date ranges cannot be used in formulas');
  }
  if (grid)
    for (const c of columnsOf(grid))
      if (c.removed === true) m.set(c.key, 'was removed from this grid and cannot be used in formulas');
  return m;
}

function collect(def: FormDefinition): { sites: ExprSite[]; nodes: FormulaNode[] } {
  const sites: ExprSite[] = [];
  const nodes: FormulaNode[] = [];
  const whens = (f: LooseField, base: string): void => {
    for (const k of WHEN_KEYS)
      if (f[k] !== undefined && f[k] !== '') sites.push({ path: `${base}.${k}`, src: f[k], expected: 'boolean' });
    if (f.type === 'date') {
      for (const k of ['minDate', 'maxDate'] as const)
        if (f[k] !== undefined && f[k] !== '') sites.push({ path: `${base}.${k}`, src: f[k], expected: 'date' });
    }
  };
  fieldsOf(def).forEach((f, i) => {
    if (!active(f)) return;
    const base = `fields.${i}`;
    if (f.type === 'formula') {
      sites.push({ path: `${base}.expr`, src: f.expr, expected: f.resultType ?? 'number', nodeId: f.key });
      nodes.push({ id: f.key, path: `${base}.expr`, field: f, index: nodes.length });
    }
    whens(f, base);
    if (f.type === 'grid') {
      columnsOf(f).forEach((c, j) => {
        if (!active(c)) return;
        const cbase = `${base}.columns.${j}`;
        if (c.type === 'formula') {
          const id = `${f.key}.${c.key}`;
          sites.push({
            path: `${cbase}.expr`,
            src: c.expr,
            expected: c.resultType ?? 'number',
            rowOf: f.key,
            nodeId: id,
          });
          nodes.push({ id, path: `${cbase}.expr`, field: c, grid: f.key, index: nodes.length });
        }
        whens(c, cbase);
      });
    }
  });
  const validations = Array.isArray(def?.validations) ? def.validations : [];
  validations.forEach((v, k) => sites.push({ path: `validations.${k}.expr`, src: v?.expr, expected: 'boolean' }));
  return { sites, nodes };
}

// ---------------------------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------------------------

interface Graph {
  order: string[];
  /** node id -> loop text, for nodes that sit on a cycle. */
  cycles: Map<string, string>;
  /** Nodes that are not on a cycle but depend on one. */
  blockedByCycle: Set<string>;
}

function analyse(nodes: FormulaNode[], deps: Map<string, string[]>): Graph {
  const ids = new Set(nodes.map(n => n.id));
  const edges = new Map<string, string[]>();
  for (const n of nodes)
    edges.set(
      n.id,
      (deps.get(n.id) ?? []).filter(d => ids.has(d)),
    );
  // Kahn: a node is ready once all its formula dependencies are done.
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    const e = [...new Set(edges.get(n.id)!)];
    pending.set(n.id, e.length);
    for (const d of e) dependents.set(d, [...(dependents.get(d) ?? []), n.id]);
  }
  const order: string[] = [];
  const queue = nodes.filter(n => pending.get(n.id) === 0).map(n => n.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dep of dependents.get(id) ?? []) {
      const left = pending.get(dep)! - 1;
      pending.set(dep, left);
      if (left === 0) queue.push(dep);
    }
  }
  const done = new Set(order);
  const rest = nodes.filter(n => !done.has(n.id)).map(n => n.id);
  const restSet = new Set(rest);
  const cycles = new Map<string, string>();
  const blockedByCycle = new Set<string>();
  for (const start of rest) {
    // Shortest path start -> ... -> start inside the unresolved set.
    const prev = new Map<string, string>();
    const q = [start];
    let found = false;
    while (q.length > 0 && !found) {
      const cur = q.shift()!;
      for (const nx of edges.get(cur)!) {
        if (!restSet.has(nx)) continue;
        if (nx === start) {
          prev.set(start, cur);
          found = true;
          break;
        }
        if (!prev.has(nx)) {
          prev.set(nx, cur);
          q.push(nx);
        }
      }
    }
    if (!found) {
      blockedByCycle.add(start);
      continue;
    }
    const path = [start];
    let cur = prev.get(start)!;
    while (cur !== start) {
      path.push(cur);
      cur = prev.get(cur)!;
    }
    path.push(start);
    // path is start <- ... ; the formula `start` reads path[1] reversed: start → (what start reads) → …
    const loop = [start, ...path.slice(1, -1).reverse(), start];
    cycles.set(
      start,
      loop.length === 2
        ? `Circular reference: ${start} → ${start} ('${start}' refers to itself)`
        : `Circular reference: ${loop.join(' → ')}`,
    );
  }
  return { order, cycles, blockedByCycle };
}

// ---------------------------------------------------------------------------------------------
// checkDefinition
// ---------------------------------------------------------------------------------------------

const ISSUE_CODE: Record<FormulaError['code'], FormDefinitionIssue['code']> = {
  SYNTAX: 'FORMULA_SYNTAX',
  LIMIT: 'FORMULA_SYNTAX',
  UNKNOWN_FUNCTION: 'FORMULA_SYNTAX',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD_REF',
  ARITY: 'FORMULA_TYPE',
  TYPE: 'FORMULA_TYPE',
  AGGREGATE_REQUIRED: 'FORMULA_TYPE',
  CYCLE: 'FORMULA_CYCLE',
  RUNTIME: 'FORMULA_TYPE',
};

/** Design-time check of every expression on a form: syntax, refs, types, aggregates and cycles. */
export function checkDefinition(
  def: FormDefinition,
  lookupAttributes?: FormulaScope['lookupAttributes'],
): FormDefinitionIssue[] {
  const header = scopeFromDefinition(def, lookupAttributes);
  const { sites, nodes } = collect(def);
  const gridFields = new Map(
    fieldsOf(def)
      .filter(f => active(f) && f.type === 'grid')
      .map(f => [f.key, f]),
  );
  const headerOpts: CheckOptions = { blocked: blockedFor(def) };
  const issues: FormDefinitionIssue[] = [];
  const deps = new Map<string, string[]>();
  for (const s of sites) {
    if (typeof s.src !== 'string' || s.src.trim() === '') {
      issues.push({ path: s.path, code: 'FORMULA_SYNTAX', message: 'Formula is empty' });
      continue;
    }
    const scope = s.rowOf !== undefined ? { ...header, rowOf: s.rowOf } : header;
    const opts = s.rowOf !== undefined ? { blocked: blockedFor(def, gridFields.get(s.rowOf)) } : headerOpts;
    const { compiled } = compileInternal(s.src, scope, s.expected, opts);
    for (const e of compiled.errors) issues.push({ path: s.path, code: ISSUE_CODE[e.code], message: e.message });
    if (s.nodeId !== undefined) deps.set(s.nodeId, compiled.deps);
  }
  const g = analyse(nodes, deps);
  for (const n of nodes) {
    const msg = g.cycles.get(n.id);
    if (msg !== undefined) issues.push({ path: n.path, code: 'FORMULA_CYCLE', message: msg });
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------
// evaluateForm
// ---------------------------------------------------------------------------------------------

export interface EvaluateFormInput {
  values: Record<string, unknown>;
  lookups?: Record<string, Record<string, unknown> | null>;
  /** grid key -> row id (`_row`) -> lookup column key -> attributes of the chosen record. */
  rowLookups?: Record<string, Record<string, Record<string, Record<string, unknown> | null>>>;
  today: string;
  defaultPrecision?: number;
}

export interface ValidationResult {
  key: string;
  message: string;
  /** False blocks the save. Empty (null) and runtime errors count as false. */
  ok: boolean;
  error?: FormulaError;
}

/** FormEvaluationResult plus two additive extras the server needs on save. */
export interface FormEvaluation extends FormEvaluationResult {
  /** Form-level `validations`, in definition order. */
  validations: ValidationResult[];
  /** Evaluated minDate/maxDate ('YYYY-MM-DD' or null) per date field key (grid columns: '<grid>.<col>'). */
  dateBounds: Record<string, { min: string | null; max: string | null }>;
}

const runtimeError = (e: unknown): FormulaError => {
  /* v8 ignore next */
  if (!(e instanceof Fail)) throw e;
  return e.error;
};

/** Runtime value -> stored value of a formula field of the given result type. */
function toResult(v: RV, resultType: FormulaType, precision: number, ast: Node): unknown {
  if (v === null) return null;
  const mismatch = (what: string): never => {
    throw new Fail({
      code: 'RUNTIME',
      message: `Formula produced ${toText(v)} but ${what} is expected`,
      start: ast.start,
      end: ast.end,
    });
  };
  switch (resultType) {
    case 'number': {
      const d = isDec(v) ? v : typeof v === 'string' ? toDecimal(v) : undefined;
      return d === undefined ? mismatch('a number') : fixed(d, precision);
    }
    case 'date': {
      if (v instanceof DateV) return formatIsoDate(v.days);
      return typeof v === 'string' && parseIsoDate(v) !== null ? v : mismatch('a date');
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : mismatch('TRUE/FALSE');
    default:
      return textOrNull(toText(v));
  }
}

/**
 * Compute every formula (header and grid cells), then visibility / required / read-only for every field, tab,
 * section and grid column. Formulas run in dependency order across header and grid (a grid column formula fills
 * all rows at once), which is the contract's "grid columns row by row, then header" order generalised so that a
 * grid column may also read a header formula.
 */
export function evaluateForm(def: FormDefinition, input: EvaluateFormInput): FormEvaluation {
  const header = scopeFromDefinition(def);
  const { sites, nodes } = collect(def);
  const fields = fieldsOf(def);
  const gridFields = new Map(fields.filter(f => active(f) && f.type === 'grid').map(f => [f.key, f]));
  const headerOpts: CheckOptions = { blocked: blockedFor(def) };
  const compiled = new Map<string, { ast: Node | null; errors: FormulaError[] }>();
  const deps = new Map<string, string[]>();
  for (const s of sites) {
    if (typeof s.src !== 'string') continue;
    const scope = s.rowOf !== undefined ? { ...header, rowOf: s.rowOf } : header;
    const opts = s.rowOf !== undefined ? { blocked: blockedFor(def, gridFields.get(s.rowOf)) } : headerOpts;
    const c = compileInternal(s.src, scope, s.expected, opts);
    compiled.set(s.path, { ast: c.compiled.ok ? c.ast : null, errors: c.compiled.errors });
    if (s.nodeId !== undefined) deps.set(s.nodeId, c.compiled.deps);
  }
  const compiledAt = (path: string): { ast: Node | null; errors: FormulaError[] } =>
    compiled.get(path) ?? { ast: null, errors: [{ code: 'SYNTAX', message: 'Formula is empty' }] };

  const values = safeCopy(input.values ?? {});
  const errors: Record<string, FormulaError> = {};
  const precisionOf = (f: LooseField): number => f.precision ?? input.defaultPrecision ?? 2;
  // Grids with formula columns get fresh row objects so the caller's input is never mutated.
  for (const g of new Set(nodes.filter(n => n.grid !== undefined).map(n => n.grid!))) {
    const rows = own(values, g);
    values[g] = Array.isArray(rows)
      ? rows.map(r =>
          r !== null && typeof r === 'object' && !Array.isArray(r) ? safeCopy(r as Record<string, unknown>) : r,
        )
      : [];
  }
  const env = new Env(values, input.lookups ?? undefined, input.today);
  const rowIdOf = (row: Record<string, unknown>, i: number): string => {
    const id = own(row, '_row');
    return typeof id === 'string' && id !== '' ? id : String(i);
  };

  const g = analyse(nodes, deps);
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    const loop =
      g.cycles.get(n.id) ?? (g.blockedByCycle.has(n.id) ? `'${n.id}' depends on a circular reference` : undefined);
    if (loop === undefined) continue;
    errors[n.id] = { code: 'CYCLE', message: loop };
    if (n.grid === undefined) values[n.field.key] = null;
    else for (const row of env.rows(n.grid)) row[n.field.key] = null;
  }

  for (const id of g.order) {
    const n = byId.get(id)!;
    const f = n.field;
    const { ast, errors: compileErrors } = compiledAt(n.path);
    const resultType = f.resultType ?? 'number';
    const precision = precisionOf(f);
    if (n.grid === undefined) {
      env.row = undefined;
      env.rowLookups = undefined;
      if (ast === null) {
        values[f.key] = null;
        errors[f.key] = compileErrors[0]!;
        continue;
      }
      try {
        values[f.key] = toResult(ev(ast, env), resultType, precision, ast);
      } catch (e) {
        values[f.key] = null;
        errors[f.key] = runtimeError(e);
      }
      continue;
    }
    const grid = n.grid;
    const rowLookupsOfGrid = own(input.rowLookups, grid);
    if (ast === null) {
      errors[id] = compileErrors[0]!;
      for (const row of env.rows(grid)) row[f.key] = null;
      continue;
    }
    env.rows(grid).forEach((row, i) => {
      const rid = rowIdOf(row, i);
      env.row = row;
      env.rowLookups = own(rowLookupsOfGrid, rid) ?? undefined;
      try {
        row[f.key] = toResult(ev(ast, env), resultType, precision, ast);
      } catch (e) {
        row[f.key] = null;
        errors[`${grid}.${rid}.${f.key}`] = runtimeError(e);
      }
    });
    env.row = undefined;
    env.rowLookups = undefined;
  }

  // Header-scope boolean / date expressions.
  const run = (path: string, errKey: string): RV | undefined => {
    const c = compiled.get(path);
    if (c === undefined) return undefined;
    if (c.ast === null) {
      errors[errKey] = c.errors[0]!;
      return undefined;
    }
    try {
      return ev(c.ast, env);
    } catch (e) {
      errors[errKey] = runtimeError(e);
      return undefined;
    }
  };
  const when = (
    f: LooseField,
    base: string,
    key: string,
    k: (typeof WHEN_KEYS)[number],
    fallback: boolean,
  ): boolean => {
    if (f[k] === undefined || f[k] === '') return fallback;
    const v = run(`${base}.${k}`, `${key}.${k}`);
    return v === undefined ? fallback : v === true;
  };

  const state: FormEvaluationResult['state'] = {};
  const dateBounds: FormEvaluation['dateBounds'] = {};
  const bounds = (f: LooseField, base: string, key: string): void => {
    if (f.type !== 'date' || (f.minDate === undefined && f.maxDate === undefined)) return;
    const b: { min: string | null; max: string | null } = { min: null, max: null };
    for (const [k, out] of [
      ['minDate', 'min'],
      ['maxDate', 'max'],
    ] as const) {
      if (f[k] === undefined || f[k] === '') continue;
      const v = run(`${base}.${k}`, `${key}.${k}`);
      b[out] =
        v instanceof DateV ? formatIsoDate(v.days) : typeof v === 'string' && parseIsoDate(v) !== null ? v : null;
    }
    dateBounds[key] = b;
  };
  const fieldState = (f: LooseField, base: string, key: string, containerVisible: boolean): boolean => {
    const visible = containerVisible && f.hidden !== true && when(f, base, key, 'visibleWhen', true);
    const isFormula = f.type === 'formula';
    const required = visible && !isFormula && (f.required === true || when(f, base, key, 'requiredWhen', false));
    const readOnly = isFormula || f.readOnly === true || when(f, base, key, 'readOnlyWhen', false);
    state[key] = { visible, required, readOnly };
    bounds(f, base, key);
    return visible;
  };

  let tabVisible = true;
  let sectionVisible = true;
  fields.forEach((f, i) => {
    if (!active(f)) return;
    const base = `fields.${i}`;
    if (f.type === 'tab') {
      tabVisible = when(f, base, f.key, 'visibleWhen', true);
      sectionVisible = tabVisible;
      state[f.key] = { visible: tabVisible, required: false, readOnly: false };
      return;
    }
    if (f.type === 'section') {
      sectionVisible = tabVisible && when(f, base, f.key, 'visibleWhen', true);
      state[f.key] = { visible: sectionVisible, required: false, readOnly: false };
      return;
    }
    if (f.type === 'divider' || f.type === 'help') {
      state[f.key] = { visible: sectionVisible, required: false, readOnly: false };
      return;
    }
    const gridVisible = fieldState(f, base, f.key, sectionVisible);
    if (f.type === 'grid') {
      columnsOf(f).forEach((c, j) => {
        if (active(c)) fieldState(c, `${base}.columns.${j}`, `${f.key}.${c.key}`, gridVisible);
      });
    }
  });

  const validations: ValidationResult[] = (Array.isArray(def?.validations) ? def.validations : []).map((v, k) => {
    const key = `validations.${v.key}`;
    const r = run(`validations.${k}.expr`, key);
    const res: ValidationResult = { key: v.key, message: v.message, ok: r === true };
    if (errors[key] !== undefined) {
      res.error = errors[key];
      delete errors[key];
    }
    return res;
  });

  return { values, state, errors, validations, dateBounds };
}

// ---------------------------------------------------------------------------------------------
// Standalone evaluate
// ---------------------------------------------------------------------------------------------

/** Internal grid key for `ctx.row` in standalone evaluation. Not a valid field key, so it cannot collide. */
const ROW = '\u0000row';

function isRowArray(v: unknown): v is Record<string, unknown>[] {
  return Array.isArray(v) && v.some(r => r !== null && typeof r === 'object' && !Array.isArray(r));
}

/** Scope inferred from the context's shape; every value is dynamically typed ('any'). */
function inferScope(ctx: FormulaContext): FormulaScope {
  const fields: Record<string, FormulaType> = {};
  const grids: Record<string, Record<string, FormulaType>> = {};
  const la: Record<string, Record<string, FormulaType>> = {};
  const set = (o: Record<string, unknown>, k: string, v: unknown): void => {
    if (k !== '__proto__') o[k] = v;
  };
  const values = ctx.values ?? {};
  for (const k of Object.keys(values)) {
    const v = values[k];
    if (isRowArray(v)) {
      const cols: Record<string, FormulaType> = {};
      for (const r of v) if (r !== null && typeof r === 'object') for (const c of Object.keys(r)) set(cols, c, 'any');
      set(grids, k, cols);
    } else set(fields, k, 'any');
  }
  for (const k of Object.keys(ctx.lookups ?? {})) {
    if (own(fields, k) === undefined) set(fields, k, 'any');
    set(la, k, { '*': 'any' });
  }
  let rowOf: string | undefined;
  if (ctx.row !== undefined && ctx.row !== null) {
    const cols: Record<string, FormulaType> = {};
    for (const k of [...Object.keys(ctx.row), ...Object.keys(ctx.rowLookups ?? {})]) set(cols, k, 'any');
    for (const k of Object.keys(ctx.rowLookups ?? {})) set(la, `${ROW}.${k}`, { '*': 'any' });
    grids[ROW] = cols;
    rowOf = ROW;
  }
  return { fields, grids, lookupAttributes: la, rowOf };
}

/**
 * Evaluate one formula against raw values. Types are inferred from the values (decimal strings are numbers,
 * 'YYYY-MM-DD' strings are dates); unknown names are empty. Numbers are rounded to `ctx.defaultPrecision` when
 * given, otherwise returned at full precision.
 */
export function evaluate(src: string, ctx: FormulaContext): { value: unknown; error?: FormulaError } {
  const scope = inferScope(ctx);
  const { ast, compiled } = compileInternal(src, scope, undefined, { lenient: true });
  if (ast === null || !compiled.ok) return { value: null, error: compiled.errors[0] };
  const env = new Env(ctx.values ?? {}, ctx.lookups ?? undefined, ctx.today, ctx.row, ctx.rowLookups ?? undefined);
  try {
    return { value: toOutput(ev(ast, env), ctx.defaultPrecision) };
  } catch (e) {
    return { value: null, error: runtimeError(e) };
  }
}

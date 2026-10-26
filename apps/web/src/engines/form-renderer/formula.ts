/**
 * Thin adapter over @procure/formula. The engine is built in parallel against packages/schema/src/formula.ts; this
 * file binds to the declared signatures through a namespace import so the web app type-checks and runs before and
 * after the package lands. When a function is missing (package not built yet) safe fallbacks keep forms usable:
 * no computed values, visibility/required/read-only from the static field flags only.
 */
import * as FormulaPkg from '@procure/formula';
import type {
  CompiledFormula, DataField, Field, FormDefinition, FormDefinitionIssue, FormEvaluationResult, FormulaContext,
  FormulaError, FormulaScope, FormulaType,
} from '@procure/schema';

export interface FunctionDoc { name: string; signature: string; description: string; example: string }

export interface EvaluateInput {
  values: Record<string, unknown>;
  lookups?: Record<string, Record<string, unknown> | null>;
  rowLookups?: Record<string, Record<string, Record<string, Record<string, unknown> | null>>>;
  today: string;
  defaultPrecision?: number;
}

interface FormulaApi {
  parse?: (src: string) => { ast: unknown | null; errors: FormulaError[] };
  compile?: (src: string, scope: FormulaScope, expected?: FormulaType) => CompiledFormula;
  evaluate?: (src: string, ctx: FormulaContext) => { value: unknown; error?: FormulaError };
  scopeFromDefinition?: (def: FormDefinition, lookupAttributes?: FormulaScope['lookupAttributes']) => FormulaScope;
  checkDefinition?: (def: FormDefinition, lookupAttributes?: FormulaScope['lookupAttributes']) => FormDefinitionIssue[];
  evaluateForm?: (def: FormDefinition, input: EvaluateInput) => FormEvaluationResult;
  FUNCTIONS?: readonly FunctionDoc[];
}

const engine = FormulaPkg as unknown as FormulaApi;

export const formulaEngineReady = () => typeof engine.evaluateForm === 'function';

// ------------------------------------------------------------------ helpers

const LAYOUT = new Set(['tab', 'section', 'divider', 'help']);
export const isDataField = (f: Field): f is DataField => !LAYOUT.has(f.type);

/** Formula type a data field exposes to expressions. */
export function formulaTypeOf(f: { type: string; resultType?: string }): FormulaType {
  switch (f.type) {
    case 'number': case 'decimal': case 'currency': case 'percentage': return 'number';
    case 'date': return 'date';
    case 'checkbox': case 'toggle': return 'boolean';
    case 'multiselect': case 'multilookup': case 'files': return 'list';
    case 'formula': return (f.resultType as FormulaType) ?? 'number';
    case 'grid': case 'daterange': return 'any';
    default: return 'text';
  }
}

function localScope(def: FormDefinition, lookupAttributes: FormulaScope['lookupAttributes'] = {}): FormulaScope {
  const scope: FormulaScope = { fields: {}, grids: {}, lookupAttributes: {} };
  for (const f of def.fields) {
    if (!isDataField(f) || f.removed) continue;
    if (f.type === 'grid') {
      scope.grids[f.key] = Object.fromEntries(f.columns.filter(c => !c.removed).map(c => [c.key, formulaTypeOf(c)]));
      for (const c of f.columns) if (c.type === 'lookup') scope.lookupAttributes[c.key] = { code: 'text', name: 'text', ...(lookupAttributes[c.key] ?? {}) };
      continue;
    }
    scope.fields[f.key] = formulaTypeOf(f);
    if (f.type === 'lookup') scope.lookupAttributes[f.key] = { code: 'text', name: 'text', ...(lookupAttributes[f.key] ?? {}) };
  }
  return scope;
}

export function scopeFromDefinition(def: FormDefinition, lookupAttributes?: FormulaScope['lookupAttributes']): FormulaScope {
  if (engine.scopeFromDefinition) {
    try { return engine.scopeFromDefinition(def, lookupAttributes); } catch { /* fall back */ }
  }
  return localScope(def, lookupAttributes);
}

export function compile(src: string, scope: FormulaScope, expected?: FormulaType): CompiledFormula {
  if (engine.compile) {
    try { return engine.compile(src, scope, expected); } catch (e) {
      return { ok: false, errors: [{ code: 'RUNTIME', message: (e as Error).message }], resultType: 'any', deps: [] };
    }
  }
  return { ok: true, errors: [], resultType: expected ?? 'any', deps: [] };
}

export function evaluate(src: string, ctx: FormulaContext): { value: unknown; error?: FormulaError } {
  if (!engine.evaluate) return { value: null, error: { code: 'RUNTIME', message: 'The formula engine is not available yet.' } };
  try { return engine.evaluate(src, ctx); } catch (e) {
    return { value: null, error: { code: 'RUNTIME', message: (e as Error).message } };
  }
}

export function checkDefinition(def: FormDefinition, lookupAttributes?: FormulaScope['lookupAttributes']): FormDefinitionIssue[] {
  if (!engine.checkDefinition) return [];
  try { return engine.checkDefinition(def, lookupAttributes); } catch { return []; }
}

export function functions(): readonly FunctionDoc[] {
  return engine.FUNCTIONS ?? FALLBACK_FUNCTIONS;
}

/** Static state when the engine is unavailable or throws: flags only, no computed values. */
function fallbackEvaluate(def: FormDefinition, input: EvaluateInput): FormEvaluationResult {
  const state: FormEvaluationResult['state'] = {};
  for (const f of def.fields) {
    const d = f as Partial<DataField> & { key: string };
    state[f.key] = { visible: !d.hidden, required: !!d.required, readOnly: !!d.readOnly };
    if (f.type === 'grid') for (const c of f.columns) state[`${f.key}.${c.key}`] = { visible: !c.hidden, required: !!c.required, readOnly: !!c.readOnly };
  }
  return { values: input.values, state, errors: {} };
}

export function evaluateForm(def: FormDefinition, input: EvaluateInput): FormEvaluationResult {
  if (!engine.evaluateForm) return fallbackEvaluate(def, input);
  try {
    return engine.evaluateForm(def, input);
  } catch {
    return fallbackEvaluate(def, input);
  }
}

/** Today as YYYY-MM-DD in the given IANA timezone (tenant timezone; browser zone when unknown). */
export function todayIn(timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Lookup attributes referenced by expressions (`vendor.gstin` -> { vendor: ['gstin'] }), so options fetch them. */
export function referencedLookupAttrs(def: FormDefinition): Record<string, Set<string>> {
  const lookupKeys = new Set<string>();
  const exprs: string[] = [];
  const visit = (f: Record<string, unknown>) => {
    if (f.type === 'lookup') lookupKeys.add(f.key as string);
    for (const k of ['expr', 'visibleWhen', 'requiredWhen', 'readOnlyWhen', 'minDate', 'maxDate']) if (typeof f[k] === 'string') exprs.push(f[k] as string);
    if (Array.isArray(f.columns)) (f.columns as Record<string, unknown>[]).forEach(visit);
  };
  def.fields.forEach(f => visit(f as unknown as Record<string, unknown>));
  def.validations?.forEach(v => exprs.push(v.expr));
  const out: Record<string, Set<string>> = {};
  const re = /\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/g;
  for (const src of exprs) {
    for (const m of src.matchAll(re)) {
      if (!lookupKeys.has(m[1]!)) continue;
      (out[m[1]!] ??= new Set()).add(m[2]!);
    }
  }
  return out;
}

/** Shown in autocomplete when the engine has not landed yet (mirrors docs/contracts/formula-language.md). */
const FALLBACK_FUNCTIONS: FunctionDoc[] = [
  { name: 'IF', signature: 'IF(cond, then, else)', description: 'Returns then when cond is true, else otherwise.', example: "IF(qty > 10, 'Bulk', 'Single')" },
  { name: 'IFS', signature: 'IFS(c1, v1, c2, v2, …, default)', description: 'First value whose condition is true.', example: "IFS(total > 1000, 'High', 'Low')" },
  { name: 'AND', signature: 'AND(a, b, …)', description: 'True when every argument is true.', example: 'AND(a, b)' },
  { name: 'OR', signature: 'OR(a, b, …)', description: 'True when any argument is true.', example: 'OR(a, b)' },
  { name: 'NOT', signature: 'NOT(a)', description: 'Negates a boolean.', example: 'NOT(done)' },
  { name: 'ROUND', signature: 'ROUND(n, places=0)', description: 'Rounds half-up.', example: 'ROUND(rate * 1.18, 2)' },
  { name: 'FLOOR', signature: 'FLOOR(n, places=0)', description: 'Rounds down.', example: 'FLOOR(qty)' },
  { name: 'CEIL', signature: 'CEIL(n, places=0)', description: 'Rounds up.', example: 'CEIL(qty)' },
  { name: 'ABS', signature: 'ABS(n)', description: 'Absolute value.', example: 'ABS(diff)' },
  { name: 'MIN', signature: 'MIN(a, b, …)', description: 'Smallest value, or of a grid column.', example: 'MIN(lines.rate)' },
  { name: 'MAX', signature: 'MAX(a, b, …)', description: 'Largest value, or of a grid column.', example: 'MAX(lines.rate)' },
  { name: 'SUM', signature: 'SUM(grid.column)', description: 'Adds a grid column.', example: 'SUM(lines.amount)' },
  { name: 'AVG', signature: 'AVG(grid.column)', description: 'Average of a grid column.', example: 'AVG(lines.rate)' },
  { name: 'COUNT', signature: 'COUNT(grid)', description: 'Number of rows or selected values.', example: 'COUNT(lines)' },
  { name: 'SUMIF', signature: 'SUMIF(grid.column, condition)', description: 'Adds rows matching a condition.', example: 'SUMIF(lines.amount, lines.taxable = TRUE)' },
  { name: 'COUNTIF', signature: 'COUNTIF(grid.column, condition)', description: 'Counts rows matching a condition.', example: 'COUNTIF(lines.qty, lines.qty > 0)' },
  { name: 'COALESCE', signature: 'COALESCE(a, b, …)', description: 'First value that is not empty.', example: 'COALESCE(discount, 0)' },
  { name: 'ISBLANK', signature: 'ISBLANK(x)', description: 'True when empty.', example: 'ISBLANK(remarks)' },
  { name: 'TODAY', signature: 'TODAY()', description: "Today's date in the company timezone.", example: 'TODAY()' },
  { name: 'DAYS_BETWEEN', signature: 'DAYS_BETWEEN(start, end)', description: 'Days from start to end.', example: 'DAYS_BETWEEN(order_date, TODAY())' },
  { name: 'ADD_DAYS', signature: 'ADD_DAYS(date, n)', description: 'Adds days to a date.', example: 'ADD_DAYS(TODAY(), 30)' },
  { name: 'YEAR', signature: 'YEAR(d)', description: 'Year of a date.', example: 'YEAR(TODAY())' },
  { name: 'MONTH', signature: 'MONTH(d)', description: 'Month of a date (1–12).', example: 'MONTH(TODAY())' },
  { name: 'DAY', signature: 'DAY(d)', description: 'Day of the month.', example: 'DAY(TODAY())' },
  { name: 'CONCAT', signature: 'CONCAT(a, b, …)', description: 'Joins text.', example: "CONCAT(code, '-', name)" },
  { name: 'UPPER', signature: 'UPPER(text)', description: 'Upper case.', example: 'UPPER(name)' },
  { name: 'LOWER', signature: 'LOWER(text)', description: 'Lower case.', example: 'LOWER(name)' },
  { name: 'TRIM', signature: 'TRIM(text)', description: 'Removes surrounding spaces.', example: 'TRIM(name)' },
  { name: 'LEN', signature: 'LEN(text)', description: 'Length of text.', example: 'LEN(name)' },
  { name: 'LEFT', signature: 'LEFT(text, n)', description: 'First n characters.', example: 'LEFT(gstin, 2)' },
  { name: 'RIGHT', signature: 'RIGHT(text, n)', description: 'Last n characters.', example: 'RIGHT(code, 3)' },
  { name: 'CONTAINS', signature: 'CONTAINS(text_or_list, needle)', description: 'True when the text or list contains the value.', example: "CONTAINS(applies_to, 'po')" },
  { name: 'TEXT', signature: 'TEXT(n, places)', description: 'Number as text with fixed places.', example: 'TEXT(total, 2)' },
];

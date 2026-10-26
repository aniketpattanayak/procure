import * as formulaPkg from '@procure/formula';
import type {
  FormDefinition, FormDefinitionIssue, FormEvaluationResult, FormulaContext, FormulaError, FormulaScope, FormulaType,
} from '@procure/schema';
import { isDataField, isGrid } from './definition';

/**
 * Thin seam over @procure/formula (frozen API in packages/schema/src/formula.ts). Keeps the engine compiling and
 * usable while the formula package is built in parallel; once it exports its functions they are used directly.
 */
export interface FormulaLib {
  checkDefinition(def: FormDefinition, lookupAttributes?: FormulaScope['lookupAttributes']): FormDefinitionIssue[];
  evaluateForm(def: FormDefinition, input: {
    values: Record<string, unknown>;
    lookups?: Record<string, Record<string, unknown> | null>;
    rowLookups?: Record<string, Record<string, Record<string, Record<string, unknown> | null>>>;
    today: string;
    defaultPrecision?: number;
  }): FormEvaluationResult;
  evaluate(src: string, ctx: FormulaContext): { value: unknown; error?: FormulaError };
  compile(src: string, scope: FormulaScope, expected?: FormulaType): { ok: boolean; errors: FormulaError[] };
  scopeFromDefinition(def: FormDefinition, lookupAttributes?: FormulaScope['lookupAttributes']): FormulaScope;
}

const pkg = formulaPkg as unknown as Partial<FormulaLib>;

export function formulaLib(): FormulaLib | null {
  return typeof pkg.evaluateForm === 'function' && typeof pkg.checkDefinition === 'function' && typeof pkg.evaluate === 'function'
    ? (pkg as FormulaLib)
    : null;
}

export const formulaAvailable = () => formulaLib() !== null;

export function checkFormulas(def: FormDefinition, lookupAttributes: FormulaScope['lookupAttributes']): FormDefinitionIssue[] {
  const lib = formulaLib();
  return lib ? lib.checkDefinition(def, lookupAttributes) : [];
}

/**
 * Evaluates every formula and *When rule. Without the formula package, formula results are null and state falls back
 * to the static flags (visible unless hidden, required as declared).
 */
export function evaluateForm(def: FormDefinition, input: Parameters<FormulaLib['evaluateForm']>[1]): FormEvaluationResult {
  const lib = formulaLib();
  if (lib) return lib.evaluateForm(def, input);
  const values = { ...input.values };
  const state: FormEvaluationResult['state'] = {};
  for (const f of def.fields) {
    if (!isDataField(f)) continue;
    state[f.key] = { visible: !f.hidden, required: f.required, readOnly: f.readOnly || f.type === 'formula' };
    if (f.type === 'formula') values[f.key] = null;
    if (isGrid(f)) for (const c of f.columns) state[`${f.key}.${c.key}`] = { visible: !c.hidden, required: c.required, readOnly: c.readOnly };
  }
  return { values, state, errors: {} };
}

/** A single expression (form validations, date bounds). Returns undefined when the formula package is missing. */
export function evaluateExpr(src: string, ctx: FormulaContext): { value: unknown; error?: FormulaError } | undefined {
  return formulaLib()?.evaluate(src, ctx);
}

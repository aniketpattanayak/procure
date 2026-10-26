/**
 * FORMULA ENGINE PUBLIC API (Phase 2, frozen). Implemented in packages/formula (@procure/formula), used identically
 * by the browser renderer and the API. This file only declares the shapes; see docs/contracts/formula-language.md.
 */

export type FormulaType = 'number' | 'text' | 'date' | 'boolean' | 'list' | 'any' | 'null';

export interface FormulaError {
  code: 'SYNTAX' | 'UNKNOWN_FIELD' | 'UNKNOWN_FUNCTION' | 'ARITY' | 'TYPE' | 'CYCLE' | 'LIMIT' | 'AGGREGATE_REQUIRED' | 'RUNTIME';
  message: string;      // plain English, e.g. "Unknown field 'qtyy'. Did you mean 'qty'?"
  start?: number;       // character offsets into the source, for editor squiggles
  end?: number;
}

/** Describes the fields a formula may reference (built from a FormDefinition by the engine helper). */
export interface FormulaScope {
  /** Header-level fields: key -> type. Lookup fields additionally expose attributes via `lookupAttributes`. */
  fields: Record<string, FormulaType>;
  /** Grids: grid key -> column key -> type. Header formulas reach columns only through aggregates (SUM(lines.amount)). */
  grids: Record<string, Record<string, FormulaType>>;
  /** For lookup fields: attribute -> type, so `vendor.gstin` type-checks. Attributes: 'code', 'name', data keys. */
  lookupAttributes: Record<string, Record<string, FormulaType>>;
  /** Set when compiling a grid column formula: bare refs resolve to this grid's row first, then the header. */
  rowOf?: string;
}

export interface CompiledFormula {
  ok: boolean;
  errors: FormulaError[];
  resultType: FormulaType;
  /** Field keys this formula reads ('lines.amount', 'vendor.gstin', 'qty'). Used for dependency ordering. */
  deps: string[];
}

/**
 * Runtime values. Numbers are decimal strings in and out (e.g. "1250.5"); the engine computes with decimal.js.
 * Dates are 'YYYY-MM-DD'. Lookups resolve attributes through `lookups[fieldKey][attr]`.
 */
export interface FormulaContext {
  values: Record<string, unknown>;
  lookups?: Record<string, Record<string, unknown> | null>;
  /** Current grid row when evaluating a column formula. */
  row?: Record<string, unknown>;
  rowLookups?: Record<string, Record<string, unknown> | null>;
  /** 'YYYY-MM-DD' in the tenant's timezone; injected so server and browser agree. */
  today: string;
  /** Decimal places for currency rounding defaults. */
  defaultPrecision?: number;
}

export interface FormEvaluationResult {
  /** Values with every formula field (header and grid cells) filled in. */
  values: Record<string, unknown>;
  /** Per-field visibility/required/readOnly after evaluating the *When expressions. Grid columns: '<grid>.<col>'. */
  state: Record<string, { visible: boolean; required: boolean; readOnly: boolean }>;
  /**
   * Runtime problems (e.g. divide by zero); the formula result is null. Keys: '<field>' for header fields,
   * '<grid>.<rowId>.<col>' for a grid cell, '<grid>.<col>' for a compile error in a column, '<key>.visibleWhen' etc.
   */
  errors: Record<string, FormulaError>;
  /** Form-level validations (FormDefinition.validations) after evaluation; ok=false blocks save with `message`. */
  validations?: { key: string; message: string; ok: boolean; error?: FormulaError }[];
  /** Evaluated minDate/maxDate per date field ('YYYY-MM-DD' or null). */
  dateBounds?: Record<string, { min: string | null; max: string | null }>;
}

/*
 * Functions exported by @procure/formula (signatures are part of the contract):
 *   parse(src: string): { ast: unknown | null; errors: FormulaError[] }
 *   compile(src: string, scope: FormulaScope, expected?: FormulaType): CompiledFormula
 *   evaluate(src: string, ctx: FormulaContext): { value: unknown; error?: FormulaError }
 *   scopeFromDefinition(def: FormDefinition, lookupAttributes?: FormulaScope['lookupAttributes']): FormulaScope
 *   checkDefinition(def: FormDefinition, lookupAttributes?): FormDefinitionIssue[]   // syntax, types, unknown refs, cycles
 *   evaluateForm(def: FormDefinition, input: { values; lookups?; rowLookups?: Record<gridKey, Record<rowId, Record<field, attrs>>>; today; defaultPrecision? }): FormEvaluationResult
 *   FUNCTIONS: readonly { name: string; signature: string; description: string; example: string }[]   // for autocomplete
 */

'use client';
import type { DataField, FileMeta, FormDefinition, FormEvaluationResult, FormulaError, GridColumn, OptionRow } from '@procure/schema';
import { createContext, useContext } from 'react';
import type { ErrorMap } from './validation';

/** Where a control lives: the header, or one row of a grid. */
export interface FieldScope {
  grid?: string;
  rowIndex?: number;
  row?: Record<string, unknown>;
}

export interface RendererContextValue {
  formKey: string;
  def: FormDefinition;
  mode: 'edit' | 'view';
  idPrefix: string;
  today: string;
  currency: string;
  values: Record<string, unknown>;
  /** Values with formulas filled in (from evaluateForm). */
  computed: Record<string, unknown>;
  state: FormEvaluationResult['state'];
  evalErrors: Record<string, FormulaError>;
  errors: ErrorMap;
  readOnly: Set<string>;
  /** Header field change (handles cascade clears). `option` is passed for lookups so autofill can run. */
  setValue: (key: string, v: unknown, option?: OptionRow | null) => void;
  /** Grid cell change. */
  setCell: (grid: string, rowIndex: number, col: string, v: unknown, option?: OptionRow | null) => void;
  setRows: (grid: string, rows: Record<string, unknown>[]) => void;
  /** Blur: run inline validation for this path. */
  touch: (path: string) => void;
  /** Lookup option cache: id -> option (labels + attrs for formulas/autofill). */
  rememberOptions: (opts: OptionRow[]) => void;
  optionFor: (id: string) => OptionRow | undefined;
  labelFromRefs: (fieldPath: string, id: string) => string | undefined;
  /** Attributes a lookup must fetch (autofill sources + `lookup.attr` refs in expressions). */
  attrsFor: (lookupKey: string) => string[];
  files: Record<string, FileMeta>;
  rememberFile: (m: FileMeta) => void;
  fieldByKey: (key: string) => DataField | undefined;
  /** Optional extra test ids per grid key: row (0-based index -> id; set on the row's number cell) and add button wrapper. */
  gridTestIds?: Record<string, { row?: (index: number) => string; add?: string }>;
  columnByKey: (grid: string, key: string) => GridColumn | undefined;
}

export const RendererContext = createContext<RendererContextValue | null>(null);

export function useRenderer() {
  const c = useContext(RendererContext);
  if (!c) throw new Error('useRenderer must be used inside <FormRenderer>');
  return c;
}

/** DOM id for a field path (header `qty`, grid cell `lines-3-qty`). */
export function fieldDomId(prefix: string, path: string) {
  return `${prefix}-${path.replace(/\./g, '-')}`;
}

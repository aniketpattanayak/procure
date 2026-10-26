import { DataField, Field, FormDefinition, FormulaType, GridColumn, isLayoutType } from '@procure/schema';

/** A data-carrying field or a grid column (both validate the same way). */
export type ValueField = DataField | GridColumn;
export type LookupLike = Extract<ValueField, { type: 'lookup' | 'multilookup' }>;
export type FileLike = Extract<ValueField, { type: 'file' | 'image' | 'files' | 'signature' }>;
export type GridField = Extract<DataField, { type: 'grid' }>;

export const isDataField = (f: Field): f is DataField => !isLayoutType(f.type);
export const isLookup = (f: { type: string }): f is LookupLike => f.type === 'lookup' || f.type === 'multilookup';
export const isFileField = (f: { type: string }): f is FileLike => ['file', 'image', 'files', 'signature'].includes(f.type);
export const isGrid = (f: { type: string }): f is GridField => f.type === 'grid';
export const isMulti = (f: { type: string }) => ['multiselect', 'multilookup', 'files'].includes(f.type);
export const NUMERIC_TYPES = new Set(['number', 'decimal', 'currency', 'percentage']);

/** Data fields of a definition (excluding layout), optionally without removed ones. */
export function dataFields(def: FormDefinition, includeRemoved = false): DataField[] {
  return def.fields.filter(isDataField).filter(f => includeRemoved || !f.removed);
}

/** Every field key in the definition including grid columns as `<grid>.<col>` (and layout keys). */
export function allKeys(def: FormDefinition): string[] {
  const out: string[] = [];
  for (const f of def.fields) {
    out.push(f.key);
    if (isGrid(f)) for (const c of f.columns) out.push(`${f.key}.${c.key}`);
  }
  return out;
}

/** Formula type of a field's value (for formula scopes and lookup attributes). */
export function formulaTypeOf(f: { type: string; resultType?: string }): FormulaType {
  if (NUMERIC_TYPES.has(f.type)) return 'number';
  if (f.type === 'date') return 'date';
  if (f.type === 'checkbox' || f.type === 'toggle') return 'boolean';
  if (f.type === 'formula') return (f.resultType ?? 'number') as FormulaType;
  if (['multiselect', 'multilookup', 'files', 'grid', 'daterange'].includes(f.type)) return 'list';
  return 'text';
}

/** Attributes a lookup to this master exposes to formulas/autofill: code, name and every data field. */
export function masterAttributes(def: FormDefinition | null): Record<string, FormulaType> {
  const out: Record<string, FormulaType> = { code: 'text', name: 'text' };
  if (def) for (const f of dataFields(def)) if (!isGrid(f)) out[f.key] = formulaTypeOf(f);
  return out;
}

/** An empty value per the contract: absent, null, '' or []. */
export const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Stable deep equality for JSON values (used for "unchanged" checks on protected fields). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** A minimal valid definition for a new master: one section, no data fields yet. */
export function emptyMasterDefinition(): FormDefinition {
  return { version: 1, fields: [{ key: 'details', type: 'section', label: 'Details', columns: 2, collapsible: false, removed: false }], validations: [] };
}

/** Parses stored JSON (trusted: written by the engine) into a FormDefinition with defaults applied. */
export function parseStoredDefinition(raw: unknown): FormDefinition {
  const r = FormDefinition.safeParse(raw);
  if (r.success) return r.data;
  // Stored definitions were validated on publish; fall back to the raw object rather than failing a read.
  return raw as FormDefinition;
}

// ------------------------------------------------------------------ document forms (Phase 3, additive)

/** Grid key under which a document's line form is wrapped for formula scope and the record pipeline. */
export const DOC_LINES_KEY = 'lines';

/** 'header' / 'line' for the two forms of a document type (`<type>_header`, `<type>_line`, kind transaction). */
export function docFormPart(form: { key?: string; kind?: string } | null | undefined): 'header' | 'line' | null {
  if (!form?.key || form.kind !== 'transaction') return null;
  if (form.key.endsWith('_header')) return 'header';
  if (form.key.endsWith('_line')) return 'line';
  return null;
}

/** The sibling form key of a document form (`capex_header` <-> `capex_line`). */
export function docSiblingKey(key: string, part: 'header' | 'line'): string {
  return part === 'header' ? `${key.slice(0, -'_header'.length)}_line` : `${key.slice(0, -'_line'.length)}_header`;
}

export interface ComposedDocumentDefinition {
  /** Header fields followed by a virtual grid `lines` whose columns are the line form's data fields. */
  def: FormDefinition;
  /** Number of header fields (the grid, when present, sits at this index). */
  headerCount: number;
  /** Grid column index -> index of that field in the line form's `fields`. */
  lineIndex: number[];
}

/**
 * Wraps a document type's line form as the virtual grid `lines` inside its header form (documents.ts LINES_KEY), so
 * line formulas see header fields (row first, then header) and header formulas aggregate `SUM(lines.amount)`.
 * Layout items and nested grids of the line form are not columns. Header validations only.
 */
export function composeDocumentDefinition(header: FormDefinition, line: FormDefinition | null): ComposedDocumentDefinition {
  const fields = [...header.fields.filter(f => f.key !== DOC_LINES_KEY)];
  const headerCount = fields.length;
  const lineIndex: number[] = [];
  if (line) {
    const columns: Field[] = [];
    line.fields.forEach((f, i) => {
      if (!isDataField(f) || isGrid(f)) return;
      columns.push(f);
      lineIndex.push(i);
    });
    fields.push({
      key: DOC_LINES_KEY, type: 'grid', label: 'Lines', system: true, required: false, readOnly: false, hidden: false, width: 12,
      unique: false, removed: false, columns: columns as never, minRows: 0, maxRows: 1000,
    } as Field);
  }
  return { def: { version: header.version, fields, validations: header.validations ?? [] }, headerCount, lineIndex };
}

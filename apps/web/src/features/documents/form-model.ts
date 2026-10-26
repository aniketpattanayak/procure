/**
 * Header + lines as one renderable form. The line form becomes a virtual grid named `lines` inside the header form,
 * exactly how the server evaluates formulas (documents.ts LINES_KEY): line formulas resolve bare names to the line
 * first, header formulas aggregate with `lines.<field>` (e.g. total_amount = SUM(lines.amount)).
 */
import type { DataField, DocumentRow, Field, GridColumn, RenderableForm } from '@procure/schema';
import { LINES_KEY } from '@procure/schema';
import { isDataField } from '@/engines/form-renderer/formula';
import { initialValues, newRowId } from '@/engines/form-renderer/values';
import type { DocWriteBody } from './api';

type Row = Record<string, unknown>;
type GridField = Extract<DataField, { type: 'grid' }>;

const INTERNAL = new Set(['_row', '_lineId']);

export function lineColumns(line: RenderableForm | null | undefined): GridColumn[] {
  if (!line) return [];
  return line.definition.fields.filter((f): f is DataField => isDataField(f) && f.type !== 'grid' && !f.removed) as GridColumn[];
}

/** Header definition with the line form appended as the `lines` grid (unless the header already declares it). */
export function combineForms(header: RenderableForm, line: RenderableForm | null | undefined, opts: { label: string; hideLines?: boolean }): RenderableForm {
  const cols = lineColumns(line);
  const fields: Field[] = header.definition.fields.filter(f => !(f.key === LINES_KEY && f.type === 'grid'));
  if (cols.length) {
    const grid: GridField = {
      key: LINES_KEY, type: 'grid', label: opts.label, columns: cols, minRows: 0, maxRows: 1000,
      system: true, required: false, readOnly: false, hidden: !!opts.hideLines, width: 12, unique: false, removed: false,
    };
    fields.push(grid);
  }
  return {
    formKey: header.formKey,
    formVersionId: header.formVersionId,
    definition: { ...header.definition, fields },
    readOnlyFields: [...header.readOnlyFields, ...(line?.readOnlyFields ?? []).map(k => `${LINES_KEY}.${k}`)],
  };
}

/** DocumentRow -> renderer values (`lines` rows carry `_row` for React keys and `_lineId` for the update body). */
export function toFormValues(doc: Pick<DocumentRow, 'values' | 'lines'>): Row {
  return {
    ...doc.values,
    [LINES_KEY]: [...doc.lines].sort((a, b) => a.lineNo - b.lineNo).map(l => ({ ...l.values, _row: l.id, _lineId: l.id })),
  };
}

/** A fresh line with the line form's defaults (dates 'today' resolved). */
export function emptyLine(line?: RenderableForm | null, today?: string): Row {
  const base: Row = { _row: newRowId() };
  return line && today ? { ...initialValues(lineColumns(line), today, base) } : base;
}

/** Fresh header values with defaults, plus one empty line when the type has lines. */
export function newDocValues(header: RenderableForm, line: RenderableForm | null | undefined, today: string, extra: Row = {}): Row {
  const v = initialValues(header.definition.fields.filter(f => f.key !== LINES_KEY), today, extra);
  v[LINES_KEY] = line ? [emptyLine(line, today)] : [];
  return v;
}

/** Renderer values -> DocumentWrite. Formula outputs are left to the server (it recomputes them anyway). */
export function toWriteBody(values: Row, header: RenderableForm, line: RenderableForm | null | undefined): DocWriteBody {
  const headerFormulas = new Set(header.definition.fields.filter(f => f.type === 'formula').map(f => f.key));
  const lineFormulas = new Set(lineColumns(line).filter(c => c.type === 'formula').map(c => c.key));
  const head: Row = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === LINES_KEY || INTERNAL.has(k) || headerFormulas.has(k)) continue;
    head[k] = v;
  }
  const rows = Array.isArray(values[LINES_KEY]) ? (values[LINES_KEY] as Row[]) : [];
  return {
    values: head,
    lines: rows.map(r => {
      const v: Row = {};
      for (const [k, x] of Object.entries(r)) if (!INTERNAL.has(k) && !lineFormulas.has(k)) v[k] = x;
      return { ...(typeof r._lineId === 'string' ? { id: r._lineId } : {}), values: v };
    }),
  };
}

/** Header refs + every line's refs folded by field key, so lookups render labels in the grid (`lines.3.item` -> `item`). */
export function mergeRefs(doc: Pick<DocumentRow, 'refs' | 'lines'> | null | undefined): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!doc) return out;
  const add = (src: Record<string, Record<string, string>>) => {
    for (const [k, m] of Object.entries(src ?? {})) out[k] = { ...(out[k] ?? {}), ...m };
  };
  add(doc.refs);
  for (const l of doc.lines) add(l.refs);
  return out;
}

/** Server error paths -> renderer paths: `values.purpose` -> `purpose`, `lines.3.values.qty` -> `lines.3.qty`. */
export function normalizeErrorPaths(errors: { path: string; message: string }[]): { path: string; message: string }[] {
  return errors.map(e => ({
    ...e,
    path: e.path.replace(/^(data|body)\./, '').replace(/^values\./, '').replace(/^lines\.(\d+)\.values\./, 'lines.$1.'),
  }));
}

/** Label of a lookup value from refs (header or line). */
export function refLabel(refs: Record<string, Record<string, string>> | undefined, key: string, id: unknown): string | null {
  if (typeof id !== 'string') return null;
  return refs?.[key]?.[id] ?? null;
}

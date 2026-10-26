import type { Field, FormDefinition, GridColumn } from '@procure/schema';

export interface Selection { key: string; col?: string }

export interface BuilderState {
  def: FormDefinition;
  selected: Selection | null;
  past: FormDefinition[];
  future: FormDefinition[];
  /** Coalesces rapid edits of the same property (typing) into one undo step. */
  lastEdit: { tag: string; at: number } | null;
  /** Keys whose `key` was typed by hand (stop auto-deriving from the label). */
  keyTouched: Set<string>;
}

export type BuilderAction =
  | { type: 'load'; def: FormDefinition }
  | { type: 'change'; def: FormDefinition; tag?: string; select?: Selection | null }
  | { type: 'select'; sel: Selection | null }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'touchKey'; key: string };

const HISTORY = 100;
const COALESCE_MS = 700;

export function initBuilder(def: FormDefinition): BuilderState {
  return { def, selected: null, past: [], future: [], lastEdit: null, keyTouched: new Set() };
}

export function builderReducer(s: BuilderState, a: BuilderAction): BuilderState {
  switch (a.type) {
    case 'load':
      return { ...initBuilder(a.def), selected: s.selected && findField(a.def, s.selected) ? s.selected : null };
    case 'change': {
      const now = Date.now();
      const coalesce = a.tag && s.lastEdit?.tag === a.tag && now - s.lastEdit.at < COALESCE_MS;
      return {
        ...s,
        def: a.def,
        past: coalesce ? s.past : [...s.past, s.def].slice(-HISTORY),
        future: [],
        lastEdit: a.tag ? { tag: a.tag, at: now } : null,
        selected: a.select !== undefined ? a.select : s.selected,
      };
    }
    case 'select':
      return { ...s, selected: a.sel, lastEdit: null };
    case 'undo': {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      return { ...s, def: prev, past: s.past.slice(0, -1), future: [s.def, ...s.future], lastEdit: null, selected: s.selected && findField(prev, s.selected) ? s.selected : null };
    }
    case 'redo': {
      const next = s.future[0];
      if (!next) return s;
      return { ...s, def: next, past: [...s.past, s.def], future: s.future.slice(1), lastEdit: null, selected: s.selected && findField(next, s.selected) ? s.selected : null };
    }
    case 'touchKey':
      return { ...s, keyTouched: new Set(s.keyTouched).add(a.key) };
    default:
      return s;
  }
}

export function findField(def: FormDefinition, sel: Selection): Field | GridColumn | undefined {
  const f = def.fields.find(x => x.key === sel.key);
  if (!f || !sel.col) return f;
  return f.type === 'grid' ? f.columns.find(c => c.key === sel.col) : undefined;
}

/** Replace the selected field (or grid column) with `next`. */
export function replaceField(def: FormDefinition, sel: Selection, next: Field | GridColumn): FormDefinition {
  return {
    ...def,
    fields: def.fields.map(f => {
      if (f.key !== sel.key) return f;
      if (!sel.col) return next as Field;
      if (f.type !== 'grid') return f;
      return { ...f, columns: f.columns.map(c => (c.key === sel.col ? (next as GridColumn) : c)) };
    }),
  };
}

/** Rename a key everywhere it is referenced by structure (filterBy / autofill / listColumns are the caller's). */
export function renameKeyRefs(def: FormDefinition, from: string, to: string): FormDefinition {
  const fix = <T extends Record<string, unknown>>(f: T): T => {
    const out: Record<string, unknown> = { ...f };
    if (Array.isArray(out.filterBy)) out.filterBy = (out.filterBy as { field: string; targetField: string }[]).map(x => (x.field === from ? { ...x, field: to } : x));
    if (Array.isArray(out.autofill)) out.autofill = (out.autofill as { from: string; to: string }[]).map(x => (x.to === from ? { ...x, to } : x));
    if (Array.isArray(out.columns)) out.columns = (out.columns as Record<string, unknown>[]).map(fix);
    return out as T;
  };
  return { ...def, fields: def.fields.map(f => fix(f as unknown as Record<string, unknown>) as unknown as Field) };
}

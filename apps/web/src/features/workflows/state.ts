import type { WorkflowDefinition } from '@procure/schema';

/** Selection: a stage key, or null for the workflow-level settings. */
export interface DesignerState {
  def: WorkflowDefinition;
  selected: string | null;
  past: WorkflowDefinition[];
  future: WorkflowDefinition[];
  /** Coalesces rapid edits of the same property (typing) into one undo step. */
  lastEdit: { tag: string; at: number } | null;
  /** Stage keys typed by hand (stop deriving the key from the name). */
  keyTouched: Set<string>;
}

export type DesignerAction =
  | { type: 'load'; def: WorkflowDefinition }
  | { type: 'change'; def: WorkflowDefinition; tag?: string; select?: string | null }
  | { type: 'select'; key: string | null }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'touchKey'; key: string };

const HISTORY = 100;
const COALESCE_MS = 700;

export function initDesigner(def: WorkflowDefinition): DesignerState {
  return { def, selected: null, past: [], future: [], lastEdit: null, keyTouched: new Set() };
}

const keep = (def: WorkflowDefinition, key: string | null) => (key && def.stages.some(s => s.key === key) ? key : null);

export function designerReducer(s: DesignerState, a: DesignerAction): DesignerState {
  switch (a.type) {
    case 'load':
      return { ...initDesigner(a.def), selected: keep(a.def, s.selected) };
    case 'change': {
      const now = Date.now();
      const coalesce = a.tag && s.lastEdit?.tag === a.tag && now - s.lastEdit.at < COALESCE_MS;
      return {
        ...s,
        def: a.def,
        past: coalesce ? s.past : [...s.past, s.def].slice(-HISTORY),
        future: [],
        lastEdit: a.tag ? { tag: a.tag, at: now } : null,
        selected: a.select !== undefined ? a.select : keep(a.def, s.selected),
      };
    }
    case 'select':
      return { ...s, selected: a.key, lastEdit: null };
    case 'undo': {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      return { ...s, def: prev, past: s.past.slice(0, -1), future: [s.def, ...s.future], lastEdit: null, selected: keep(prev, s.selected) };
    }
    case 'redo': {
      const next = s.future[0];
      if (!next) return s;
      return { ...s, def: next, past: [...s.past, s.def], future: s.future.slice(1), lastEdit: null, selected: keep(next, s.selected) };
    }
    case 'touchKey':
      return { ...s, keyTouched: new Set(s.keyTouched).add(a.key) };
    default:
      return s;
  }
}

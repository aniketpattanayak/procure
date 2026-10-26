'use client';
import { autocompletion, closeBrackets, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { linter, type Diagnostic } from '@codemirror/lint';
import { EditorState, RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, placeholder as cmPlaceholder, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { FormDefinition, FormulaScope, FormulaType } from '@procure/schema';
import { cn } from '@procure/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/i18n';
import { compile, functions, scopeFromDefinition } from '@/engines/form-renderer/formula';
import { tokenize } from './tokens';
import { FormulaTestPanel } from './test-panel';

export interface FormulaEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** The draft being edited: fields for autocomplete and type checks. */
  definition: FormDefinition;
  /** Grid key when editing a column formula (bare refs resolve to the row first). */
  rowOf?: string;
  /** Expected result type: 'boolean' for conditions, the formula field's resultType otherwise. */
  expected?: FormulaType;
  /** The field being edited (a formula may not reference itself; shown in errors by the engine). */
  selfKey?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  /** Show the "Test with sample values" panel toggle. */
  testable?: boolean;
  'aria-describedby'?: string;
  /** Lookup attribute types by lookup key, when the builder knows the target masters' fields. */
  lookupAttributes?: FormulaScope['lookupAttributes'];
}

const theme = EditorView.theme({
  '&': {
    fontSize: '13px',
    border: '1px solid rgb(var(--c-border-strong))',
    borderRadius: 'var(--radius)',
    backgroundColor: 'rgb(var(--c-surface))',
    color: 'rgb(var(--c-fg))',
  },
  '&.cm-focused': { outline: '2px solid rgb(var(--c-ring))', outlineOffset: '0' },
  '.cm-content': { fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace", padding: '6px 0', minHeight: '1.5rem', caretColor: 'rgb(var(--c-fg))' },
  '.cm-line': { padding: '0 10px' },
  '.cm-scroller': { maxHeight: '10rem', overflow: 'auto' },
  '.cm-placeholder': { color: 'rgb(var(--c-fg-subtle))' },
  '.fx-fn': { color: 'rgb(var(--c-accent))', fontWeight: '600' },
  '.fx-ref': { color: 'rgb(var(--c-fg))', borderBottom: '1px dotted rgb(var(--c-fg-subtle))' },
  '.fx-num': { color: 'rgb(var(--c-success))' },
  '.fx-str': { color: 'rgb(var(--c-warning))' },
  '.fx-kw': { color: 'rgb(var(--c-accent))', fontStyle: 'italic' },
  '.fx-op': { color: 'rgb(var(--c-fg-muted))' },
  '.cm-tooltip': { border: '1px solid rgb(var(--c-border))', backgroundColor: 'rgb(var(--c-surface))', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-pop)' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgb(var(--c-accent-soft))', color: 'rgb(var(--c-fg))' },
  '.cm-completionDetail': { color: 'rgb(var(--c-fg-subtle))', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-completionInfo': { padding: '6px 8px', maxWidth: '18rem', fontSize: '12px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid rgb(var(--c-danger))' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy rgb(var(--c-danger))', textUnderlineOffset: '3px' },
});

const marks: Record<string, Decoration> = Object.fromEntries(['fn', 'ref', 'num', 'str', 'kw', 'op'].map(k => [k, Decoration.mark({ class: `fx-${k}` })]));

const highlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) { if (u.docChanged) this.decorations = this.build(u.view); }
  build(view: EditorView) {
    const b = new RangeSetBuilder<Decoration>();
    for (const tk of tokenize(view.state.doc.toString())) {
      const m = marks[tk.kind];
      if (m && tk.to > tk.from) b.add(tk.from, tk.to, m);
    }
    return b.finish();
  }
}, { decorations: v => v.decorations });

const typeLabel = (ty: FormulaType) => t(`fx.type.${ty}` as 'fx.type.number');

function completionSource(scopeRef: { current: FormulaScope }, rowOfRef: { current?: string }) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*\.?[A-Za-z0-9_]*/);
    if (!word && !ctx.explicit) return null;
    const scope = scopeRef.current;
    const text = word?.text ?? '';
    const from = word?.from ?? ctx.pos;
    const dot = text.indexOf('.');
    if (dot >= 0) {
      const head = text.slice(0, dot);
      const opts: Completion[] = [];
      if (scope.lookupAttributes[head]) {
        for (const [a, ty] of Object.entries(scope.lookupAttributes[head]!)) opts.push({ label: `${head}.${a}`, type: 'property', detail: typeLabel(ty) });
      }
      if (scope.grids[head]) {
        for (const [c, ty] of Object.entries(scope.grids[head]!)) opts.push({ label: `${head}.${c}`, type: 'property', detail: `${typeLabel(ty)} · ${t('fx.inAggregate')}` });
      }
      return opts.length ? { from, options: opts, validFor: /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]*$/ } : null;
    }
    const options: Completion[] = [];
    const rowOf = rowOfRef.current;
    if (rowOf && scope.grids[rowOf]) {
      for (const [k, ty] of Object.entries(scope.grids[rowOf]!)) options.push({ label: k, type: 'variable', detail: `${typeLabel(ty)} · ${t('fx.thisRow')}`, boost: 3 });
    }
    for (const [k, ty] of Object.entries(scope.fields)) options.push({ label: k, type: 'variable', detail: typeLabel(ty), boost: 2 });
    for (const g of Object.keys(scope.grids)) options.push({ label: g, type: 'namespace', detail: t('fx.grid'), boost: 1 });
    for (const fn of functions()) {
      options.push({
        label: fn.name,
        type: 'function',
        detail: fn.signature.replace(/^[A-Z_]+/, ''),
        info: () => {
          const el = document.createElement('div');
          const sig = document.createElement('p');
          sig.style.fontWeight = '600';
          sig.textContent = fn.signature;
          const d = document.createElement('p');
          d.textContent = fn.description;
          const ex = document.createElement('p');
          ex.style.color = 'rgb(var(--c-fg-subtle))';
          ex.style.marginTop = '4px';
          ex.textContent = fn.example;
          el.append(sig, d, ex);
          return el;
        },
        apply: (view, _c, f, to) => {
          view.dispatch({ changes: { from: f, to, insert: `${fn.name}()` }, selection: { anchor: f + fn.name.length + 1 } });
        },
      });
    }
    for (const kw of ['TRUE', 'FALSE', 'NULL', 'AND', 'OR', 'NOT']) options.push({ label: kw, type: 'keyword', boost: -1 });
    return { from, options, validFor: /^[A-Za-z_][A-Za-z0-9_]*$/ };
  };
}

/** CodeMirror 6 editor for the formula language: highlighting, field/function autocomplete, lint squiggles, test panel. */
export function FormulaEditor({
  value, onChange, definition, rowOf, expected, selfKey, id, label, placeholder, testId, testable = true, lookupAttributes, ...aria
}: FormulaEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  /** Docs emitted to the parent that have not come back as `value` yet (echoes can arrive late and out of step). */
  const emitted = useRef<string[]>([]);
  onChangeRef.current = onChange;
  const [testing, setTesting] = useState(false);

  const scope = useMemo<FormulaScope>(() => {
    const s = scopeFromDefinition(definition, lookupAttributes);
    return rowOf ? { ...s, rowOf } : s;
  }, [definition, rowOf, lookupAttributes]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const rowOfRef = useRef(rowOf);
  rowOfRef.current = rowOf;
  const expectedRef = useRef(expected);
  expectedRef.current = expected;

  const compiled = useMemo(() => (value.trim() ? compile(value, scope, expected) : null), [value, scope, expected]);

  useEffect(() => {
    if (!host.current) return;
    const lint = linter(view => {
      const src = view.state.doc.toString();
      if (!src.trim()) return [];
      const res = compile(src, scopeRef.current, expectedRef.current);
      return res.errors.map<Diagnostic>(e => {
        const from = Math.min(e.start ?? 0, src.length);
        const to = Math.min(Math.max(e.end ?? src.length, from + 1), src.length);
        return { from, to: Math.max(to, from), severity: 'error', message: e.message };
      });
    }, { delay: 250 });
    const exts: Extension[] = [
      theme,
      highlighter,
      closeBrackets(),
      autocompletion({ override: [completionSource(scopeRef, rowOfRef)], icons: false, activateOnTyping: true }),
      keymap.of(completionKeymap),
      lint,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        'aria-label': label ?? t('fx.editorLabel'),
        ...(id ? { id } : {}),
        ...(aria['aria-describedby'] ? { 'aria-describedby': aria['aria-describedby'] } : {}),
        ...(testId ? { 'data-testid': testId } : {}),
        spellcheck: 'false',
      }),
      EditorView.updateListener.of(u => {
        if (!u.docChanged) return;
        const doc = u.state.doc.toString();
        emitted.current.push(doc);
        if (emitted.current.length > 200) emitted.current.splice(0, 100);
        onChangeRef.current(doc);
      }),
    ];
    if (placeholder) exts.push(cmPlaceholder(placeholder));
    const view = new EditorView({ state: EditorState.create({ doc: value, extensions: exts }), parent: host.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, []);

  // External changes (undo/redo in the builder, switching fields) replace the document. Values that merely echo
  // what the editor emitted are ignored: React state lags behind fast typing, and replacing the doc with a stale
  // echo would drop keystrokes and move the cursor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const i = emitted.current.indexOf(value);
    if (i >= 0) { emitted.current.splice(0, i + 1); return; }
    emitted.current = [];
    if (view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  const errs = compiled?.errors ?? [];
  return (
    <div className="space-y-1.5" data-testid={testId ? `${testId}-wrap` : undefined}>
      <div ref={host} className="min-w-0" />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span aria-live="polite" className={cn(errs.length ? 'text-danger' : 'text-fg-subtle')} data-testid={testId ? `${testId}-status` : undefined}>
          {!value.trim() ? t('fx.hint') : errs.length ? errs[0]!.message : compiled ? t('fx.ok', { type: typeLabel(compiled.resultType) }) : ''}
        </span>
        {testable && value.trim() && (
          <button type="button" className="font-medium text-accent underline-offset-4 hover:underline" onClick={() => setTesting(v => !v)} aria-expanded={testing} data-testid={testId ? `${testId}-test-toggle` : undefined}>
            {testing ? t('fx.hideTest') : t('fx.test')}
          </button>
        )}
      </div>
      {testing && value.trim() && <FormulaTestPanel src={value} scope={scope} definition={definition} rowOf={rowOf} selfKey={selfKey} />}
    </div>
  );
}

export default FormulaEditor;

'use client';
/**
 * CodeMirror 6 editor for template HTML with Handlebars placeholders. Same CodeMirror build and theme approach as
 * the Phase 2 formula editor (engines/formula-editor): a token highlighter plugin instead of a language package,
 * autocomplete for `{{` placeholders from /config/templates/context-fields, and a small undo history.
 */
import { autocompletion, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorSelection, EditorState, RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
  placeholder as cmPlaceholder, ViewPlugin, type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { t } from '@/i18n';
import type { ContextField } from '@/features/notify/api';
import { HELPERS } from './placeholders';

export interface TemplateCodeEditorHandle {
  /** Insert at the cursor (replacing the selection) and focus the editor. `caret` = offset inside `text` to place the cursor. */
  insert: (text: string, caret?: number) => void;
  /** Whether the cursor sits inside a `{{#each lines}}` block. */
  insideLines: () => boolean;
  focus: () => void;
}

export interface TemplateCodeEditorProps {
  value: string;
  onChange: (v: string) => void;
  fields: ContextField[];
  label: string;
  testId?: string;
  placeholder?: string;
  /** Single-line-ish editor (subject, header/footer): no gutter, smaller height. */
  compact?: boolean;
  minHeight?: string;
  maxHeight?: string;
  id?: string;
}

const theme = EditorView.theme({
  '&': { fontSize: '12.5px', backgroundColor: 'rgb(var(--c-surface))', color: 'rgb(var(--c-fg))', height: '100%' },
  '&.cm-focused': { outline: '2px solid rgb(var(--c-ring))', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace", lineHeight: '1.6' },
  '.cm-content': { caretColor: 'rgb(var(--c-fg))', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'rgb(var(--c-subtle))', color: 'rgb(var(--c-fg-subtle))', border: 'none', borderRight: '1px solid rgb(var(--c-border))' },
  '.cm-activeLine': { backgroundColor: 'rgb(var(--c-accent-soft) / 0.45)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgb(var(--c-accent-soft))', color: 'rgb(var(--c-fg))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgb(var(--c-accent) / 0.22) !important' },
  '.cm-placeholder': { color: 'rgb(var(--c-fg-subtle))' },
  '.tp-tag': { color: 'rgb(var(--c-accent))' },
  '.tp-attr': { color: 'rgb(var(--c-fg-muted))' },
  '.tp-str': { color: 'rgb(var(--c-success))' },
  '.tp-cmt': { color: 'rgb(var(--c-fg-subtle))', fontStyle: 'italic' },
  '.tp-css': { color: 'rgb(var(--c-fg-muted))' },
  '.tp-hb': { color: 'rgb(var(--c-warning))', backgroundColor: 'rgb(var(--c-warning-soft) / 0.7)', borderRadius: '3px', fontWeight: '600' },
  '.tp-hb-block': { color: 'rgb(var(--c-accent-fg))', backgroundColor: 'rgb(var(--c-accent))', borderRadius: '3px', fontWeight: '600', padding: '0 1px' },
  '.cm-tooltip': { border: '1px solid rgb(var(--c-border))', backgroundColor: 'rgb(var(--c-surface))', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-pop)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-sans)', maxHeight: '16rem' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgb(var(--c-accent-soft))', color: 'rgb(var(--c-fg))' },
  '.cm-completionDetail': { color: 'rgb(var(--c-fg-subtle))', fontStyle: 'normal', marginLeft: '8px' },
});

const mk = (c: string) => Decoration.mark({ class: c });
const M = { tag: mk('tp-tag'), attr: mk('tp-attr'), str: mk('tp-str'), cmt: mk('tp-cmt'), hb: mk('tp-hb'), block: mk('tp-hb-block') };

/** One regex pass: Handlebars first (it can sit inside attributes), then HTML comments, tags, attributes, strings. */
const TOKEN = /(\{\{[#/^][^}]*\}\})|(\{\{\{?[^}]*\}?\}\})|(<!--[\s\S]*?-->)|(<\/?[A-Za-z][\w-]*)|(\s[A-Za-z_:][\w:.-]*)(?==)|("[^"\n]*"|'[^'\n]*')/g;

const highlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view: EditorView) {
    const b = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      TOKEN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TOKEN.exec(text))) {
        const start = from + m.index;
        const kind = m[1] ? M.block : m[2] ? M.hb : m[3] ? M.cmt : m[4] ? M.tag : m[5] ? M.attr : M.str;
        const s = m[5] ? start + 1 : start;
        if (start + m[0].length > s) b.add(s, start + m[0].length, kind);
      }
    }
    return b.finish();
  }
}, { decorations: v => v.decorations });

/** Undo/redo without @codemirror/commands: snapshots, typing within 600 ms coalesced into one step. */
function history(): Extension {
  const undo: { doc: string; sel: EditorSelection }[] = [];
  const redo: typeof undo = [];
  let last = 0;
  let applying = false;
  const restore = (view: EditorView, from: typeof undo, to: typeof undo) => {
    const snap = from.pop();
    if (!snap) return true;
    to.push({ doc: view.state.doc.toString(), sel: view.state.selection });
    applying = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: snap.doc }, selection: snap.sel.ranges.every(r => r.to <= snap.doc.length) ? snap.sel : undefined, scrollIntoView: true });
    applying = false;
    last = 0;
    return true;
  };
  return [
    EditorView.updateListener.of(u => {
      if (!u.docChanged || applying) return;
      const nowMs = Date.now();
      if (nowMs - last > 600) {
        undo.push({ doc: u.startState.doc.toString(), sel: u.startState.selection });
        if (undo.length > 200) undo.shift();
      }
      last = nowMs;
      redo.length = 0;
    }),
    keymap.of([
      { key: 'Mod-z', run: v => restore(v, undo, redo), preventDefault: true },
      { key: 'Mod-Shift-z', run: v => restore(v, redo, undo), preventDefault: true },
      { key: 'Mod-y', run: v => restore(v, redo, undo), preventDefault: true },
    ]),
  ];
}

/** Count `{{#each lines}}` openings minus `{{/each}}` closings before `pos`. */
export function insideLinesAt(doc: string, pos: number) {
  const before = doc.slice(0, pos);
  let depth = 0;
  let lines = 0;
  const stack: boolean[] = [];
  for (const m of before.matchAll(/\{\{#each\s+([\w.]+)\s*\}\}|\{\{\/each\}\}/g)) {
    if (m[0].startsWith('{{#')) { const isLines = m[1] === 'lines'; stack.push(isLines); depth++; if (isLines) lines++; }
    else if (stack.length) { const was = stack.pop(); depth--; if (was) lines--; }
  }
  return lines > 0 && depth >= 0;
}

function completions(fieldsRef: { current: ContextField[] }) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\{\{[#/]?[\w.@]*$/);
    if (!m) return null;
    const doc = ctx.state.doc.toString();
    const inLines = insideLinesAt(doc, ctx.pos);
    const from = m.from + 2;
    const typed = m.text.slice(2);
    const options: Completion[] = [];
    if (typed.startsWith('#') || typed === '') {
      options.push({ label: '#each lines', type: 'keyword', detail: t('tpl.ph.loop'), apply: '#each lines}}\n  \n{{/each', boost: 2 });
      options.push({ label: '#if', type: 'keyword', detail: t('tpl.ph.if'), apply: '#if }}{{/if', boost: 1 });
    }
    if (typed.startsWith('/')) options.push({ label: '/each', type: 'keyword' }, { label: '/if', type: 'keyword' });
    for (const f of fieldsRef.current) {
      if (f.path === 'lines') continue;
      const inLine = f.path.startsWith('lines.');
      const label = inLine && inLines ? f.path.slice(6) : f.path;
      options.push({ label, type: 'variable', detail: f.label, boost: inLine === inLines ? 1 : 0 });
    }
    for (const h of HELPERS) options.push({ label: h.name, type: 'function', detail: h.signature, apply: `${h.name} ` });
    return { from, options, validFor: /^[#/]?[\w.@]*$/ };
  };
}

export const TemplateCodeEditor = forwardRef<TemplateCodeEditorHandle, TemplateCodeEditorProps>(function TemplateCodeEditor(
  { value, onChange, fields, label, testId, placeholder, compact, minHeight, maxHeight, id }, ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const emitted = useRef<string[]>([]);

  useImperativeHandle(ref, () => ({
    insert: (text, caret) => {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + (caret ?? text.length) }, scrollIntoView: true });
      view.focus();
    },
    insideLines: () => {
      const view = viewRef.current;
      return view ? insideLinesAt(view.state.doc.toString(), view.state.selection.main.head) : false;
    },
    focus: () => viewRef.current?.focus(),
  }), []);

  useEffect(() => {
    if (!host.current) return;
    const exts: Extension[] = [
      theme,
      highlighter,
      drawSelection(),
      history(),
      autocompletion({ override: [completions(fieldsRef)], icons: false, activateOnTyping: true }),
      keymap.of(completionKeymap),
      EditorView.lineWrapping,
      EditorView.theme({ '.cm-scroller': { minHeight: minHeight ?? (compact ? '2.25rem' : '20rem'), maxHeight: maxHeight ?? 'none' } }),
      EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false', ...(testId ? { 'data-testid': testId } : {}), ...(id ? { id } : {}) }),
      EditorView.updateListener.of(u => {
        if (!u.docChanged) return;
        const doc = u.state.doc.toString();
        emitted.current.push(doc);
        if (emitted.current.length > 200) emitted.current.splice(0, 100);
        onChangeRef.current(doc);
      }),
    ];
    if (!compact) exts.push(lineNumbers(), highlightActiveLine(), highlightActiveLineGutter());
    if (placeholder) exts.push(cmPlaceholder(placeholder));
    const view = new EditorView({ state: EditorState.create({ doc: value, extensions: exts }), parent: host.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // The editor is created once; value changes sync below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const i = emitted.current.indexOf(value);
    if (i >= 0) { emitted.current.splice(0, i + 1); return; }
    emitted.current = [];
    if (view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="h-full min-w-0 overflow-hidden rounded border border-border-strong" data-testid={testId ? `${testId}-wrap` : undefined} />;
});

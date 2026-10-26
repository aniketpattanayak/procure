'use client';
import type {
  DataField, Field, FileMeta, FormEvaluationResult, GridColumn, OptionRow, RenderableForm,
} from '@procure/schema';
import { cn, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from '@procure/ui';
import { AlertTriangle, ChevronDown, Info, Lock } from 'lucide-react';
import dynamic from 'next/dynamic';
import {
  useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref,
} from 'react';
import { t } from '@/i18n';
import { useDebounced } from '@/lib/use-debounced';
import { RendererContext, fieldDomId, useRenderer, type RendererContextValue } from './context';
import { FieldControl, ReadValue, type ControlField } from './controls';
import { evaluateForm, isDataField, referencedLookupAttrs, todayIn } from './formula';
import { errorsFromProblem, validateForm, type ErrorMap } from './validation';
import { isEmpty } from './values';

const LineGrid = dynamic(() => import('./line-grid').then(m => m.LineGrid), {
  ssr: false,
  loading: () => <div className="space-y-1.5 rounded border border-border p-2" aria-hidden><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>,
});

export interface FormRendererHandle {
  /** Validate everything, show all errors, jump to the first invalid field. Returns the error map ({} = valid). */
  validate: () => ErrorMap;
  /** Latest evaluation (computed formula values, field states). */
  evaluation: () => FormEvaluationResult;
}

export interface FormRendererProps {
  form: RenderableForm;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  mode?: 'edit' | 'view';
  /** Server errors: an ErrorMap or problem `errors[]` (paths like `qty` or `lines.3.qty`). */
  errors?: ErrorMap | { path: string; message: string }[];
  /** Lookup labels from RecordRow.refs (fieldKey -> id -> label). */
  refs?: Record<string, Record<string, string>>;
  /** File metadata from RecordRow.files. */
  files?: Record<string, FileMeta>;
  /** Tenant currency for currency fields without their own (default INR). */
  currency?: string;
  /** Tenant timezone, so TODAY() matches the server. */
  timeZone?: string;
  /** Extra values formulas may read but the form doesn't render (e.g. a master record's code/name). */
  context?: Record<string, unknown>;
  onEvaluate?: (r: FormEvaluationResult) => void;
  idPrefix?: string;
  className?: string;
  /** Extra test ids for grid rows / the add button (e.g. documents use `line-row-<n>` and `line-add` for `lines`). */
  gridTestIds?: RendererContextValue['gridTestIds'];
  ref?: Ref<FormRendererHandle>;
}

// Literal class names so Tailwind generates them.
const SPAN: Record<number, string> = {
  1: 'md:col-span-1', 2: 'md:col-span-2', 3: 'md:col-span-3', 4: 'md:col-span-4', 5: 'md:col-span-5', 6: 'md:col-span-6',
  7: 'md:col-span-7', 8: 'md:col-span-8', 9: 'md:col-span-9', 10: 'md:col-span-10', 11: 'md:col-span-11', 12: 'md:col-span-12',
};

type TabEl = Extract<Field, { type: 'tab' }>;
type SectionEl = Extract<Field, { type: 'section' }>;
interface SectionGroup { el: SectionEl | null; items: Field[] }
interface TabGroup { el: TabEl | null; sections: SectionGroup[] }

/** Split the inline layout (tab / section markers in render order) into tabs > sections > fields. */
export function layoutOf(fields: Field[]): TabGroup[] {
  const tabs: TabGroup[] = [{ el: null, sections: [{ el: null, items: [] }] }];
  for (const f of fields) {
    if (f.removed) continue;
    if (f.type === 'tab') { tabs.push({ el: f, sections: [{ el: null, items: [] }] }); continue; }
    const tab = tabs[tabs.length - 1]!;
    if (f.type === 'section') { tab.sections.push({ el: f, items: [] }); continue; }
    tab.sections[tab.sections.length - 1]!.items.push(f);
  }
  for (const tab of tabs) tab.sections = tab.sections.filter(s => s.el || s.items.length);
  return tabs.filter(tb => tb.el || tb.sections.length);
}

/** Column span: an explicit width wins; the default (12) follows the section's column count. */
export function spanOf(f: Field, sectionColumns: number): number {
  if (f.type === 'grid' || f.type === 'divider' || f.type === 'help') return 12;
  const w = 'width' in f ? f.width : 12;
  if (w !== 12 || sectionColumns <= 1) return w;
  return Math.round(12 / sectionColumns);
}

function collectAutofillAttrs(fields: Field[]): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  const visit = (f: DataField | GridColumn) => {
    if (f.type !== 'lookup' && f.type !== 'multilookup') return;
    for (const a of f.autofill ?? []) (out[f.key] ??= new Set()).add(a.from);
  };
  for (const f of fields) {
    if (!isDataField(f)) continue;
    if (f.type === 'grid') f.columns.forEach(visit);
    else visit(f);
  }
  return out;
}

const attrsOf = (o: OptionRow | undefined): Record<string, unknown> | null =>
  o ? { code: o.code, name: o.name, ...(o.attrs ?? {}) } : null;

export function FormRenderer({
  form, value, onChange, mode = 'edit', errors: serverErrorsIn, refs, files: filesIn, currency = 'INR', timeZone, context, onEvaluate, idPrefix, className, gridTestIds, ref,
}: FormRendererProps) {
  const def = form.definition;
  const autoId = useId().replace(/:/g, '');
  const prefix = idPrefix ?? `fr${autoId}`;
  const today = useMemo(() => todayIn(timeZone), [timeZone]);

  const fieldMap = useMemo(() => {
    const m = new Map<string, DataField>();
    for (const f of def.fields) if (isDataField(f)) m.set(f.key, f);
    return m;
  }, [def]);
  const readOnly = useMemo(() => new Set(form.readOnlyFields), [form.readOnlyFields]);

  // ------------------------------------------------------------ value plumbing
  const valueRef = useRef(value);
  valueRef.current = value;
  const emit = useCallback((next: Record<string, unknown>) => { valueRef.current = next; onChange(next); }, [onChange]);

  // ------------------------------------------------------------ lookup option cache (labels + attrs)
  const optionCache = useRef(new Map<string, OptionRow>());
  const [optVer, setOptVer] = useState(0);
  const rememberOptions = useCallback((opts: OptionRow[]) => {
    let changed = false;
    for (const o of opts) {
      const prev = optionCache.current.get(o.id);
      const newAttr = o.attrs && Object.keys(o.attrs).some(k => !prev?.attrs || !(k in prev.attrs));
      if (!prev || newAttr || prev.label !== o.label) {
        optionCache.current.set(o.id, { ...prev, ...o, attrs: { ...(prev?.attrs ?? {}), ...(o.attrs ?? {}) } });
        changed = true;
      }
    }
    if (changed) setOptVer(v => v + 1);
  }, []);
  const optionFor = useCallback((id: string) => optionCache.current.get(id), []);

  const [files, setFiles] = useState<Record<string, FileMeta>>(() => ({ ...(filesIn ?? {}) }));
  useEffect(() => { if (filesIn) setFiles(f => ({ ...f, ...filesIn })); }, [filesIn]);
  const rememberFile = useCallback((m: FileMeta) => setFiles(f => (f[m.id] === m ? f : { ...f, [m.id]: m })), []);

  const attrsNeeded = useMemo(() => {
    const auto = collectAutofillAttrs(def.fields);
    const refd = referencedLookupAttrs(def);
    const out: Record<string, string[]> = {};
    for (const k of new Set([...Object.keys(auto), ...Object.keys(refd)])) {
      out[k] = [...new Set([...(auto[k] ?? []), ...(refd[k] ?? [])])].filter(a => a !== 'code' && a !== 'name').sort();
    }
    return out;
  }, [def]);
  const attrsFor = useCallback((k: string) => attrsNeeded[k] ?? EMPTY, [attrsNeeded]);

  // ------------------------------------------------------------ evaluation (debounced, memoised)
  const debounced = useDebounced(value, 90);
  const lookups = useMemo(() => {
    const out: Record<string, Record<string, unknown> | null> = {};
    for (const f of fieldMap.values()) if (f.type === 'lookup') {
      const v = debounced[f.key];
      out[f.key] = typeof v === 'string' ? attrsOf(optionCache.current.get(v)) : null;
    }
    return out;
  }, [fieldMap, debounced, optVer]);
  const rowLookups = useMemo(() => {
    const out: Record<string, Record<string, Record<string, Record<string, unknown> | null>>> = {};
    for (const f of fieldMap.values()) {
      if (f.type !== 'grid') continue;
      const lookCols = f.columns.filter(c => c.type === 'lookup');
      if (!lookCols.length) continue;
      const rows = Array.isArray(debounced[f.key]) ? (debounced[f.key] as Record<string, unknown>[]) : [];
      out[f.key] = Object.fromEntries(rows.map(r => [String(r._row), Object.fromEntries(lookCols.map(c => [c.key, typeof r[c.key] === 'string' ? attrsOf(optionCache.current.get(r[c.key] as string)) : null]))]));
    }
    return out;
  }, [fieldMap, debounced, optVer]);

  const evaluation = useMemo(
    () => evaluateForm(def, { values: context ? { ...context, ...debounced } : debounced, lookups, rowLookups, today, defaultPrecision: 2 }),
    [def, debounced, lookups, rowLookups, today, context],
  );
  useEffect(() => { onEvaluate?.(evaluation); }, [evaluation, onEvaluate]);

  // ------------------------------------------------------------ errors
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const liveErrors = useMemo(
    () => (mode === 'view' ? {} : validateForm(def, { values: value, evaluation, readOnlyFields: form.readOnlyFields, today, lookups })),
    [def, value, evaluation, form.readOnlyFields, today, lookups, mode],
  );
  const serverErrors = useMemo<ErrorMap>(
    () => (Array.isArray(serverErrorsIn) ? errorsFromProblem(serverErrorsIn) : (serverErrorsIn ?? {})),
    [serverErrorsIn],
  );
  const [serverCleared, setServerCleared] = useState<Set<string>>(() => new Set());
  useEffect(() => { setServerCleared(new Set()); }, [serverErrors]);

  const errors = useMemo(() => {
    const out: ErrorMap = {};
    for (const [p, m] of Object.entries(liveErrors)) {
      const root = p.split('.')[0]!;
      if (showAll || touched.has(p) || touched.has(root)) out[p] = m;
    }
    for (const [p, m] of Object.entries(serverErrors)) if (!serverCleared.has(p) && !out[p]) out[p] = m;
    return out;
  }, [liveErrors, serverErrors, serverCleared, showAll, touched]);

  const touch = useCallback((p: string) => setTouched(s => (s.has(p) ? s : new Set(s).add(p))), []);
  const clearServer = (p: string) => { if (serverErrors[p]) setServerCleared(s => new Set(s).add(p)); };

  // ------------------------------------------------------------ change handlers (cascade + autofill)
  const setValue = useCallback((key: string, v: unknown, option?: OptionRow | null) => {
    let next: Record<string, unknown> = { ...valueRef.current, [key]: v };
    if (v === null || v === undefined) delete next[key];
    next = cascadeHeader(def.fields, next, key);
    const f = fieldMap.get(key);
    if (option && f && f.type === 'lookup') next = autofill(f, option, next, null);
    clearServer(key);
    emit(next);
  }, [def, fieldMap, emit, serverErrors]);

  const setRows = useCallback((grid: string, rows: Record<string, unknown>[]) => {
    clearServer(grid);
    emit({ ...valueRef.current, [grid]: rows });
  }, [emit, serverErrors]);

  const setCell = useCallback((grid: string, rowIndex: number, col: string, v: unknown, option?: OptionRow | null) => {
    const g = fieldMap.get(grid);
    if (!g || g.type !== 'grid') return;
    const rows = [...((valueRef.current[grid] as Record<string, unknown>[] | undefined) ?? [])];
    let row: Record<string, unknown> = { ...rows[rowIndex], [col]: v };
    if (v === null || v === undefined) delete row[col];
    row = cascadeRow(g.columns, row, col);
    let header = valueRef.current;
    const c = g.columns.find(x => x.key === col);
    if (option && c && c.type === 'lookup') {
      const res = autofillRow(c, option, row, header, g.columns);
      row = res.row;
      header = res.header;
    }
    rows[rowIndex] = row;
    clearServer(`${grid}.${rowIndex}.${col}`);
    emit({ ...header, [grid]: rows });
  }, [fieldMap, emit, serverErrors]);

  // ------------------------------------------------------------ tabs + imperative handle
  const groups = useMemo(() => layoutOf(def.fields), [def]);
  const visibleTabs = groups.filter(g => !g.el || evaluation.state[g.el.key]?.visible !== false);
  const tabbed = visibleTabs.filter(g => g.el);
  const lead = visibleTabs.find(g => !g.el);
  const [tab, setTab] = useState<string | undefined>(undefined);
  const currentTab = tab && tabbed.some(g => g.el!.key === tab) ? tab : tabbed[0]?.el?.key;

  const pathInTab = useCallback((g: TabGroup, path: string) => {
    const root = path.split('.')[0]!;
    return g.sections.some(s => s.items.some(i => i.key === root));
  }, []);

  useImperativeHandle(ref, () => ({
    validate: () => {
      const all = validateForm(def, { values: valueRef.current, evaluation, readOnlyFields: form.readOnlyFields, today, lookups });
      setShowAll(true);
      const first = Object.keys(all).find(p => !p.startsWith('_form.'));
      if (first) {
        const owner = tabbed.find(g => pathInTab(g, first));
        if (owner?.el) setTab(owner.el.key);
        setTimeout(() => {
          const el = document.getElementById(fieldDomId(prefix, first));
          el?.focus();
          el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 30);
      }
      return all;
    },
    evaluation: () => evaluation,
  }), [def, evaluation, form.readOnlyFields, today, lookups, tabbed, pathInTab, prefix]);

  // ------------------------------------------------------------ context
  const labelFromRefs = useCallback((path: string, id: string) => {
    const leaf = path.split('.').pop()!;
    return refs?.[path]?.[id] ?? refs?.[leaf]?.[id];
  }, [refs]);

  const ctx: RendererContextValue = {
    formKey: form.formKey, def, mode, idPrefix: prefix, today, currency,
    values: value, computed: evaluation.values, state: evaluation.state, evalErrors: evaluation.errors, errors, readOnly,
    setValue, setCell, setRows, touch, rememberOptions, optionFor, labelFromRefs, attrsFor, files, rememberFile,
    gridTestIds,
    fieldByKey: k => fieldMap.get(k),
    columnByKey: (g, k) => { const gf = fieldMap.get(g); return gf?.type === 'grid' ? gf.columns.find(c => c.key === k) : undefined; },
  };

  const formErrors = Object.entries(errors).filter(([p]) => p.startsWith('_form.'));

  const renderTab = (g: TabGroup) => g.sections.map((s, i) => <SectionBlock key={s.el?.key ?? `s${i}`} group={s} />);

  return (
    <RendererContext.Provider value={ctx}>
      <div className={cn('space-y-6', className)} data-testid={`form-${form.formKey}`} data-mode={mode}>
        {formErrors.length > 0 && (
          <div role="alert" className="space-y-1 rounded border border-danger/30 bg-danger-soft px-3 py-2.5 text-danger" data-testid="form-rule-errors">
            {formErrors.map(([p, m]) => <p key={p} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{m}</p>)}
          </div>
        )}
        {lead && renderTab(lead)}
        {tabbed.length > 0 && (
          <Tabs value={currentTab} onValueChange={setTab}>
            <TabsList>
              {tabbed.map(g => {
                const count = Object.keys(errors).filter(p => pathInTab(g, p)).length;
                return (
                  <TabsTrigger key={g.el!.key} value={g.el!.key} data-testid={`tab-${g.el!.key}`}>
                    {g.el!.label}
                    {count > 0 && <span className="ml-1.5 inline-grid min-w-4 place-items-center rounded-full bg-danger px-1 text-xs text-white" aria-label={t('fr.tabErrors', { n: count })}>{count}</span>}
                  </TabsTrigger>
                );
              })}
            </TabsList>
            {tabbed.map(g => (
              <TabsContent key={g.el!.key} value={g.el!.key} forceMount className="space-y-6 data-[state=inactive]:hidden">{renderTab(g)}</TabsContent>
            ))}
          </Tabs>
        )}
      </div>
    </RendererContext.Provider>
  );
}

const EMPTY: string[] = [];

// ------------------------------------------------------------------------------------------- sections + fields

function SectionBlock({ group }: { group: SectionGroup }) {
  const ctx = useRenderer();
  const [collapsed, setCollapsed] = useState(false);
  const el = group.el;
  if (el && ctx.state[el.key]?.visible === false) return null;
  const columns = el?.columns ?? 1;
  const body = (
    <div className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-12">
      {group.items.map(f => <FieldBlock key={f.key} field={f} span={spanOf(f, columns)} />)}
    </div>
  );
  if (!el) return body;
  const headId = `${ctx.idPrefix}-sec-${el.key}`;
  return (
    <section aria-labelledby={el.label ? headId : undefined} data-testid={`section-${el.key}`} className="space-y-3">
      {el.label && (
        <div className="flex items-center gap-2 border-b border-border pb-1.5">
          {el.collapsible ? (
            <button type="button" onClick={() => setCollapsed(c => !c)} aria-expanded={!collapsed} className="flex items-center gap-1.5 rounded text-md font-semibold focus-visible:outline-2 focus-visible:outline-ring" id={headId}>
              <ChevronDown className={cn('size-4 text-fg-subtle transition-transform', collapsed && '-rotate-90')} aria-hidden />{el.label}
            </button>
          ) : (
            <h3 id={headId} className="text-md font-semibold">{el.label}</h3>
          )}
        </div>
      )}
      {!collapsed && body}
    </section>
  );
}

function FieldBlock({ field, span }: { field: Field; span: number }) {
  const ctx = useRenderer();
  if (field.type === 'divider') return <hr className="border-border md:col-span-12" />;
  if (field.type === 'help') {
    return (
      <div className={cn('flex gap-2 rounded border px-3 py-2.5 text-base md:col-span-12', field.tone === 'warning' ? 'border-warning/30 bg-warning-soft text-warning' : 'border-accent/20 bg-accent-soft text-fg')} data-testid={`field-${field.key}`}>
        {field.tone === 'warning' ? <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />}
        <p className="whitespace-pre-line">{field.text}</p>
      </div>
    );
  }
  if (!isDataField(field) || field.hidden || field.removed) return null;
  const st = ctx.state[field.key];
  if (st?.visible === false) return null;
  const required = field.type !== 'formula' && (field.required || !!st?.required);
  const ro = ctx.mode === 'view' || field.readOnly || !!st?.readOnly || ctx.readOnly.has(field.key) || field.type === 'formula';
  const id = fieldDomId(ctx.idPrefix, field.key);
  const error = ctx.errors[field.key];

  if (field.type === 'grid') {
    return (
      <div className={cn('min-w-0', SPAN[12])} data-testid={`field-${field.key}`} data-field-type="grid">
        <Shell id={id} label={field.label} required={required} readOnly={ro && ctx.mode !== 'view'} help={field.help} error={error} asGroup>
          {() => <LineGrid field={field} readOnly={ro} />}
        </Shell>
      </div>
    );
  }

  const value = field.type === 'formula' ? ctx.computed[field.key] : ctx.values[field.key];
  const inline = field.type === 'checkbox' || field.type === 'toggle';
  return (
    <div className={cn('min-w-0', SPAN[span])} data-testid={`field-${field.key}`} data-field-type={field.type}>
      <Shell id={id} label={field.label} required={required && ctx.mode !== 'view'} readOnly={ro && ctx.mode !== 'view' && field.type !== 'formula'} help={field.help} error={error} inline={inline && ctx.mode !== 'view'} computed={field.type === 'formula'}>
        {({ describedBy }) => ctx.mode === 'view' ? (
          <ReadValue field={field as ControlField} value={value} scope={{}} testId={`field-${field.key}-value`} />
        ) : (
          <FieldControl
            field={field as ControlField}
            value={value}
            onChange={(v, opt) => ctx.setValue(field.key, v, opt)}
            onBlur={() => ctx.touch(field.key)}
            scope={{}}
            id={id}
            describedBy={describedBy}
            invalid={!!error}
            required={required}
            readOnly={ro}
            testId={`field-${field.key}-input`}
          />
        )}
      </Shell>
    </div>
  );
}

function Shell({ id, label, required, readOnly, help, error, inline, computed, asGroup, children }: {
  id: string; label: string; required?: boolean; readOnly?: boolean; help?: string; error?: string; inline?: boolean; computed?: boolean; asGroup?: boolean;
  children: (a: { describedBy?: string }) => ReactNode;
}) {
  const helpId = help ? `${id}-help` : undefined;
  const errId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errId].filter(Boolean).join(' ') || undefined;
  const labelEl = (
    <label htmlFor={asGroup ? undefined : id} id={`${id}-label`} className={cn('flex items-center gap-1.5 text-sm font-medium text-fg', inline && 'font-normal text-base')}>
      <span>{label}</span>
      {required && <span className="text-danger" aria-hidden>*</span>}
      {required && <span className="sr-only">({t('fr.required')})</span>}
      {readOnly && <Lock className="size-3 text-fg-subtle" aria-label={t('fr.readOnly')} />}
      {computed && <span className="rounded-sm bg-accent-soft px-1 text-[0.7rem] font-semibold text-accent" title={t('fr.computedHint')}>ƒx</span>}
    </label>
  );
  return (
    <div className="flex flex-col gap-1.5" role={asGroup ? 'group' : undefined} aria-labelledby={asGroup ? `${id}-label` : undefined}>
      {inline ? <div className="flex min-h-9 items-center gap-3">{children({ describedBy })}{labelEl}</div> : <>{labelEl}{children({ describedBy })}</>}
      {help && !error && <p id={helpId} className="text-xs text-fg-subtle">{help}</p>}
      {error && <p id={errId} role="alert" className="text-xs font-medium text-danger" data-testid="field-error">{error}</p>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- cascade + autofill

type Row = Record<string, unknown>;

function lookupsFilteringBy(cols: (DataField | GridColumn)[], key: string) {
  return cols.filter(c => (c.type === 'lookup' || c.type === 'multilookup') && c.filterBy?.some(fb => fb.field === key));
}

/** Clear header lookups (and grid columns filtering on a header field) whose cascade parent changed. */
export function cascadeHeader(fields: Field[], values: Row, changed: string, seen = new Set<string>()): Row {
  if (seen.has(changed)) return values;
  seen.add(changed);
  const data = fields.filter(isDataField);
  let next = values;
  for (const dep of lookupsFilteringBy(data.filter(f => f.type !== 'grid'), changed)) {
    if (!isEmpty(next[dep.key])) { next = { ...next }; delete next[dep.key]; }
    next = cascadeHeader(fields, next, dep.key, seen);
  }
  for (const g of data) {
    if (g.type !== 'grid' || g.columns.some(c => c.key === changed)) continue;
    const deps = lookupsFilteringBy(g.columns, changed);
    if (!deps.length || !Array.isArray(next[g.key])) continue;
    const rows = (next[g.key] as Row[]).map(r => {
      let row = r;
      for (const d of deps) if (!isEmpty(row[d.key])) { row = { ...row }; delete row[d.key]; row = cascadeRow(g.columns, row, d.key); }
      return row;
    });
    next = { ...next, [g.key]: rows };
  }
  return next;
}

export function cascadeRow(columns: GridColumn[], row: Row, changed: string, seen = new Set<string>()): Row {
  if (seen.has(changed)) return row;
  seen.add(changed);
  let next = row;
  for (const dep of lookupsFilteringBy(columns, changed)) {
    if (!isEmpty(next[dep.key])) { next = { ...next }; delete next[dep.key]; }
    next = cascadeRow(columns, next, dep.key, seen);
  }
  return next;
}

function pick(option: OptionRow, from: string): unknown {
  if (from === 'code') return option.code;
  if (from === 'name') return option.name;
  const v = option.attrs?.[from];
  // Numbers travel as decimal strings.
  return typeof v === 'number' ? String(v) : v;
}

function autofill(f: Extract<DataField, { type: 'lookup' }>, option: OptionRow, values: Row, _row: Row | null): Row {
  let next = values;
  for (const a of f.autofill ?? []) {
    const v = pick(option, a.from);
    if (v === undefined) continue;
    if (a.overwrite === 'if_empty' && !isEmpty(next[a.to])) continue;
    next = { ...next, [a.to]: v };
  }
  return next;
}

function autofillRow(c: Extract<GridColumn, { type: 'lookup' }>, option: OptionRow, row: Row, header: Row, columns: GridColumn[]) {
  let r = row;
  let h = header;
  for (const a of c.autofill ?? []) {
    const v = pick(option, a.from);
    if (v === undefined) continue;
    if (columns.some(x => x.key === a.to)) {
      if (a.overwrite === 'if_empty' && !isEmpty(r[a.to])) continue;
      r = { ...r, [a.to]: v };
    } else {
      if (a.overwrite === 'if_empty' && !isEmpty(h[a.to])) continue;
      h = { ...h, [a.to]: v };
    }
  }
  return { row: r, header: h };
}

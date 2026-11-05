'use client';
import type { Field, FormDefinition, FormulaScope, GridColumn, MasterSummary } from '@procure/schema';
import { Button, cn, NativeSelect } from '@procure/ui';
import { ArrowDown, ArrowUp, Lock, MousePointerClick, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { t } from '@/i18n';
import { FormulaEditor } from '@/engines/formula-editor';
import { isDataField } from '@/engines/form-renderer/formula';
import { createDataField, GRID_COLUMN_TYPES, typeInfo, allKeys, uniqueKey, keyFromLabel } from './catalog';
import { LookupEditor } from './lookup-editor';
import { OptionsEditor } from './options-editor';
import { BoolProp, NumberProp, PropGroup, PropRow, SelectProp, TextProp } from './prop-controls';
import type { Selection } from './state';

type AnyField = Field | GridColumn;
type Patch = Record<string, unknown>;

export interface PropertiesProps {
  def: FormDefinition;
  /** Formula/condition scope when it is wider than `def` (a document type header also sees `lines`). */
  scopeDef?: FormDefinition;
  sel: Selection | null;
  field: AnyField | undefined;
  /** Merge `patch` into the selected field. `tag` coalesces typing into one undo step. */
  update: (patch: Patch, tag?: string) => void;
  /** Keys present in the published version (key and type become immutable). */
  publishedKeys: Set<string>;
  formKind: 'master' | 'system' | 'transaction';
  masters: MasterSummary[];
  targetForms: Map<string, FormDefinition | null>;
  lookupAttributes: FormulaScope['lookupAttributes'];
  issues: { path: string; message: string }[];
  onSelect: (s: Selection) => void;
  onGridChange: (gridKey: string, columns: GridColumn[], select?: Selection) => void;
}

function gridLabel(def: FormDefinition, key: string) {
  const g = def.fields.find(f => f.key === key);
  return g && 'label' in g ? g.label : key;
}

const WIDTHS = [
  { v: 12, k: 'fb.width.full' }, { v: 9, k: 'fb.width.threeQuarters' }, { v: 8, k: 'fb.width.twoThirds' }, { v: 6, k: 'fb.width.half' },
  { v: 4, k: 'fb.width.third' }, { v: 3, k: 'fb.width.quarter' },
] as const;

export function PropertiesPanel(p: PropertiesProps) {
  const { field, sel, update, def } = p;
  const scope = p.scopeDef ?? def;
  if (!field || !sel) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-fg-muted" data-testid="builder-properties-empty">
        <MousePointerClick className="size-6 text-fg-subtle" aria-hidden />
        <p className="text-sm">{t('fb.props.none')}</p>
      </div>
    );
  }
  const info = typeInfo(field.type);
  const Icon = info.icon;
  const system = 'system' in field && !!field.system;
  const published = p.publishedKeys.has(field.key);
  const rowOf = sel.col ? sel.key : undefined;
  const fieldIssues = p.issues;
  const issueFor = (prop: string) => fieldIssues.find(i => i.path.endsWith(`.${prop}`))?.message;
  const set = (k: string) => (v: unknown) => update({ [k]: v }, `${sel.key}.${sel.col ?? ''}.${k}`);

  return (
    <div className="flex h-full flex-col" data-testid="builder-properties">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Icon className="size-4 text-fg-subtle" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{'label' in field && field.label ? field.label : t(info.label)}</p>
          <p className="text-xs text-fg-subtle">{t(info.label)}{sel.col ? ` · ${t('fb.props.columnOf', { grid: gridLabel(def, sel.key) })}` : ''}</p>
        </div>
        {system && <span className="inline-flex items-center gap-1 rounded-full bg-neutral-soft px-2 py-0.5 text-xs text-fg-muted"><Lock className="size-3" aria-hidden />{t('fb.props.system')}</span>}
      </div>
      {fieldIssues.length > 0 && (
        <ul className="space-y-1 border-b border-border bg-danger-soft px-4 py-2 text-xs text-danger" role="alert">
          {fieldIssues.map((i, n) => <li key={n}>{i.message}</li>)}
        </ul>
      )}
      <div className="flex-1 overflow-y-auto">
        {field.type === 'divider' ? (
          <p className="p-4 text-sm text-fg-muted">{t('fb.props.dividerHint')}</p>
        ) : field.type === 'help' ? (
          <PropGroup title={t('fb.props.basics')}>
            <TextProp name="text" label={t('fb.props.helpText')} value={field.text} onChange={set('text')} multiline maxLength={2000} />
            <SelectProp name="tone" label={t('fb.props.tone')} value={field.tone} onChange={set('tone')} options={[{ value: 'info', label: t('fb.tone.info') }, { value: 'warning', label: t('fb.tone.warning') }]} />
          </PropGroup>
        ) : field.type === 'tab' || field.type === 'section' ? (
          <>
            <PropGroup title={t('fb.props.basics')}>
              <TextProp name="label" label={t('fb.props.label')} value={field.label} onChange={set('label')} maxLength={field.type === 'tab' ? 80 : 120} />
              {field.type === 'section' && (
                <>
                  <SelectProp name="sectionColumns" label={t('fb.props.sectionColumns')} value={String(field.columns) as '1'} onChange={v => update({ columns: Number(v) })}
                    options={[1, 2, 3, 4].map(n => ({ value: String(n) as '1', label: t('fb.props.nColumns', { n }) }))} hint={t('fb.props.sectionColumnsHint')} />
                  <BoolProp name="collapsible" label={t('fb.props.collapsible')} value={field.collapsible} onChange={set('collapsible')} />
                </>
              )}
            </PropGroup>
            <PropGroup title={t('fb.props.conditions')}>
              <ConditionEditor name="visibleWhen" label={t('fb.props.visibleWhen')} value={field.visibleWhen} onChange={set('visibleWhen')} def={scope} lookupAttributes={p.lookupAttributes} error={issueFor('visibleWhen')} />
            </PropGroup>
          </>
        ) : (
          <DataFieldProps {...p} field={field as Exclude<AnyField, { type: 'tab' | 'section' | 'divider' | 'help' }>} system={system} published={published} rowOf={rowOf} set={set} issueFor={issueFor} />
        )}
      </div>
    </div>
  );
}

function DataFieldProps({ field, sel, update, def, scopeDef, system, published, rowOf, set, issueFor, formKind, masters, targetForms, lookupAttributes, onSelect, onGridChange, publishedKeys }: PropertiesProps & {
  field: Exclude<AnyField, { type: 'tab' | 'section' | 'divider' | 'help' }>; system: boolean; published: boolean; rowOf?: string; set: (k: string) => (v: unknown) => void; issueFor: (p: string) => string | undefined;
}) {
  const keyLocked = system || published;
  const scope = scopeDef ?? def;
  const isText = ['text', 'textarea', 'regex'].includes(field.type);
  const isNumeric = ['number', 'decimal', 'currency', 'percentage'].includes(field.type);

  // Fields a cascade / autofill can point at.
  const headerData = def.fields.filter(isDataField).filter(f => !f.removed && f.type !== 'grid');
  const grid = rowOf ? def.fields.find(f => f.key === rowOf) : undefined;
  const siblings = grid?.type === 'grid' ? grid.columns.filter(c => !c.removed) : [];
  const cascadeFields = [...siblings, ...headerData]
    .filter(f => (f.type === 'lookup' || f.type === 'select' || f.type === 'radio') && f.key !== field.key)
    .map(f => ({ key: f.key, label: rowOf && siblings.includes(f as GridColumn) ? `${f.label} (${t('fx.thisRow')})` : f.label }));
  const autofillTargets = [...siblings, ...headerData]
    .filter(f => f.key !== field.key && f.type !== 'formula' && f.type !== 'lookup' && f.type !== 'multilookup')
    .map(f => ({ key: f.key, label: f.label }));

  return (
    <>
      <PropGroup title={t('fb.props.basics')} testId="prop-group-basics">
        <TextProp name="label" label={t('fb.props.label')} value={field.label} onChange={set('label')} maxLength={120} error={issueFor('label')} />
        <TextProp name="key" label={t('fb.props.key')} value={field.key} mono disabled={keyLocked}
          onChange={v => update({ key: v.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 63), __keyTouched: true }, `${sel!.key}.key`)}
          hint={keyLocked ? (system ? t('fb.props.keySystem') : t('fb.props.keyPublished')) : t('fb.props.keyHint')} error={issueFor('key')} />
        <TextProp name="help" label={t('fb.props.help')} value={field.help} onChange={v => set('help')(v || undefined)} multiline maxLength={500} />
        {!['checkbox', 'toggle', 'formula', 'radio', 'image', 'file', 'files', 'signature', 'grid'].includes(field.type) && (
          <TextProp name="placeholder" label={t('fb.props.placeholder')} value={field.placeholder} onChange={v => set('placeholder')(v || undefined)} maxLength={120} />
        )}
        {!rowOf && field.type !== 'grid' && (
          <PropRow label={t('fb.props.width')} hint={t('fb.props.widthHint')}>
            <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('fb.props.width')} data-testid="prop-width">
              {WIDTHS.map(w => (
                <button key={w.v} type="button" role="radio" aria-checked={field.width === w.v} onClick={() => update({ width: w.v })}
                  className={cn('rounded border px-2 py-0.5 text-xs', field.width === w.v ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-border hover:border-border-strong')}
                  data-testid={`prop-width-${w.v}`}>
                  {t(w.k)}
                </button>
              ))}
              {!WIDTHS.some(w => w.v === field.width) && <span className="rounded border border-accent bg-accent-soft px-2 py-0.5 text-xs text-accent">{field.width}/12</span>}
            </div>
          </PropRow>
        )}
      </PropGroup>

      {field.type !== 'formula' && (
        <PropGroup title={t('fb.props.rules')} testId="prop-group-rules">
          <BoolProp name="required" label={t('fb.props.required')} value={field.required} onChange={set('required')} />
          <BoolProp name="readOnly" label={t('fb.props.readOnly')} value={field.readOnly} onChange={set('readOnly')} hint={t('fb.props.readOnlyHint')} />
          <BoolProp name="hidden" label={t('fb.props.hidden')} value={field.hidden} onChange={set('hidden')} hint={t('fb.props.hiddenHint')} />
          {formKind === 'master' && !rowOf && (isText || isNumeric || ['email', 'phone', 'gstin', 'pan', 'url'].includes(field.type)) && (
            <BoolProp name="unique" label={t('fb.props.unique')} value={field.unique} onChange={set('unique')} hint={t('fb.props.uniqueHint')} />
          )}
        </PropGroup>
      )}

      {/* --------------------------- type-specific */}
      {isText ? (
        <PropGroup title={t('fb.props.typeSettings')}>
          {field.type === 'regex' && (
            <>
              <TextProp name="pattern" label={t('fb.props.pattern')} value={field.pattern} onChange={set('pattern')} mono error={issueFor('pattern')} hint={t('fb.props.patternHint')} />
              <TextProp name="patternMessage" label={t('fb.props.patternMessage')} value={field.patternMessage} onChange={set('patternMessage')} maxLength={200} />
            </>
          )}
          {(field.type === 'text' || field.type === 'textarea' || field.type === 'regex') && (
            <div className="grid grid-cols-2 gap-2">
              <NumberProp name="minLength" label={t('fb.props.minLength')} value={field.minLength} min={0} onChange={set('minLength')} />
              <NumberProp name="maxLength" label={t('fb.props.maxLength')} value={field.maxLength} min={1} max={10000} onChange={set('maxLength')} />
            </div>
          )}
          {field.type === 'textarea' && <NumberProp name="rows" label={t('fb.props.rows')} value={field.rows} min={2} max={20} onChange={v => set('rows')(v ?? 4)} />}
          {(field.type === 'text' || field.type === 'textarea' || field.type === 'regex') && <TextProp name="default" label={t('fb.props.default')} value={field.default} onChange={v => set('default')(v || undefined)} />}
        </PropGroup>
      ) : null}

      {isNumeric && 'min' in field && (
        <PropGroup title={t('fb.props.typeSettings')}>
          <div className="grid grid-cols-2 gap-2">
            <NumberProp name="min" label={t('fb.props.min')} value={field.min} onChange={set('min')} />
            <NumberProp name="max" label={t('fb.props.max')} value={field.max} onChange={set('max')} />
          </div>
          {issueFor('min') && <p className="text-xs text-danger">{issueFor('min')}</p>}
          {field.type !== 'number' && <NumberProp name="precision" label={t('fb.props.precision')} value={field.precision ?? 2} min={0} max={6} step={1} onChange={v => set('precision')(v)} />}
          {field.type === 'currency' && <TextProp name="currency" label={t('fb.props.currency')} value={field.currency} maxLength={3} placeholder="INR" hint={t('fb.props.currencyHint')} onChange={v => set('currency')(v ? v.toUpperCase() : undefined)} />}
          <NumberProp name="default" label={t('fb.props.default')} value={field.default} onChange={set('default')} />
        </PropGroup>
      )}

      {(field.type === 'email' || field.type === 'url' || field.type === 'phone' || field.type === 'time' || field.type === 'datetime') && (
        <PropGroup title={t('fb.props.typeSettings')}>
          {field.type === 'phone' && <TextProp name="defaultCountry" label={t('fb.props.defaultCountry')} value={field.defaultCountry} maxLength={2} onChange={v => set('defaultCountry')(v.toUpperCase() || 'IN')} />}
          <TextProp name="default" label={t('fb.props.default')} value={field.default} onChange={v => set('default')(v || undefined)} />
        </PropGroup>
      )}

      {field.type === 'date' && (
        <PropGroup title={t('fb.props.typeSettings')}>
          <TextProp name="default" label={t('fb.props.default')} value={field.default} placeholder="today" hint={t('fb.props.dateDefaultHint')} onChange={v => set('default')(v || undefined)} />
          <ConditionEditor name="minDate" label={t('fb.props.minDate')} value={field.minDate} onChange={set('minDate')} def={scope} rowOf={rowOf} expected="date" lookupAttributes={lookupAttributes} error={issueFor('minDate')} />
          <ConditionEditor name="maxDate" label={t('fb.props.maxDate')} value={field.maxDate} onChange={set('maxDate')} def={scope} rowOf={rowOf} expected="date" lookupAttributes={lookupAttributes} error={issueFor('maxDate')} />
        </PropGroup>
      )}

      {(field.type === 'select' || field.type === 'multiselect' || field.type === 'radio') && (
        <PropGroup title={t('fb.props.options')}>
          <OptionsEditor options={field.options} onChange={o => update({ options: o }, `${sel!.key}.${sel!.col ?? ''}.options`)} lockedValues={publishedKeys.has(field.key) ? new Set(field.options.map(o => o.value)) : new Set()} />
          {field.type !== 'multiselect' ? (
            <SelectProp name="default" label={t('fb.props.default')} value={field.default ?? ''} onChange={v => set('default')(v || undefined)}
              options={[{ value: '', label: t('fb.props.noDefault') }, ...field.options.map(o => ({ value: o.value, label: o.label }))]} />
          ) : (
            <NumberProp name="maxSelected" label={t('fb.props.maxSelected')} value={field.maxSelected} min={1} onChange={set('maxSelected')} />
          )}
        </PropGroup>
      )}

      {(field.type === 'checkbox' || field.type === 'toggle') && (
        <PropGroup title={t('fb.props.typeSettings')}>
          <BoolProp name="default" label={t('fb.props.defaultOn')} value={field.default} onChange={set('default')} />
        </PropGroup>
      )}

      {(field.type === 'lookup' || field.type === 'multilookup') && (
        <PropGroup title={t('fb.props.lookup')} testId="prop-group-lookup">
          <LookupEditor
            field={field}
            onChange={(patch, tag) => update(patch as Patch, tag)}
            masters={masters}
            target={field.source.kind === 'master' ? targetForms.get(field.source.masterKey) : null}
            cascadeFields={cascadeFields}
            autofillTargets={autofillTargets}
            locked={published}
          />
          {field.type === 'multilookup' && <NumberProp name="maxSelected" label={t('fb.props.maxSelected')} value={field.maxSelected} min={1} onChange={set('maxSelected')} />}
        </PropGroup>
      )}

      {field.type === 'formula' && (
        <PropGroup title={t('fb.props.formula')} testId="prop-group-formula">
          <PropRow label={t('fb.props.expr')} hint={rowOf ? t('fb.props.exprRowHint') : t('fb.props.exprHint')} error={issueFor('expr')}>
            <FormulaEditor value={field.expr} onChange={v => update({ expr: v }, `${sel!.key}.${sel!.col ?? ''}.expr`)} definition={scope} rowOf={rowOf} expected={field.resultType} selfKey={field.key}
              testId="prop-expr" label={t('fb.props.expr')} lookupAttributes={lookupAttributes} />
          </PropRow>
          <SelectProp name="resultType" label={t('fb.props.resultType')} value={field.resultType} onChange={set('resultType')}
            options={(['number', 'text', 'date', 'boolean'] as const).map(v => ({ value: v, label: t(`fx.type.${v}`) }))} />
          {field.resultType === 'number' && <NumberProp name="precision" label={t('fb.props.precision')} value={field.precision ?? 2} min={0} max={6} step={1} onChange={set('precision')} />}
        </PropGroup>
      )}

      {(field.type === 'file' || field.type === 'image' || field.type === 'files') && (
        <PropGroup title={t('fb.props.files')}>
          <AcceptEditor value={field.accept} image={field.type === 'image'} onChange={v => update({ accept: v })} />
          <div className="grid grid-cols-2 gap-2">
            <NumberProp name="maxSizeMb" label={t('fb.props.maxSizeMb')} value={field.maxSizeMb} min={0.1} max={100} onChange={v => set('maxSizeMb')(v ?? 10)} />
            {field.type === 'files' && <NumberProp name="maxFiles" label={t('fb.props.maxFiles')} value={field.maxFiles} min={1} max={50} step={1} onChange={v => set('maxFiles')(v ?? 10)} />}
          </div>
        </PropGroup>
      )}

      {field.type === 'grid' && (
        <PropGroup title={t('fb.props.columns')} testId="prop-gridColumns">
          <ColumnsEditor grid={field} def={def} publishedKeys={publishedKeys} onChange={(cols, s) => onGridChange(field.key, cols, s)} onSelect={onSelect} />
          <div className="grid grid-cols-2 gap-2">
            <NumberProp name="minRows" label={t('fb.props.minRows')} value={field.minRows} min={0} step={1} onChange={v => set('minRows')(v ?? 0)} />
            <NumberProp name="maxRows" label={t('fb.props.maxRows')} value={field.maxRows} min={1} max={5000} step={1} onChange={v => set('maxRows')(v ?? 1000)} />
          </div>
        </PropGroup>
      )}

      <PropGroup title={t('fb.props.conditions')} defaultOpen={!!(field.visibleWhen || field.requiredWhen || field.readOnlyWhen)} testId="prop-group-conditions">
        <ConditionEditor name="visibleWhen" label={t('fb.props.visibleWhen')} value={field.visibleWhen} onChange={set('visibleWhen')} def={scope} rowOf={rowOf} lookupAttributes={lookupAttributes} error={issueFor('visibleWhen')} />
        {field.type !== 'formula' && (
          <>
            <ConditionEditor name="requiredWhen" label={t('fb.props.requiredWhen')} value={field.requiredWhen} onChange={set('requiredWhen')} def={scope} rowOf={rowOf} lookupAttributes={lookupAttributes} error={issueFor('requiredWhen')} />
            <ConditionEditor name="readOnlyWhen" label={t('fb.props.readOnlyWhen')} value={field.readOnlyWhen} onChange={set('readOnlyWhen')} def={scope} rowOf={rowOf} lookupAttributes={lookupAttributes} error={issueFor('readOnlyWhen')} />
          </>
        )}
      </PropGroup>
    </>
  );
}

function ConditionEditor({ name, label, value, onChange, def, rowOf, expected = 'boolean', lookupAttributes, error }: {
  name: string; label: string; value: string | undefined; onChange: (v: string | undefined) => void; def: FormDefinition; rowOf?: string; expected?: 'boolean' | 'date';
  lookupAttributes: FormulaScope['lookupAttributes']; error?: string;
}) {
  const [open, setOpen] = useState(!!value);
  if (!open && !value) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">{label}</span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid={`prop-${name}-add`}><Plus aria-hidden />{t('fb.props.addCondition')}</Button>
      </div>
    );
  }
  return (
    <PropRow label={label} error={error} hint={expected === 'boolean' ? t('fb.props.conditionHint') : t('fb.props.dateExprHint')}>
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <FormulaEditor value={value ?? ''} onChange={v => onChange(v.trim() ? v : undefined)} definition={def} rowOf={rowOf} expected={expected} testId={`prop-${name}`} label={label}
            placeholder={expected === 'boolean' ? "priority = 'Urgent'" : 'TODAY()'} lookupAttributes={lookupAttributes} />
        </div>
        <Button size="icon-sm" variant="ghost" className="size-8" onClick={() => { onChange(undefined); setOpen(false); }} aria-label={t('fb.props.removeCondition', { label })}><Trash2 /></Button>
      </div>
    </PropRow>
  );
}

const ACCEPT_PRESETS: { label: string; values: string[] }[] = [
  { label: 'PNG', values: ['image/png'] }, { label: 'JPG', values: ['image/jpeg'] }, { label: 'WEBP', values: ['image/webp'] }, { label: 'GIF', values: ['image/gif'] },
  { label: 'PDF', values: ['application/pdf'] }, { label: 'XLSX', values: ['.xlsx'] }, { label: 'CSV', values: ['.csv', 'text/csv'] }, { label: 'DOCX', values: ['.docx'] }, { label: 'TXT', values: ['text/plain'] },
];

function AcceptEditor({ value, onChange, image }: { value: string[]; onChange: (v: string[]) => void; image: boolean }) {
  const presets = image ? ACCEPT_PRESETS.slice(0, 4) : ACCEPT_PRESETS;
  return (
    <PropRow label={t('fb.props.accept')} hint={value.length ? undefined : t('fb.props.acceptAny')}>
      <div className="flex flex-wrap gap-1.5" data-testid="prop-accept">
        {presets.map(p => {
          const on = p.values.every(v => value.includes(v));
          return (
            <label key={p.label} className={cn('inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-xs', on ? 'border-accent bg-accent-soft text-accent' : 'border-border')}>
              <input type="checkbox" className="sr-only" checked={on} onChange={e => onChange(e.target.checked ? [...new Set([...value, ...p.values])] : value.filter(v => !p.values.includes(v)))} />
              {p.label}
            </label>
          );
        })}
      </div>
    </PropRow>
  );
}

function ColumnsEditor({ grid, def, publishedKeys, onChange, onSelect }: {
  grid: Extract<Field, { type: 'grid' }>; def: FormDefinition; publishedKeys: Set<string>; onChange: (cols: GridColumn[], s?: Selection) => void; onSelect: (s: Selection) => void;
}) {
  const [type, setType] = useState<string>('text');
  const cols = grid.columns;
  const move = (i: number, d: -1 | 1) => { const n = [...cols]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x!); onChange(n); };
  function add() {
    const label = t(typeInfo(type as GridColumn['type']).label);
    const key = uniqueKey(keyFromLabel(label), allKeys(def));
    const col = createDataField(type as GridColumn['type'], label, key);
    onChange([...cols, col], { key: grid.key, col: key });
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {cols.filter(c => !c.removed).map(c => {
          const i = cols.indexOf(c);
          const Icon = typeInfo(c.type).icon;
          const locked = c.system || publishedKeys.has(c.key);
          return (
            <li key={c.key} className="flex items-center gap-1 rounded border border-border px-1.5 py-1">
              <Icon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <button type="button" className="min-w-0 flex-1 truncate text-left text-sm hover:text-accent" onClick={() => onSelect({ key: grid.key, col: c.key })} data-testid={`prop-column-${c.key}`}>
                {c.label} <code className="text-xs text-fg-subtle">{c.key}</code>
              </button>
              <Button variant="ghost" size="icon-sm" className="size-6" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('fb.opt.up')}><ArrowUp /></Button>
              <Button variant="ghost" size="icon-sm" className="size-6" disabled={i === cols.length - 1} onClick={() => move(i, 1)} aria-label={t('fb.opt.down')}><ArrowDown /></Button>
              <Button variant="ghost" size="icon-sm" className="size-6 hover:text-danger" disabled={!!c.system || cols.filter(x => !x.removed).length <= 1}
                onClick={() => onChange(locked ? cols.map(x => (x.key === c.key ? { ...x, removed: true } : x)) : cols.filter(x => x.key !== c.key))}
                aria-label={t('fb.canvas.delete', { label: c.label })}><Trash2 /></Button>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-1.5">
        <NativeSelect className="h-8 flex-1 text-sm" value={type} onChange={e => setType(e.target.value)} aria-label={t('fb.props.columnType')} data-testid="prop-column-type">
          {GRID_COLUMN_TYPES.map(ty => <option key={ty} value={ty}>{t(typeInfo(ty).label)}</option>)}
        </NativeSelect>
        <Button size="sm" variant="secondary" onClick={add} data-testid="prop-column-add"><Plus aria-hidden />{t('fb.props.addColumn')}</Button>
      </div>
    </div>
  );
}

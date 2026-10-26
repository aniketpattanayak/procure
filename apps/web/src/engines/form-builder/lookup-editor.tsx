'use client';
import type { FormDefinition, GridColumn, MasterSummary } from '@procure/schema';
import { Button, NativeSelect } from '@procure/ui';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import { t } from '@/i18n';
import { isDataField } from '@/engines/form-renderer/formula';
import { PropRow, SelectProp } from './prop-controls';

type LookupF = Extract<GridColumn, { type: 'lookup' | 'multilookup' }>;
interface Opt { key: string; label: string; type?: string }

/** Target master fields usable for display / filter / autofill: code, name + data fields of its published form. */
export function targetFieldOptions(target: FormDefinition | null | undefined): Opt[] {
  const out: Opt[] = [{ key: 'code', label: t('fb.lookup.code') }, { key: 'name', label: t('fb.lookup.name') }];
  for (const f of target?.fields ?? []) {
    if (!isDataField(f) || f.removed || f.type === 'grid' || f.key === 'code' || f.key === 'name') continue;
    out.push({ key: f.key, label: f.label, type: f.type });
  }
  return out;
}

export function LookupEditor({ field, onChange, masters, target, cascadeFields, autofillTargets, locked }: {
  field: LookupF;
  onChange: (patch: Partial<LookupF>, tag?: string) => void;
  masters: MasterSummary[];
  target: FormDefinition | null | undefined;
  /** Lookups on this form a cascade can depend on (header, or sibling columns + header for grid columns). */
  cascadeFields: Opt[];
  /** Fields autofill may write to. */
  autofillTargets: Opt[];
  locked: boolean;
}) {
  const src = field.source;
  const tf = targetFieldOptions(src.kind === 'master' ? target : null);
  const cascadeTargets = tf.filter(o => o.type === 'lookup' || o.type === 'select' || o.type === 'radio' || o.key === 'code');
  const display = field.display ?? ['code', 'name'];

  return (
    <div className="space-y-3">
      <SelectProp
        name="source-kind"
        label={t('fb.lookup.source')}
        value={src.kind}
        disabled={locked}
        onChange={k => onChange({ source: k === 'master' ? { kind: 'master', masterKey: masters[0]?.key ?? 'item' } : k === 'location' ? { kind: 'location', activeOnly: true, withinScope: true } : { kind: 'user', activeOnly: true }, filterBy: [], autofill: [], display: ['code', 'name'] })}
        options={[{ value: 'master', label: t('fb.source.master') }, { value: 'location', label: t('fb.source.location') }, { value: 'user', label: t('fb.source.user') }]}
      />
      {src.kind === 'master' && (
        <SelectProp
          name="source-master"
          label={t('fb.lookup.master')}
          value={src.masterKey}
          disabled={locked}
          hint={locked ? t('fb.lookup.lockedHint') : undefined}
          onChange={k => onChange({ source: { kind: 'master', masterKey: k }, filterBy: [], autofill: [], display: ['code', 'name'] })}
          options={[
            ...masters.filter(m => m.isActive || m.key === src.masterKey).map(m => ({ value: m.key, label: m.name })),
            ...(masters.some(m => m.key === src.masterKey) ? [] : [{ value: src.masterKey, label: src.masterKey }]),
          ]}
        />
      )}

      {src.kind === 'master' && (
        <PropRow label={t('fb.lookup.display')} hint={t('fb.lookup.displayHint')}>
          <div className="flex flex-wrap gap-1.5" data-testid="prop-display">
            {tf.map(o => {
              const on = display.includes(o.key);
              return (
                <label key={o.key} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs">
                  <input type="checkbox" className="accent-[rgb(var(--c-accent))]" checked={on} disabled={!on && display.length >= 4}
                    onChange={e => onChange({ display: e.target.checked ? [...display, o.key] : display.filter(d => d !== o.key).length ? display.filter(d => d !== o.key) : display })} />
                  {o.label}
                </label>
              );
            })}
          </div>
        </PropRow>
      )}

      {src.kind === 'master' && (
        <PropRow label={t('fb.lookup.filterBy')} hint={t('fb.lookup.filterByHint')}>
          <div className="space-y-1.5" data-testid="prop-filterBy">
            {field.filterBy.map((fb, i) => (
              <div key={i} className="flex items-center gap-1">
                <NativeSelect className="h-7 flex-1 text-xs" value={fb.field} aria-label={t('fb.lookup.parentField')}
                  onChange={e => onChange({ filterBy: field.filterBy.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })} data-testid={`prop-filterBy-field-${i}`}>
                  {!cascadeFields.some(o => o.key === fb.field) && <option value={fb.field}>{fb.field}</option>}
                  {cascadeFields.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                </NativeSelect>
                <ArrowRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                <NativeSelect className="h-7 flex-1 text-xs" value={fb.targetField} aria-label={t('fb.lookup.targetField')}
                  onChange={e => onChange({ filterBy: field.filterBy.map((x, j) => (j === i ? { ...x, targetField: e.target.value } : x)) })} data-testid={`prop-filterBy-target-${i}`}>
                  {!cascadeTargets.some(o => o.key === fb.targetField) && <option value={fb.targetField}>{fb.targetField}</option>}
                  {cascadeTargets.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                </NativeSelect>
                <Button variant="ghost" size="icon-sm" className="size-7" onClick={() => onChange({ filterBy: field.filterBy.filter((_, j) => j !== i) })} aria-label={t('fb.lookup.removeFilter')}><Trash2 /></Button>
              </div>
            ))}
            {field.filterBy.length > 0 && <p className="text-xs text-fg-subtle">{t('fb.lookup.filterExplain')}</p>}
            <Button size="sm" variant="ghost" disabled={field.filterBy.length >= 5 || !cascadeFields.length}
              onClick={() => onChange({ filterBy: [...field.filterBy, { field: cascadeFields[0]?.key ?? '', targetField: cascadeTargets.find(o => o.key === cascadeFields[0]?.key)?.key ?? cascadeTargets.find(o => o.type === 'lookup')?.key ?? 'code' }] })}
              data-testid="prop-filterBy-add">
              <Plus aria-hidden />{t('fb.lookup.addFilter')}
            </Button>
            {!cascadeFields.length && <p className="text-xs text-fg-subtle">{t('fb.lookup.noParents')}</p>}
          </div>
        </PropRow>
      )}

      <PropRow label={t('fb.lookup.autofill')} hint={t('fb.lookup.autofillHint')}>
        <div className="space-y-1.5" data-testid="prop-autofill">
          {field.autofill.map((a, i) => (
            <div key={i} className="space-y-1 rounded border border-border p-1.5">
              <div className="flex items-center gap-1">
                <NativeSelect className="h-7 flex-1 text-xs" value={a.from} aria-label={t('fb.lookup.copyFrom')}
                  onChange={e => onChange({ autofill: field.autofill.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} data-testid={`prop-autofill-from-${i}`}>
                  {!tf.some(o => o.key === a.from) && <option value={a.from}>{a.from}</option>}
                  {tf.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                </NativeSelect>
                <ArrowRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
                <NativeSelect className="h-7 flex-1 text-xs" value={a.to} aria-label={t('fb.lookup.copyTo')}
                  onChange={e => onChange({ autofill: field.autofill.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} data-testid={`prop-autofill-to-${i}`}>
                  {!autofillTargets.some(o => o.key === a.to) && <option value={a.to}>{a.to}</option>}
                  {autofillTargets.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                </NativeSelect>
                <Button variant="ghost" size="icon-sm" className="size-7" onClick={() => onChange({ autofill: field.autofill.filter((_, j) => j !== i) })} aria-label={t('fb.lookup.removeAutofill')}><Trash2 /></Button>
              </div>
              <NativeSelect className="h-7 text-xs" value={a.overwrite} aria-label={t('fb.lookup.overwrite')}
                onChange={e => onChange({ autofill: field.autofill.map((x, j) => (j === i ? { ...x, overwrite: e.target.value as 'always' | 'if_empty' } : x)) })}>
                <option value="always">{t('fb.lookup.overwriteAlways')}</option>
                <option value="if_empty">{t('fb.lookup.overwriteIfEmpty')}</option>
              </NativeSelect>
            </div>
          ))}
          <Button size="sm" variant="ghost" disabled={field.autofill.length >= 20 || !autofillTargets.length}
            onClick={() => onChange({ autofill: [...field.autofill, { from: tf[2]?.key ?? 'name', to: autofillTargets[0]!.key, overwrite: 'always' }] })} data-testid="prop-autofill-add">
            <Plus aria-hidden />{t('fb.lookup.addAutofill')}
          </Button>
        </div>
      </PropRow>
    </div>
  );
}

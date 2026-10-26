'use client';
import type { MasterSettings } from '@procure/schema';
import { Checkbox, FormField, Input, Label, NativeSelect, Switch } from '@procure/ui';
import { useId } from 'react';
import { t } from '@/i18n';

export type SettingsShape = MasterSettings;

/** Settings shared by the "New master" wizard and the settings dialog. */
export function MasterSettingsFields({ value, onChange, listFields }: { value: SettingsShape; onChange: (v: SettingsShape) => void; listFields?: { key: string; label: string }[] }) {
  const id = useId();
  const set = <K extends keyof SettingsShape>(k: K, v: SettingsShape[K]) => onChange({ ...value, [k]: v });
  const auto = value.codePattern !== null;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 rounded border border-border p-3">
        <div>
          <Label htmlFor={`${id}-auto`}>{t('masters.autoCodeLabel')}</Label>
          <p className="text-sm text-fg-muted">{t('masters.autoCodeHint')}</p>
        </div>
        <Switch id={`${id}-auto`} checked={auto} onCheckedChange={c => set('codePattern', c ? (value.codePattern ?? 'M{SEQ:5}') : null)} data-testid="master-auto-code" />
      </div>
      {auto && (
        <FormField label={t('masters.codePattern')} hint={t('masters.codePatternHint')}>
          <Input value={value.codePattern ?? ''} onChange={e => set('codePattern', e.target.value)} maxLength={40} className="font-mono" data-testid="master-code-pattern" />
        </FormField>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('masters.codeLabelLabel')}>
          <Input value={value.codeLabel} onChange={e => set('codeLabel', e.target.value)} maxLength={40} data-testid="master-code-label" />
        </FormField>
        <FormField label={t('masters.nameLabelLabel')}>
          <Input value={value.nameLabel} onChange={e => set('nameLabel', e.target.value)} maxLength={40} data-testid="master-name-label" />
        </FormField>
      </div>
      <FormField label={t('masters.defaultSort')}>
        <NativeSelect value={value.defaultSort} onChange={e => set('defaultSort', e.target.value as SettingsShape['defaultSort'])} data-testid="master-default-sort">
          <option value="name">{t('masters.sort.name')}</option>
          <option value="code">{t('masters.sort.code')}</option>
          <option value="created_at">{t('masters.sort.created')}</option>
        </NativeSelect>
      </FormField>
      <div className="flex items-start gap-2.5">
        <Checkbox id={`${id}-menu`} checked={value.showInMenu} onCheckedChange={c => set('showInMenu', c === true)} data-testid="master-show-in-menu" />
        <div><Label htmlFor={`${id}-menu`} className="font-normal">{t('masters.showInMenu')}</Label></div>
      </div>
      {listFields && listFields.length > 0 && (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{t('masters.listColumns')}</legend>
          <p className="mb-2 text-xs text-fg-subtle">{t('masters.listColumnsHint')}</p>
          <div className="grid gap-1.5 sm:grid-cols-2" data-testid="master-list-columns">
            {listFields.map(f => {
              const on = value.listColumns.includes(f.key);
              return (
                <label key={f.key} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={on} disabled={!on && value.listColumns.length >= 12}
                    onCheckedChange={c => set('listColumns', c ? [...value.listColumns, f.key] : value.listColumns.filter(k => k !== f.key))} />
                  {f.label}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
    </div>
  );
}

export const defaultSettings: SettingsShape = { codePattern: null, codeLabel: 'Code', nameLabel: 'Name', listColumns: [], defaultSort: 'name', showInMenu: true };

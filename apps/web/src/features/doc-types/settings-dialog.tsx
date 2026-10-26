'use client';
import { DocTypeSettings, type DocTypeSummary } from '@procure/schema';
import { Button, Checkbox, cn, Dialog, DialogContent, FormField, Input, Label, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t, tMaybe } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useFormDefinition } from '@/features/workflows/api';
import { isDataField } from '@/engines/form-renderer/formula';
import { docTypesApi } from './api';
import { DOC_TYPE_ICONS } from './icons';

const DOC_SYSTEM_COLUMNS = ['number', 'doc_date', 'location', 'status', 'total_amount', 'required_by', 'line_count', 'created_by', 'created_at', 'submitted_at'];
const ITEM_SYSTEM_COLUMNS = ['number', 'line_no', 'item', 'uom', 'qty', 'status', 'pending_approval', 'approved', 'rejected', 'required_date', 'location'];

/** Ordered column chooser: tick to show, arrows to reorder (max 20). */
function ColumnsPicker({ name, value, onChange, options }: { name: string; value: string[]; onChange: (v: string[]) => void; options: { key: string; label: string }[] }) {
  const base = useId();
  const ordered = [...value.filter(k => options.some(o => o.key === k)), ...options.map(o => o.key).filter(k => !value.includes(k))];
  const label = (k: string) => options.find(o => o.key === k)?.label ?? k;
  const move = (k: string, dir: -1 | 1) => {
    const i = value.indexOf(k);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded border border-border" data-testid={`doctype-set-${name}`}>
      {ordered.map(k => {
        const on = value.includes(k);
        const i = value.indexOf(k);
        return (
          <li key={k} className={cn('flex min-h-10 items-center gap-2 px-2.5 py-1', !on && 'text-fg-muted')}>
            <Checkbox id={`${base}-${k}`} checked={on} disabled={!on && value.length >= 20}
              onCheckedChange={c => onChange(c === true ? [...value, k] : value.filter(x => x !== k))} data-testid={`doctype-set-${name}-${k}`} />
            <Label htmlFor={`${base}-${k}`} className="flex-1 font-normal">{label(k)}</Label>
            {on && (
              <>
                <Button variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => move(k, -1)} aria-label={t('dt.colUp', { name: label(k) })}><ArrowUp aria-hidden /></Button>
                <Button variant="ghost" size="icon-sm" disabled={i === value.length - 1} onClick={() => move(k, 1)} aria-label={t('dt.colDown', { name: label(k) })}><ArrowDown aria-hidden /></Button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Toggle({ name, label, hint, value, onChange, disabled }: { name: string; label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <Switch id={id} checked={value} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" data-testid={`doctype-set-${name}`} />
      <div><Label htmlFor={id} className="font-normal">{label}</Label>{hint && <p className="text-sm text-fg-muted">{hint}</p>}</div>
    </div>
  );
}

export function DocTypeSettingsDialog({ docType: d, onClose }: { docType: DocTypeSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const header = useFormDefinition(d.headerFormKey);
  const line = useFormDefinition(d.lineFormKey);
  const [name, setName] = useState(d.name);
  const [plural, setPlural] = useState(d.pluralName);
  const [description, setDescription] = useState(d.description ?? '');
  const [s, setS] = useState<DocTypeSettings>(() => DocTypeSettings.parse(d.settings ?? {}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof DocTypeSettings>(k: K, v: DocTypeSettings[K]) => setS(prev => ({ ...prev, [k]: v }));

  const fieldsOf = (def: typeof header.data) => (def?.fields ?? []).filter(f => isDataField(f) && !f.removed && f.type !== 'grid').map(f => ({ key: f.key, label: 'label' in f ? f.label : f.key }));
  const docCols = useMemo(() => {
    const custom = fieldsOf(header.data).filter(f => !DOC_SYSTEM_COLUMNS.includes(f.key));
    return [...DOC_SYSTEM_COLUMNS.map(k => ({ key: k, label: tMaybe(`dt.col.${k}`, k) })), ...custom];
  }, [header.data]);
  const itemCols = useMemo(() => {
    const custom = fieldsOf(line.data).filter(f => !ITEM_SYSTEM_COLUMNS.includes(f.key));
    return [...ITEM_SYSTEM_COLUMNS.map(k => ({ key: k, label: tMaybe(`dt.col.${k}`, k) })), ...custom];
  }, [line.data]);

  async function save() {
    if (name.trim().length < 2 || plural.trim().length < 2) { setError(t('dt.nameRule')); return; }
    setBusy(true);
    setError(null);
    try {
      await docTypesApi.update(d.key, { name: name.trim(), pluralName: plural.trim(), description: description.trim() || undefined, settings: s, version: d.version });
      void qc.invalidateQueries({ queryKey: ['doc-types'] });
      toast.success(t('dt.settingsSaved', { name: name.trim() }));
      onClose();
    } catch (e) {
      setError(isApiError(e) && (e.status === 409 || e.is('VERSION_CONFLICT')) ? t('dt.conflict') : isApiError(e) ? [e.message, ...e.errors.map(x => x.message)].join(' · ') : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={t('dt.settingsTitle', { name: d.name })} size="lg" closeLabel={t('common.close')} data-testid="doctype-settings-dialog"
        footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={() => void save()} loading={busy} data-testid="doctype-settings-save">{t('common.saveChanges')}</Button></>}>
        {error && <InlineAlert className="mb-3" data-testid="doctype-settings-error">{error}</InlineAlert>}
        <Tabs defaultValue="general">
          <TabsList className="mb-4">
            <TabsTrigger value="general" data-testid="doctype-tab-general">{t('dt.tab.general')}</TabsTrigger>
            <TabsTrigger value="lists" data-testid="doctype-tab-lists">{t('dt.tab.lists')}</TabsTrigger>
            <TabsTrigger value="rules" data-testid="doctype-tab-rules">{t('dt.tab.rules')}</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('dt.name')} required><Input value={name} onChange={e => setName(e.target.value)} maxLength={60} data-testid="doctype-set-name" /></FormField>
              <FormField label={t('dt.plural')} required><Input value={plural} onChange={e => setPlural(e.target.value)} maxLength={60} data-testid="doctype-set-plural" /></FormField>
            </div>
            <FormField label={t('dt.descriptionLabel')}><Textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={500} rows={2} data-testid="doctype-set-description" /></FormField>
            <FormField label={t('dt.numberLabel')} hint={t('dt.numberLabelHint')}><Input value={s.numberLabel} onChange={e => set('numberLabel', e.target.value)} maxLength={40} data-testid="doctype-set-numberLabel" /></FormField>
            <Toggle name="showInMenu" label={t('dt.showInMenu')} hint={t('dt.showInMenuHint')} value={s.showInMenu} onChange={v => set('showInMenu', v)} />
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">{t('dt.icon')}</legend>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('dt.icon')} data-testid="doctype-set-icon">
                {Object.entries(DOC_TYPE_ICONS).map(([k, I]) => (
                  <button key={k} type="button" role="radio" aria-checked={s.icon === k} aria-label={k} title={k} onClick={() => set('icon', k)}
                    className={cn('grid size-9 place-items-center rounded border', s.icon === k ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:border-border-strong')}
                    data-testid={`doctype-set-icon-${k}`}>
                    <I className="size-4" aria-hidden />
                  </button>
                ))}
              </div>
            </fieldset>
          </TabsContent>
          <TabsContent value="lists" className="space-y-4">
            <section className="space-y-1.5">
              <h3 className="text-sm font-medium">{t('dt.documentColumns')}</h3>
              <p className="text-sm text-fg-muted">{t('dt.documentColumnsHint')}</p>
              <ColumnsPicker name="documentColumns" value={s.documentColumns} onChange={v => set('documentColumns', v)} options={docCols} />
            </section>
            {d.lineFormKey && (
              <>
                <Toggle name="itemWiseView" label={t('dt.itemWiseView')} hint={t('dt.itemWiseViewHint')} value={s.itemWiseView} onChange={v => set('itemWiseView', v)} />
                {s.itemWiseView && (
                  <section className="space-y-1.5">
                    <h3 className="text-sm font-medium">{t('dt.itemColumns')}</h3>
                    <ColumnsPicker name="itemColumns" value={s.itemColumns} onChange={v => set('itemColumns', v)} options={itemCols} />
                  </section>
                )}
              </>
            )}
          </TabsContent>
          <TabsContent value="rules" className="space-y-4">
            <fieldset className="space-y-1.5" data-testid="doctype-set-editableStatuses">
              <legend className="text-sm font-medium">{t('dt.editableStatuses')}</legend>
              <p className="text-sm text-fg-muted">{t('dt.editableStatusesHint')}</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {(d.statuses.length ? d.statuses : [{ key: 'draft', label: t('dt.status.draft'), tone: 'neutral' as const }]).map(st => (
                  <div key={st.key} className="flex items-center gap-2">
                    <Checkbox id={`es-${st.key}`} checked={s.editableStatuses.includes(st.key)} disabled={st.key === 'draft'}
                      onCheckedChange={c => set('editableStatuses', c === true ? [...s.editableStatuses, st.key] : s.editableStatuses.filter(x => x !== st.key))}
                      data-testid={`doctype-set-editableStatuses-${st.key}`} />
                    <Label htmlFor={`es-${st.key}`} className="font-normal">{st.label}</Label>
                  </div>
                ))}
              </div>
            </fieldset>
            {d.lineFormKey && <Toggle name="allowLineCancel" label={t('dt.allowLineCancel')} hint={t('dt.allowLineCancelHint')} value={s.allowLineCancel} onChange={v => set('allowLineCancel', v)} />}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

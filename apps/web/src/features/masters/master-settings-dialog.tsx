'use client';
import type { MasterSummary } from '@procure/schema';
import { Button, Dialog, DialogContent, FormField, Input, Textarea, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { isDataField } from '@/engines/form-renderer/formula';
import { useRenderableForm } from '@/engines/form-renderer/render-api';
import { mastersApi } from './api';
import { MasterSettingsFields, type SettingsShape } from './master-settings-fields';

export function MasterSettingsDialog({ master, onClose }: { master: MasterSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(master.name);
  const [plural, setPlural] = useState(master.pluralName);
  const [description, setDescription] = useState(master.description ?? '');
  const [settings, setSettings] = useState<SettingsShape>(master.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRenderableForm(master.formKey);
  const listFields = useMemo(
    () => (form.data?.definition.fields ?? []).filter(isDataField).filter(f => !f.removed && f.type !== 'grid' && f.key !== 'code' && f.key !== 'name').map(f => ({ key: f.key, label: f.label })),
    [form.data],
  );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await mastersApi.update(master.key, { name: name.trim(), pluralName: plural.trim(), description: description.trim() || undefined, settings, version: master.version });
      void qc.invalidateQueries({ queryKey: ['masters'] });
      toast.success(t('masters.settingsSaved'));
      onClose();
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={t('masters.settingsFor', { name: master.name })} closeLabel={t('common.close')} data-testid="master-settings-dialog"
        footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={() => void save()} loading={busy} data-testid="master-settings-save">{t('common.saveChanges')}</Button></>}>
        <div className="space-y-4">
          {error && <InlineAlert>{error}</InlineAlert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('masters.wizard.name')} required><Input value={name} onChange={e => setName(e.target.value)} maxLength={60} /></FormField>
            <FormField label={t('masters.wizard.plural')} required><Input value={plural} onChange={e => setPlural(e.target.value)} maxLength={60} /></FormField>
          </div>
          <FormField label={t('masters.wizard.description')}><Textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} maxLength={500} /></FormField>
          <MasterSettingsFields value={settings} onChange={setSettings} listFields={listFields} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

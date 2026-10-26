'use client';
import { ErrorCode, MasterCreate } from '@procure/schema';
import { Button, cn, Dialog, DialogContent, FormField, Input, Textarea, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Check, PencilRuler } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { keyFromLabel } from '@/engines/form-builder/catalog';
import { mastersApi } from './api';
import { defaultSettings, MasterSettingsFields, type SettingsShape } from './master-settings-fields';

const STEPS = ['basics', 'settings', 'fields'] as const;

/** New master: name/plural/key → settings → create and continue to the form builder for its fields. */
export function NewMasterWizard({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [plural, setPlural] = useState('');
  const [pluralTouched, setPluralTouched] = useState(false);
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [settings, setSettings] = useState<SettingsShape>(defaultSettings);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ message: string; limit: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const body = { key, name: name.trim(), pluralName: plural.trim(), description: description.trim() || undefined, settings };

  function onName(v: string) {
    setName(v);
    if (!pluralTouched) setPlural(v ? (v.endsWith('s') ? v : v.endsWith('y') && !/[aeiou]y$/i.test(v) ? `${v.slice(0, -1)}ies` : `${v}s`) : '');
    if (!keyTouched) setKey(keyFromLabel(v).slice(0, 41));
  }

  function validateBasics() {
    const r = MasterCreate.pick({ key: true, name: true, pluralName: true }).safeParse(body);
    if (r.success) { setErrors({}); return true; }
    const e: Record<string, string> = {};
    for (const i of r.error.issues) {
      const p = String(i.path[0]);
      e[p] = p === 'key' ? t('masters.keyRule') : p === 'name' || p === 'pluralName' ? t('masters.nameRule') : i.message;
    }
    setErrors(e);
    return false;
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const m = await mastersApi.create(body);
      void qc.invalidateQueries({ queryKey: ['masters'] });
      toast.success(t('masters.createdMaster', { name: m.name }));
      onClose();
      router.push(`/config/forms/${m.formKey}`);
    } catch (e) {
      const limit = isApiError(e) && e.is(ErrorCode.LIMIT_EXCEEDED);
      if (isApiError(e) && e.errors.length) {
        const map: Record<string, string> = {};
        for (const fe of e.errors) map[fe.path.split('.')[0]!] = fe.message;
        setErrors(map);
        if (map.key || map.name || map.pluralName) setStep(0);
      }
      setError({ message: isApiError(e) ? e.message : String(e), limit });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent
        title={t('masters.newMaster')}
        description={t(`masters.wizard.${STEPS[step]}Hint` as 'masters.wizard.basicsHint')}
        closeLabel={t('common.close')}
        data-testid="new-master-wizard"
        footer={
          <>
            {step > 0 ? <Button variant="secondary" onClick={() => setStep(s => s - 1)}>{t('common.back')}</Button> : <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>}
            {step < 2 ? (
              <Button onClick={() => { if (step > 0 || validateBasics()) setStep(s => s + 1); }} data-testid="master-wizard-next">{t('common.continue')}</Button>
            ) : (
              <Button onClick={() => void create()} loading={busy} data-testid="master-wizard-submit"><PencilRuler aria-hidden />{t('masters.wizard.create')}</Button>
            )}
          </>
        }
      >
        <ol className="mb-5 flex items-center gap-2 text-sm" aria-label={t('masters.wizard.steps')}>
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2" aria-current={i === step ? 'step' : undefined}>
              <span className={cn('grid size-6 place-items-center rounded-full text-xs font-semibold', i < step ? 'bg-success text-white' : i === step ? 'bg-accent text-accent-fg' : 'bg-muted text-fg-muted')}>
                {i < step ? <Check className="size-3.5" aria-hidden /> : i + 1}
              </span>
              <span className={i === step ? 'font-medium' : 'text-fg-muted'}>{t(`masters.wizard.${s}` as 'masters.wizard.basics')}</span>
              {i < STEPS.length - 1 && <span className="h-px w-6 bg-border" aria-hidden />}
            </li>
          ))}
        </ol>
        {error && <InlineAlert tone={error.limit ? 'warning' : 'danger'} className="mb-4" data-testid={error.limit ? 'master-limit-error' : 'master-create-error'}>{error.message}</InlineAlert>}

        {step === 0 && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('masters.wizard.name')} error={errors.name} required hint={t('masters.wizard.nameHint')}>
                <Input value={name} onChange={e => onName(e.target.value)} maxLength={60} autoFocus data-testid="master-name" />
              </FormField>
              <FormField label={t('masters.wizard.plural')} error={errors.pluralName} required>
                <Input value={plural} onChange={e => { setPlural(e.target.value); setPluralTouched(true); }} maxLength={60} data-testid="master-plural" />
              </FormField>
            </div>
            <FormField label={t('masters.wizard.key')} error={errors.key} required hint={t('masters.wizard.keyHint')}>
              <Input value={key} onChange={e => { setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 41)); setKeyTouched(true); }} className="font-mono" data-testid="master-key" />
            </FormField>
            <FormField label={t('masters.wizard.description')} hint={t('common.optional')}>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={500} rows={2} data-testid="master-description" />
            </FormField>
          </div>
        )}
        {step === 1 && <MasterSettingsFields value={settings} onChange={setSettings} />}
        {step === 2 && (
          <div className="space-y-3 text-base">
            <p>{t('masters.wizard.fieldsBody', { name: name || '…' })}</p>
            <ul className="list-inside list-disc space-y-1 text-fg-muted">
              <li>{t('masters.wizard.fieldsPoint1', { code: settings.codeLabel, name: settings.nameLabel })}</li>
              <li>{t('masters.wizard.fieldsPoint2')}</li>
              <li>{t('masters.wizard.fieldsPoint3')}</li>
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

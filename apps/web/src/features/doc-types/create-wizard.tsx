'use client';
import { DocTypeCreate, ErrorCode, type DocTypeSummary } from '@procure/schema';
import { Button, Checkbox, cn, Dialog, DialogContent, FormField, Input, Label, Textarea, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Hash, List, PencilRuler, Rows3, Workflow } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useSession } from '@/lib/session';
import { keyFromName } from '@/features/workflows/model';
import { PatternEditor, patternProblem, useFyStartMonth } from '@/features/numbering/pattern';
import { docTypesApi } from './api';

const STEPS = ['basics', 'lines', 'numbering'] as const;

function pluralOf(v: string) {
  if (!v) return '';
  if (/s$/i.test(v)) return v;
  if (/[^aeiou]y$/i.test(v)) return `${v.slice(0, -1)}ies`;
  return `${v}s`;
}

/** New document type: name/plural/key → lines → number pattern → create, then links to its forms and workflow. */
export function CreateDocTypeWizard({ onClose, limitFull }: { onClose: () => void; limitFull: boolean }) {
  const qc = useQueryClient();
  const { reloadMe } = useSession();
  const p = usePermissions();
  const fy = useFyStartMonth();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [plural, setPlural] = useState('');
  const [pluralTouched, setPluralTouched] = useState(false);
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [hasLines, setHasLines] = useState(true);
  const [itemLines, setItemLines] = useState(true);
  const [pattern, setPattern] = useState('{PREFIX}/{FYS}/{SEQ:5}');
  const [numberLabel, setNumberLabel] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ message: string; limit: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<DocTypeSummary | null>(null);

  function onName(v: string) {
    setName(v);
    if (!pluralTouched) setPlural(pluralOf(v));
    if (!keyTouched) setKey(keyFromName(v).slice(0, 41));
  }

  const body = {
    key, name: name.trim(), pluralName: plural.trim(), description: description.trim() || undefined, hasLines, itemLines: hasLines && itemLines,
    numberPattern: pattern, settings: { numberLabel: numberLabel.trim() || t('dt.defaultNumberLabel', { name: name.trim() }).slice(0, 40), itemWiseView: hasLines },
  };

  function validateBasics() {
    const r = DocTypeCreate.pick({ key: true, name: true, pluralName: true }).safeParse(body);
    if (r.success) { setErrors({}); return true; }
    const e: Record<string, string> = {};
    for (const i of r.error.issues) {
      const k = String(i.path[0]);
      e[k] = k === 'key' ? t('dt.keyRule') : t('dt.nameRule');
    }
    setErrors(e);
    return false;
  }

  async function create() {
    if (patternProblem(pattern)) { setStep(2); return; }
    setBusy(true);
    setError(null);
    try {
      const d = await docTypesApi.create(body);
      void qc.invalidateQueries({ queryKey: ['doc-types'] });
      void qc.invalidateQueries({ queryKey: ['wf-list'] });
      void qc.invalidateQueries({ queryKey: ['config-forms'] });
      void reloadMe();
      toast.success(t('dt.created', { name: d.name }));
      setCreated(d);
    } catch (e) {
      const limit = isApiError(e) && e.is(ErrorCode.LIMIT_EXCEEDED);
      if (isApiError(e) && e.errors.length) {
        const map: Record<string, string> = {};
        for (const fe of e.errors) map[fe.path.split('.')[0]!] = fe.message;
        setErrors(map);
        if (map.key || map.name || map.pluralName) setStep(0);
        else if (map.numberPattern) setStep(2);
      }
      setError({ message: isApiError(e) ? e.message : String(e), limit });
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const links = [
      { href: `/config/forms/${created.headerFormKey}`, icon: PencilRuler, label: t('dt.next.header'), hint: t('dt.next.headerHint'), id: 'doctype-open-header', show: p.has('config.forms:action.view') },
      { href: created.lineFormKey ? `/config/forms/${created.lineFormKey}` : '', icon: Rows3, label: t('dt.next.line'), hint: t('dt.next.lineHint'), id: 'doctype-open-line', show: !!created.lineFormKey && p.has('config.forms:action.view') },
      { href: `/config/workflows/${created.key}`, icon: Workflow, label: t('dt.next.workflow'), hint: t('dt.next.workflowHint'), id: 'doctype-open-workflow', show: p.has('config.workflows:action.view') },
      { href: `/config/numbering?docType=${created.key}`, icon: Hash, label: t('dt.next.numbering'), hint: t('dt.next.numberingHint'), id: 'doctype-open-numbering', show: p.has('config.numbering:action.view') },
    ].filter(l => l.show);
    return (
      <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
        <DialogContent title={t('dt.createdTitle', { name: created.name })} description={t('dt.createdBody')} closeLabel={t('common.close')} data-testid="doctype-created"
          footer={<Button variant="secondary" onClick={onClose} data-testid="doctype-created-close">{t('common.done')}</Button>}>
          <ul className="space-y-2">
            {links.map(l => (
              <li key={l.id}>
                <Link href={l.href} onClick={onClose} data-testid={l.id}
                  className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 hover:border-accent hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-ring">
                  <l.icon className="mt-0.5 size-4 text-accent" aria-hidden />
                  <span><span className="block font-medium">{l.label}</span><span className="block text-sm text-fg-muted">{l.hint}</span></span>
                </Link>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    );
  }

  const next = () => { if (step === 0 && !validateBasics()) return; setStep(s => s + 1); };
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent
        title={t('dt.new')}
        description={t(`dt.wizard.${STEPS[step]}Hint` as 'dt.wizard.basicsHint')}
        closeLabel={t('common.close')}
        data-testid="doctype-wizard"
        footer={
          <>
            {step > 0 && <Button variant="ghost" onClick={() => setStep(s => s - 1)} data-testid="doctype-wizard-back">{t('common.back')}</Button>}
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            {step < STEPS.length - 1
              ? <Button onClick={next} data-testid="doctype-wizard-next">{t('common.continue')}</Button>
              : <Button onClick={() => void create()} loading={busy} disabled={limitFull || !!patternProblem(pattern)} data-testid="doctype-wizard-submit">{t('dt.create')}</Button>}
          </>
        }
      >
        <ol className="mb-4 flex items-center gap-2 text-sm" aria-label={t('dt.wizard.steps')}>
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2" aria-current={i === step ? 'step' : undefined}>
              <span className={cn('grid size-6 place-items-center rounded-full text-xs font-semibold',
                i < step ? 'bg-success-soft text-success' : i === step ? 'bg-accent text-accent-fg' : 'bg-muted text-fg-muted')}>
                {i < step ? <Check className="size-3.5" aria-hidden /> : i + 1}
              </span>
              <span className={cn(i === step ? 'font-medium' : 'text-fg-muted', 'hidden sm:inline')}>{t(`dt.wizard.${s}` as 'dt.wizard.basics')}</span>
              {i < STEPS.length - 1 && <span className="h-px w-6 bg-border" aria-hidden />}
            </li>
          ))}
        </ol>
        {error && <InlineAlert className="mb-3" data-testid={error.limit ? 'doctype-limit-error' : 'doctype-create-error'}>{error.message}</InlineAlert>}
        {limitFull && !error && <InlineAlert tone="warning" className="mb-3" data-testid="doctype-limit-error">{t('dt.limitBlocked')}</InlineAlert>}

        {step === 0 && (
          <div className="space-y-4">
            <FormField label={t('dt.name')} hint={t('dt.nameHint')} error={errors.name} required>
              <Input value={name} onChange={e => onName(e.target.value)} maxLength={60} autoFocus data-testid="doctype-name" />
            </FormField>
            <FormField label={t('dt.plural')} error={errors.pluralName} required>
              <Input value={plural} onChange={e => { setPlural(e.target.value); setPluralTouched(true); }} maxLength={60} data-testid="doctype-plural" />
            </FormField>
            <FormField label={t('dt.key')} hint={t('dt.keyHint')} error={errors.key} required>
              <Input value={key} className="font-mono" maxLength={41} onChange={e => { setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')); setKeyTouched(true); }} data-testid="doctype-key" />
            </FormField>
            <FormField label={t('dt.descriptionLabel')} hint={t('common.optional')}>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={500} rows={2} data-testid="doctype-description" />
            </FormField>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <fieldset className="grid gap-2 sm:grid-cols-2" data-testid="doctype-has-lines">
              <legend className="sr-only">{t('dt.shape.legend')}</legend>
              {[{ v: true, icon: List, title: t('dt.shape.lines'), hint: t('dt.shape.linesHint') }, { v: false, icon: Rows3, title: t('dt.shape.header'), hint: t('dt.shape.headerHint') }].map(o => (
                <label key={String(o.v)} className={cn('flex cursor-pointer gap-3 rounded-lg border p-3', hasLines === o.v ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-strong')}>
                  <input type="radio" name="hasLines" className="sr-only" checked={hasLines === o.v} onChange={() => setHasLines(o.v)} data-testid={`doctype-has-lines-${o.v ? 'yes' : 'no'}`} />
                  <o.icon className={cn('mt-0.5 size-4 shrink-0', hasLines === o.v ? 'text-accent' : 'text-fg-subtle')} aria-hidden />
                  <span><span className="block font-medium">{o.title}</span><span className="block text-sm text-fg-muted">{o.hint}</span></span>
                </label>
              ))}
            </fieldset>
            {hasLines && (
              <div className="flex items-start gap-2.5">
                <Checkbox id="dt-item-lines" checked={itemLines} onCheckedChange={c => setItemLines(c === true)} data-testid="doctype-item-lines" className="mt-0.5" />
                <div>
                  <Label htmlFor="dt-item-lines" className="font-normal">{t('dt.itemLines')}</Label>
                  <p className="text-sm text-fg-muted">{t('dt.itemLinesHint')}</p>
                </div>
              </div>
            )}
            <p className="rounded bg-subtle px-3 py-2 text-sm text-fg-muted">{hasLines ? t('dt.systemFieldsLines') : t('dt.systemFieldsHeader')}</p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <PatternEditor value={pattern} onChange={setPattern} testId="doctype-pattern" label={t('dt.pattern')} error={errors.numberPattern}
              previewCtx={{ prefix: key || 'DOC', loc: 'PUN', fyStartMonth: fy }} describe={t('dt.patternHint')} />
            <FormField label={t('dt.numberLabel')} hint={t('dt.numberLabelHint')}>
              <Input value={numberLabel} placeholder={t('dt.defaultNumberLabel', { name: name || t('dt.name') })} onChange={e => setNumberLabel(e.target.value)} maxLength={40} data-testid="doctype-number-label" />
            </FormField>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

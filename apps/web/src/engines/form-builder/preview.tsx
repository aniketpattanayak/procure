'use client';
import type { FormDefinition, RenderableForm } from '@procure/schema';
import { Button } from '@procure/ui';
import { CheckCircle2, RotateCcw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { t } from '@/i18n';
import { FormRenderer, type FormRendererHandle } from '@/engines/form-renderer/form-renderer';
import { initialValues } from '@/engines/form-renderer/values';
import { todayIn } from '@/engines/form-renderer/formula';

/** Live preview of the draft with the real renderer (values are local and never saved). */
export function BuilderPreview({ formKey, def, title }: { formKey: string; def: FormDefinition; title?: string }) {
  const form = useMemo<RenderableForm>(() => ({ formKey, formVersionId: 'draft', definition: def, readOnlyFields: [] }), [formKey, def]);
  const [value, setValue] = useState<Record<string, unknown>>(() => initialValues(def.fields, todayIn()));
  const [result, setResult] = useState<'ok' | number | null>(null);
  const ref = useRef<FormRendererHandle>(null);
  return (
    <div className="p-4 sm:p-6" data-testid="builder-preview">
      <div className="mx-auto max-w-4xl rounded-lg border border-border bg-surface p-4 shadow-pop sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <p className="text-sm text-fg-muted">{title ?? t('fb.previewHint')}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setValue(initialValues(def.fields, todayIn())); setResult(null); }}><RotateCcw aria-hidden />{t('fb.previewReset')}</Button>
            <Button size="sm" variant="secondary" onClick={() => { const e = ref.current?.validate() ?? {}; setResult(Object.keys(e).length || 'ok'); }} data-testid="builder-preview-validate">
              <CheckCircle2 aria-hidden />{t('fb.previewValidate')}
            </Button>
          </div>
        </div>
        {result !== null && (
          <p className={result === 'ok' ? 'mb-3 text-sm text-success' : 'mb-3 text-sm text-danger'} role="status">
            {result === 'ok' ? t('fb.previewValid') : t('fb.previewInvalid', { n: result })}
          </p>
        )}
        <FormRenderer ref={ref} form={form} value={value} onChange={setValue} idPrefix="pv" />
      </div>
    </div>
  );
}

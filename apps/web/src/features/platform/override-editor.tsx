'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { OverrideSet, type Entitlements } from '@procure/schema';
import { Button, Checkbox, Dialog, DialogContent, FormField, Input, Label, Switch, Textarea } from '@procure/ui';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { applyProblemToForm } from '@/lib/api';

type Feature = Entitlements['features'][number];
type Limit = Entitlements['limits'][number];
export type OverrideTarget = { kind: 'feature'; row: Feature } | { kind: 'limit'; row: Limit };

const FormSchema = z.object({
  mode: z.enum(['set', 'remove']),
  enabled: z.boolean(),
  unlimited: z.boolean(),
  amount: z.union([z.number().int().min(0), z.nan()]).optional(),
  reason: OverrideSet.shape.reason,
}).superRefine((v, ctx) => {
  if (v.mode === 'set' && !v.unlimited && (v.amount === undefined || Number.isNaN(v.amount))) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: t('override.amountRequired') });
  }
});
type FormValues = z.infer<typeof FormSchema>;

/** Per-row override editor. Always requires a reason (written to override history). */
export function OverrideEditor({ target, onClose, onSave }: { target: OverrideTarget | null; onClose: () => void; onSave: (body: z.infer<typeof OverrideSet>) => Promise<unknown> }) {
  const [error, setError] = useState<string | null>(null);
  const isFeature = target?.kind === 'feature';
  const hasOverride = target ? (target.kind === 'feature' ? target.row.source === 'override' : target.row.override !== undefined) : false;
  const limitStart = target?.kind === 'limit' ? (target.row.override !== undefined ? target.row.override : target.row.planValue) : null;

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      mode: 'set',
      enabled: target?.kind === 'feature' ? !target.row.enabled : false,
      unlimited: target?.kind === 'limit' ? limitStart === null : false,
      amount: typeof limitStart === 'number' ? limitStart : undefined,
      reason: '',
    },
  });
  const { register, control, handleSubmit, formState: { errors, isSubmitting } } = form;
  const mode = useWatch({ control, name: 'mode' });
  const unlimited = useWatch({ control, name: 'unlimited' });

  const submit = handleSubmit(async v => {
    if (!target) return;
    setError(null);
    const body = v.mode === 'remove'
      ? { kind: target.kind, key: target.row.key, remove: true, reason: v.reason }
      : { kind: target.kind, key: target.row.key, value: isFeature ? v.enabled : (v.unlimited ? null : (v.amount as number)), reason: v.reason };
    try {
      await onSave(body);
      onClose();
    } catch (e) {
      const msg = applyProblemToForm(e, form.setError, ['reason']);
      if (msg) setError(msg);
    }
  });

  return (
    <Dialog open={!!target} onOpenChange={o => { if (!o) { setError(null); onClose(); } }}>
      <DialogContent
        title={target ? t('override.title', { name: target.row.name }) : ''}
        description={target?.kind === 'limit'
          ? t('override.limitPlan', { value: target.row.planValue === null ? t('usage.unlimited') : target.row.planValue, used: target.row.used })
          : target ? t('override.featurePlan', { state: target.row.source === 'plan' || (target.row.source === 'override' && !target.row.enabled) ? t('override.inPlan') : t('override.notInPlan') }) : undefined}
        size="sm"
        closeLabel={t('common.close')}
        data-testid="override-editor"
      >
        <form onSubmit={submit} noValidate className="space-y-4">
          {error && <InlineAlert>{error}</InlineAlert>}
          {hasOverride && (
            <Controller control={control} name="mode" render={({ field }) => (
              <div className="flex items-center gap-2">
                <Checkbox id="ov-remove" checked={field.value === 'remove'} onCheckedChange={c => field.onChange(c ? 'remove' : 'set')} data-testid="override-remove" />
                <Label htmlFor="ov-remove" className="font-normal">{t('override.removeLabel')}</Label>
              </div>
            )} />
          )}
          {mode === 'set' && (isFeature ? (
            <Controller control={control} name="enabled" render={({ field }) => (
              <div className="flex items-center justify-between rounded border border-border p-3">
                <Label htmlFor="ov-enabled">{t('override.enabled')}</Label>
                <Switch id="ov-enabled" checked={field.value} onCheckedChange={field.onChange} data-testid="override-enabled" />
              </div>
            )} />
          ) : (
            <div className="space-y-3">
              <Controller control={control} name="unlimited" render={({ field }) => (
                <div className="flex items-center gap-2">
                  <Switch id="ov-unlimited" checked={field.value} onCheckedChange={field.onChange} data-testid="override-unlimited" />
                  <Label htmlFor="ov-unlimited">{t('usage.unlimited')}</Label>
                </div>
              )} />
              {!unlimited && (
                <FormField label={t('override.value')} error={errors.amount?.message} required>
                  <Input type="number" min={0} step={1} inputMode="numeric" {...register('amount', { valueAsNumber: true })} data-testid="override-value" />
                </FormField>
              )}
            </div>
          ))}
          <FormField label={t('common.reason')} error={errors.reason?.message} hint={t('override.reasonHint')} required>
            <Textarea rows={3} {...register('reason')} data-testid="override-reason" />
          </FormField>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={isSubmitting} data-testid="override-save">{mode === 'remove' ? t('override.remove') : t('override.save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

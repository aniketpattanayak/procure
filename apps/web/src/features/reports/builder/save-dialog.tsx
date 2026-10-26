'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Checkbox, Dialog, DialogContent, FormField, Input, Skeleton, Textarea } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { InlineAlert } from '@/components/page';
import { rolesApi } from '@/features/users/api';
import { t } from '@/i18n';
import { applyProblemToForm } from '@/lib/api';
import { slugKey } from './model';

const Form = z.object({
  name: z.string().trim().min(1, t('builder.save.nameRequired')).max(120),
  key: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/, t('builder.save.keyInvalid')),
  description: z.string().max(500).optional(),
  sharedRoleIds: z.array(z.string()),
});
export type SaveValues = z.infer<typeof Form>;

/** Save / save as: name, key (follows the name until typed), description, share with roles. */
export function SaveDialog({ open, onOpenChange, initial, keyLocked, canShare, onSave, title }: {
  open: boolean; onOpenChange: (o: boolean) => void; initial: SaveValues; keyLocked: boolean; canShare: boolean; title: string;
  onSave: (v: SaveValues) => Promise<unknown>;
}) {
  const form = useForm<SaveValues>({ resolver: zodResolver(Form), defaultValues: initial });
  const [keyTouched, setKeyTouched] = useState(keyLocked);
  const [error, setError] = useState<string | null>(null);
  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesApi.list, enabled: open && canShare, staleTime: 5 * 60_000 });
  useEffect(() => { if (open) { form.reset(initial); setKeyTouched(keyLocked); setError(null); } }, [open, initial, keyLocked, form]);

  const submit = form.handleSubmit(async v => {
    setError(null);
    try { await onSave(v); } catch (e) { setError(applyProblemToForm(e, form.setError as never, ['name', 'key', 'description', 'sharedRoleIds'])); }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} data-testid="builder-save-dialog"
        footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button><Button onClick={submit} loading={form.formState.isSubmitting} data-testid="builder-save-confirm">{t('builder.save.confirm')}</Button></>}>
        <form onSubmit={submit} className="space-y-4">
          {error && <InlineAlert data-testid="builder-save-error">{error}</InlineAlert>}
          <FormField label={t('builder.save.name')} error={form.formState.errors.name?.message} required>
            <Input {...form.register('name', { onChange: e => { if (!keyTouched) form.setValue('key', slugKey(e.target.value)); } })} autoFocus data-testid="builder-save-name" />
          </FormField>
          <FormField label={t('builder.save.key')} hint={keyLocked ? t('builder.save.keyLocked') : t('builder.save.keyHint')} error={form.formState.errors.key?.message}>
            <Input {...form.register('key', { onChange: () => setKeyTouched(true) })} readOnly={keyLocked} className="font-mono" data-testid="builder-save-key" />
          </FormField>
          <FormField label={t('builder.save.description')} error={form.formState.errors.description?.message}>
            <Textarea {...form.register('description')} rows={2} data-testid="builder-save-description" />
          </FormField>
          {canShare && (
            <fieldset data-testid="builder-share">
              <legend className="mb-1 font-medium">{t('builder.save.share')}</legend>
              <p className="mb-2 text-sm text-fg-muted">{t('builder.save.shareHint')}</p>
              {roles.isLoading ? <Skeleton className="h-16" /> : (
                <Controller control={form.control} name="sharedRoleIds" render={({ field }) => (
                  <ul className="max-h-48 space-y-1 overflow-y-auto rounded border border-border p-2">
                    {(roles.data ?? []).map(r => (
                      <li key={r.id}>
                        <label className="flex items-center gap-2 rounded px-1 py-1 hover:bg-subtle">
                          <Checkbox checked={field.value.includes(r.id)} onCheckedChange={v => field.onChange(v ? [...field.value, r.id] : field.value.filter(x => x !== r.id))} data-testid={`builder-share-${r.key}`} />
                          <span>{r.name}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )} />
              )}
            </fieldset>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

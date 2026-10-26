'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Dialog, DialogContent, FormField, Textarea } from '@procure/ui';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { t } from '@/i18n';
import { InlineAlert } from './page';

const ReasonSchema = z.object({ reason: z.string().trim().min(3, t('validation.reasonMin')).max(500) });

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** Ask for a reason (min 3 chars) and pass it to onConfirm. */
  requireReason?: boolean;
  reasonLabel?: string;
  onConfirm: (reason: string) => Promise<unknown>;
  children?: ReactNode;
  testId?: string;
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, tone = 'primary', requireReason, reasonLabel, onConfirm, children, testId }: ConfirmDialogProps) {
  const form = useForm<{ reason: string }>({ resolver: requireReason ? zodResolver(ReasonSchema) : undefined, defaultValues: { reason: '' } });
  const [error, setError] = useState<string | null>(null);

  const submit = form.handleSubmit(async ({ reason }) => {
    setError(null);
    try {
      await onConfirm(reason);
      form.reset();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { form.reset(); setError(null); } onOpenChange(o); }}>
      <DialogContent
        title={title}
        description={description}
        size="sm"
        data-testid={testId}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button variant={tone === 'danger' ? 'danger' : 'primary'} type="submit" form="confirm-form" loading={form.formState.isSubmitting} data-testid={testId ? `${testId}-confirm` : undefined}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        <form id="confirm-form" onSubmit={submit} className="space-y-4" noValidate>
          {children}
          {requireReason && (
            <FormField label={reasonLabel ?? t('common.reason')} error={form.formState.errors.reason?.message} required>
              <Textarea rows={3} {...form.register('reason')} data-testid={testId ? `${testId}-reason` : undefined} />
            </FormField>
          )}
          {error && <InlineAlert>{error}</InlineAlert>}
        </form>
      </DialogContent>
    </Dialog>
  );
}

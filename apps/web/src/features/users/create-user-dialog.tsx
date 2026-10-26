'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { ErrorCode, UserCreate, type UserRow } from '@procure/schema';
import { Button, Dialog, DialogContent } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useForm, type Control, type UseFormRegister } from 'react-hook-form';
import { InlineAlert } from '@/components/page';
import { SecretReveal } from '@/components/secret-reveal';
import { t } from '@/i18n';
import { applyProblemToForm, isApiError } from '@/lib/api';
import { usersApi } from './api';
import { cleanOptional, UserFormFields, type UserFormShape } from './user-form-fields';
import type { FormRendererHandle } from '@/engines/form-renderer/form-renderer';
import type { ErrorMap } from '@/engines/form-renderer/validation';
import { customErrorsFrom, UserCustomFields, useUserCustomForm } from './user-custom-fields';

export function CreateUserDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (u: UserRow) => void }) {
  const qc = useQueryClient();
  const form = useForm({ resolver: zodResolver(UserCreate), defaultValues: { name: '', email: '', phone: '', isTenantAdmin: false, roleIds: [] } });
  const [error, setError] = useState<{ message: string; limit: boolean } | null>(null);
  const [created, setCreated] = useState<{ user: UserRow; temporaryPassword: string } | null>(null);
  // Tenant-defined fields from the `user` form, sent as `custom`.
  const customForm = useUserCustomForm();
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [customErrors, setCustomErrors] = useState<ErrorMap>({});
  const customRef = useRef<FormRendererHandle>(null);

  function close(o: boolean) {
    if (!o) {
      form.reset();
      setError(null);
      setCreated(null);
      setCustom({});
      setCustomErrors({});
    }
    onOpenChange(o);
  }

  const submit = form.handleSubmit(async values => {
    setError(null);
    if (customForm.form && Object.keys(customRef.current?.validate() ?? {}).length) return;
    try {
      const res = await usersApi.create({ ...cleanOptional(values), ...(customForm.form ? { custom } : {}) });
      setCreated(res);
      onCreated(res.user);
      // Creating a user can emit 80%/100% limit warnings to this admin (QA-BUG-005).
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch (e) {
      const limit = isApiError(e) && e.is(ErrorCode.LIMIT_EXCEEDED);
      setCustomErrors(customErrorsFrom(e));
      const msg = applyProblemToForm(e, form.setError, ['name', 'email', 'phone', 'isTenantAdmin', 'roleIds', 'custom']);
      if (msg) setError({ message: msg, limit });
    }
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={created ? t('users.created.title') : t('users.create.title')}
        description={created ? t('users.created.body', { email: created.user.email }) : t('users.create.description')}
        data-testid="create-user-dialog"
        closeLabel={t('common.close')}
        footer={created ? (
          <Button onClick={() => close(false)} data-testid="create-user-done">{t('common.done')}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => close(false)}>{t('common.cancel')}</Button>
            <Button type="submit" form="create-user-form" loading={form.formState.isSubmitting} data-testid="create-user-submit">{t('users.create.submit')}</Button>
          </>
        )}
      >
        {created ? (
          <SecretReveal label={t('users.tempPassword')} value={created.temporaryPassword} />
        ) : (
          <form id="create-user-form" onSubmit={submit} noValidate className="space-y-4">
            {error && (
              <InlineAlert tone={error.limit ? 'warning' : 'danger'} data-testid={error.limit ? 'user-limit-error' : 'create-user-error'}>
                {error.message}
              </InlineAlert>
            )}
            <UserFormFields
              register={form.register as unknown as UseFormRegister<UserFormShape>}
              control={form.control as unknown as Control<UserFormShape>}
              errors={form.formState.errors}
              includeEmail
            />
            {customForm.form && <UserCustomFields form={customForm.form} value={custom} onChange={setCustom} errors={customErrors} handleRef={customRef} />}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

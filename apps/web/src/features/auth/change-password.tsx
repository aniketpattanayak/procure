'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { PasswordChange, type AuthResult } from '@procure/schema';
import { Button, FormField, Input, Skeleton, SkeletonGroup } from '@procure/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { applyProblemToForm, http } from '@/lib/api';
import { homeFor, useSession } from '@/lib/session';
import { AuthLayout } from './auth-layout';
import { PasswordRules } from './password-rules';

const Schema = PasswordChange.and(z.object({ confirmPassword: z.string() })).superRefine((v, ctx) => {
  if (v.newPassword !== v.confirmPassword) ctx.addIssue({ code: 'custom', path: ['confirmPassword'], message: t('password.mismatch') });
});
type Values = z.input<typeof Schema>;

export function ChangePasswordPage({ kind }: { kind: 'tenant' | 'platform' }) {
  const { status, me, acceptAuth } = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' } });
  const { register, handleSubmit, setError: setFieldError, control, formState: { errors, isSubmitting } } = form;
  const newPassword = useWatch({ control, name: 'newPassword' }) ?? '';

  useEffect(() => {
    if (status === 'anonymous') router.replace(kind === 'platform' ? '/platform/login' : '/login');
  }, [status, kind, router]);

  const forced = !!me?.mustChangePassword;

  const onSubmit = handleSubmit(async ({ currentPassword, newPassword: np }) => {
    setError(null);
    try {
      const result = await http.post<AuthResult>('/auth/password/change', { currentPassword, newPassword: np });
      const dest = await acceptAuth(result);
      router.replace(dest);
    } catch (e) {
      setError(applyProblemToForm(e, setFieldError, ['currentPassword', 'newPassword']));
    }
  });

  if (status !== 'ready') {
    return (
      <AuthLayout title={t('password.title')} variant={kind}>
        <SkeletonGroup className="space-y-4"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></SkeletonGroup>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      variant={kind}
      title={forced ? t('password.forcedTitle') : t('password.title')}
      subtitle={forced ? t('password.forcedSubtitle') : t('password.subtitle')}
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4" data-testid="change-password-form">
        {error && <InlineAlert>{error}</InlineAlert>}
        <FormField label={forced ? t('password.temporary') : t('password.current')} error={errors.currentPassword?.message} required>
          <Input type="password" autoComplete="current-password" autoFocus {...register('currentPassword')} data-testid="cp-current" />
        </FormField>
        <FormField label={t('password.new')} error={errors.newPassword?.message} required>
          <Input type="password" autoComplete="new-password" {...register('newPassword')} data-testid="cp-new" />
        </FormField>
        <PasswordRules value={newPassword} />
        <FormField label={t('password.confirm')} error={errors.confirmPassword?.message} required>
          <Input type="password" autoComplete="new-password" {...register('confirmPassword')} data-testid="cp-confirm" />
        </FormField>
        <div className="flex flex-col gap-2 pt-1">
          <Button type="submit" size="lg" loading={isSubmitting} data-testid="cp-submit">{t('password.submit')}</Button>
          {!forced && (
            <Button variant="ghost" onClick={() => router.replace(homeFor(me?.principal))}>{t('common.cancel')}</Button>
          )}
        </div>
      </form>
    </AuthLayout>
  );
}

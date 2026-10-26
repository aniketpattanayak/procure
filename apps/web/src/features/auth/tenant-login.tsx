'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { TenantLogin, type AuthResult } from '@procure/schema';
import { Button, FormField, Input } from '@procure/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AuthLayout } from './auth-layout';
import { loginErrorMessage } from './login-error';
import { safeNext, useRedirectIfSignedIn } from './use-redirect-if-signed-in';

const LAST_TENANT = 'procure.lastTenant';

export function TenantLoginPage() {
  useRedirectIfSignedIn('tenant');
  const { acceptAuth } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(TenantLogin), defaultValues: { tenantCode: '', email: '', password: '' } });
  const { register, handleSubmit, formState: { errors, isSubmitting }, setValue, setFocus } = form;

  useEffect(() => {
    try {
      // Cookie set by middleware when user visits via subdomain (e.g. acme.ourdomain.com)
      const hint = document.cookie.split('; ').find(c => c.startsWith('x-tenant-hint='))?.split('=')[1];
      if (hint) { setValue('tenantCode', hint); setFocus('email'); return; }
      const last = window.localStorage.getItem(LAST_TENANT);
      if (last) { setValue('tenantCode', last); setFocus('email'); return; }
    } catch { /* ignore */ }
    setFocus('tenantCode');
  }, [setValue, setFocus]);

  const onSubmit = handleSubmit(async values => {
    setError(null);
    try {
      const result = await api<AuthResult>('/auth/login', { method: 'POST', body: values, anonymous: true });
      try { window.localStorage.setItem(LAST_TENANT, values.tenantCode); } catch { /* ignore */ }
      const dest = await acceptAuth(result);
      router.replace(result.mustChangePassword ? dest : safeNext(params.get('next'), 'tenant') ?? dest);
    } catch (e) {
      setError(loginErrorMessage(e));
    }
  });

  return (
    <AuthLayout
      title={t('auth.signIn')}
      subtitle={t('auth.signInSubtitle')}
      footer={<Link className="text-accent hover:underline" href="/platform/login">{t('auth.platformLink')}</Link>}
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4" data-testid="login-form">
        {error && <InlineAlert data-testid="login-error">{error}</InlineAlert>}
        <FormField label={t('auth.tenantCode')} error={errors.tenantCode?.message} hint={t('auth.tenantCodeHint')} required>
          <Input autoComplete="organization" autoCapitalize="none" spellCheck={false} {...register('tenantCode')} data-testid="login-tenant" />
        </FormField>
        <FormField label={t('auth.email')} error={errors.email?.message} required>
          <Input type="email" autoComplete="username" {...register('email')} data-testid="login-email" />
        </FormField>
        <FormField label={t('auth.password')} error={errors.password?.message} required>
          <Input type="password" autoComplete="current-password" {...register('password')} data-testid="login-password" />
        </FormField>
        <Button type="submit" className="w-full" size="lg" loading={isSubmitting} data-testid="login-submit">{t('auth.signIn')}</Button>
      </form>
    </AuthLayout>
  );
}

'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { PlatformLogin, type AuthResult } from '@procure/schema';
import { Button, FormField, Input } from '@procure/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AuthLayout } from './auth-layout';
import { loginErrorMessage } from './login-error';
import { safeNext, useRedirectIfSignedIn } from './use-redirect-if-signed-in';

export function PlatformLoginPage() {
  useRedirectIfSignedIn('platform');
  const { acceptAuth } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(PlatformLogin), defaultValues: { email: '', password: '' } });

  const onSubmit = handleSubmit(async values => {
    setError(null);
    try {
      const result = await api<AuthResult>('/auth/platform/login', { method: 'POST', body: values, anonymous: true });
      const dest = await acceptAuth(result);
      router.replace(result.mustChangePassword ? dest : safeNext(params.get('next'), 'platform') ?? dest);
    } catch (e) {
      setError(loginErrorMessage(e));
    }
  });

  return (
    <AuthLayout
      variant="platform"
      title={t('auth.platformSignIn')}
      subtitle={t('auth.platformSubtitle')}
      footer={<Link className="text-accent hover:underline" href="/login">{t('auth.tenantLink')}</Link>}
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4" data-testid="platform-login-form">
        {error && <InlineAlert data-testid="login-error">{error}</InlineAlert>}
        <FormField label={t('auth.email')} error={errors.email?.message} required>
          <Input type="email" autoComplete="username" autoFocus {...register('email')} data-testid="login-email" />
        </FormField>
        <FormField label={t('auth.password')} error={errors.password?.message} required>
          <Input type="password" autoComplete="current-password" {...register('password')} data-testid="login-password" />
        </FormField>
        <Button type="submit" className="w-full" size="lg" loading={isSubmitting} data-testid="login-submit">{t('auth.signIn')}</Button>
      </form>
    </AuthLayout>
  );
}

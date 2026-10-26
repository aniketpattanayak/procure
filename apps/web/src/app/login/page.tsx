import { Suspense } from 'react';
import { TenantLoginPage } from '@/features/auth/tenant-login';

export const metadata = { title: 'Sign in' };

export default function Page() {
  return <Suspense><TenantLoginPage /></Suspense>;
}

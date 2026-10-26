import { Suspense } from 'react';
import { PlatformLoginPage } from '@/features/auth/platform-login';

export const metadata = { title: 'Platform sign in' };

export default function Page() {
  return <Suspense><PlatformLoginPage /></Suspense>;
}

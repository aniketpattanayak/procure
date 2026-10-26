'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@procure/ui';
import { useState, type ReactNode } from 'react';
import { isApiError } from '@/lib/api';
import { SessionProvider } from '@/lib/session';
import { t } from '@/i18n';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
  }));
  return (
    <QueryClientProvider client={client}>
      <SessionProvider>{children}</SessionProvider>
      <Toaster closeLabel={t('common.dismiss')} />
    </QueryClientProvider>
  );
}

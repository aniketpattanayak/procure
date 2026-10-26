'use client';
import type { ReactNode } from 'react';
import { AreaGuard } from '@/components/area-guard';
import { AppShell } from '@/components/shell/app-shell';
import { platformNav } from '@/components/shell/nav';
import { t } from '@/i18n';

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <AreaGuard kind="platform">
      <AppShell nav={platformNav} subtitle={t('auth.platformConsole')}>{children}</AppShell>
    </AreaGuard>
  );
}

'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const SettingsPage = dynamic(() => import('@/features/settings/settings-page').then(m => m.SettingsPage), {
  loading: () => <PageBody><PageSkeleton rows={8} /></PageBody>,
});

export default function Page() {
  return <RequirePermission perm="admin.settings:action.view"><SettingsPage /></RequirePermission>;
}

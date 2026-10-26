'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const TenantUsagePage = dynamic(() => import('@/features/usage/tenant-usage-page').then(m => m.TenantUsagePage), {
  loading: () => <PageBody><PageSkeleton /></PageBody>,
});

export default function Page() {
  return <RequirePermission perm="admin.usage:action.view"><TenantUsagePage /></RequirePermission>;
}

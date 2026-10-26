'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const RolesPage = dynamic(() => import('@/features/roles/roles-page').then(m => m.RolesPage), {
  loading: () => <PageBody><PageSkeleton /></PageBody>,
});

export default function Page() {
  return <RequirePermission perm="admin.roles:action.view"><RolesPage /></RequirePermission>;
}

'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const UsersPage = dynamic(() => import('@/features/users/users-page').then(m => m.UsersPage), {
  loading: () => <PageBody><PageSkeleton rows={8} /></PageBody>,
});

export default function Page() {
  return <RequirePermission perm="admin.users:action.view"><UsersPage /></RequirePermission>;
}

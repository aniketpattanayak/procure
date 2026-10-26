'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const UserAccessPage = dynamic(() => import('@/features/users/user-access-page').then(m => m.UserAccessPage), {
  loading: () => <PageBody><PageSkeleton /></PageBody>,
});

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <RequirePermission perm="admin.users:action.view"><UserAccessPage userId={id} /></RequirePermission>;
}

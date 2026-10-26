'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const RoleDetailPage = dynamic(() => import('@/features/roles/role-detail-page').then(m => m.RoleDetailPage), {
  loading: () => <PageBody><PageSkeleton /></PageBody>,
});

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <RequirePermission anyOf={['admin.roles:action.manage_permissions', 'admin.roles:action.edit']}><RoleDetailPage roleId={id} /></RequirePermission>;
}

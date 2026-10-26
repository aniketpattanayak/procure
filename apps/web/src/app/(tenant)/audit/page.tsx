'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const AuditLogPage = dynamic(() => import('@/features/audit/audit-log-page').then(m => m.AuditLogPage), {
  loading: () => <PageBody><PageSkeleton rows={8} /></PageBody>,
});

export default function Page() {
  return <RequirePermission perm="admin.audit:action.view"><AuditLogPage /></RequirePermission>;
}

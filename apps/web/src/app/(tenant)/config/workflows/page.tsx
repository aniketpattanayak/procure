'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const WorkflowsPage = dynamic(() => import('@/features/workflows/workflows-page').then(m => m.WorkflowsPage), {
  loading: () => <PageBody><PageSkeleton rows={5} /></PageBody>,
});

export default function Page() {
  return <RequirePermission perm="config.workflows:action.view"><WorkflowsPage /></RequirePermission>;
}

'use client';
import { Skeleton, SkeletonGroup } from '@procure/ui';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { RequirePermission } from '@/components/guards';

// The designer (dnd-kit, formula editor, form renderer for simulation) loads only on this route.
const WorkflowDesignerPage = dynamic(() => import('@/features/workflows/designer-page').then(m => m.WorkflowDesignerPage), {
  ssr: false,
  loading: () => (
    <SkeletonGroup className="flex h-[calc(100dvh-var(--topbar-h))] flex-col">
      <div className="border-b border-border px-4 py-3"><Skeleton className="h-6 w-64" /></div>
      <div className="flex-1 space-y-4 p-8"><Skeleton className="mx-auto h-24 max-w-2xl" /><Skeleton className="mx-auto h-24 max-w-2xl" /></div>
    </SkeletonGroup>
  ),
});

export default function Page() {
  const { docType } = useParams<{ docType: string }>();
  return <RequirePermission perm="config.workflows:action.view"><WorkflowDesignerPage docType={docType} /></RequirePermission>;
}

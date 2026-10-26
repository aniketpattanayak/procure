'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const DocTypesPage = dynamic(() => import('@/features/doc-types/doc-types-page').then(m => m.DocTypesPage), {
  loading: () => <PageBody><PageSkeleton rows={5} /></PageBody>,
});

export default function Page() {
  return <RequirePermission perm="config.doc_types:action.view"><DocTypesPage /></RequirePermission>;
}

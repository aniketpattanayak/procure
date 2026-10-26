'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const IssuePage = dynamic(() => import('@/features/stock/issue-page').then(m => m.IssuePage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm={'doc.store_issue:action.add'}>
      <Suspense fallback={skeleton()}><IssuePage /></Suspense>
    </RequirePermission>
  );
}

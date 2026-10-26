'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const ReturnPage = dynamic(() => import('@/features/stock/return-page').then(m => m.ReturnPage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm={'doc.store_return:action.add'}>
      <Suspense fallback={skeleton()}><ReturnPage /></Suspense>
    </RequirePermission>
  );
}

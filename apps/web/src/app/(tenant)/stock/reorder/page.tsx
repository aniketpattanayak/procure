'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const ReorderPage = dynamic(() => import('@/features/stock/reorder-page').then(m => m.ReorderPage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm={'stock:action.view'}>
      <Suspense fallback={skeleton()}><ReorderPage /></Suspense>
    </RequirePermission>
  );
}

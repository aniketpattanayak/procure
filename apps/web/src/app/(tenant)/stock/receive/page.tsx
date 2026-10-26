'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const ReceivePage = dynamic(() => import('@/features/stock/receive-page').then(m => m.ReceivePage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm={'doc.grn:action.add'}>
      <Suspense fallback={skeleton()}><ReceivePage /></Suspense>
    </RequirePermission>
  );
}

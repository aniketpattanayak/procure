'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const OpeningPage = dynamic(() => import('@/features/stock/opening-page').then(m => m.OpeningPage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm={'stock:action.opening'}>
      <Suspense fallback={skeleton()}><OpeningPage /></Suspense>
    </RequirePermission>
  );
}

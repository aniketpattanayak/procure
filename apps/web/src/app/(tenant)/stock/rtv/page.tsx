'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const RtvPage = dynamic(() => import('@/features/stock/rtv-page').then(m => m.RtvPage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm={'doc.rtv:action.add'}>
      <Suspense fallback={skeleton()}><RtvPage /></Suspense>
    </RequirePermission>
  );
}

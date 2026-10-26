'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const OrderPage = dynamic(() => import('@/features/procurement/order/order-page').then(m => m.OrderPage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm="doc.po:action.add">
      <Suspense fallback={skeleton()}><OrderPage /></Suspense>
    </RequirePermission>
  );
}

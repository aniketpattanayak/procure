'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={8} /></PageBody>;
const StockBalancesPage = dynamic(() => import('@/features/stock/balances-page').then(m => m.StockBalancesPage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm={'stock:action.view'}>
      <Suspense fallback={skeleton()}><StockBalancesPage /></Suspense>
    </RequirePermission>
  );
}

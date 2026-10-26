'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={8} /></PageBody>;
const LedgerPage = dynamic(() => import('@/features/stock/ledger-page').then(m => m.LedgerPage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm={'stock:action.view'}>
      <Suspense fallback={skeleton()}><LedgerPage /></Suspense>
    </RequirePermission>
  );
}

'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const SelectionPage = dynamic(() => import('@/features/procurement/select/selection-page').then(m => m.SelectionPage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm="doc.vendor_selection:action.add">
      <Suspense fallback={skeleton()}><SelectionPage /></Suspense>
    </RequirePermission>
  );
}

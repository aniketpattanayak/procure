'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const InboxPage = dynamic(() => import('@/features/approvals/inbox-page').then(m => m.InboxPage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm="approvals:action.view">
      <Suspense fallback={skeleton()}><InboxPage /></Suspense>
    </RequirePermission>
  );
}

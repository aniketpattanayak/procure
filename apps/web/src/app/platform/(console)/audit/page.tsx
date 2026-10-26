'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const Comp = dynamic(() => import('@/features/platform/audit-page').then(m => m.AuditPage), {
  loading: () => <PageBody><PageSkeleton /></PageBody>,
});

export default function Page() {
  return <Suspense><Comp /></Suspense>;
}

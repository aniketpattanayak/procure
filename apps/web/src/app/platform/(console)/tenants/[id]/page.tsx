'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const TenantDetailPage = dynamic(() => import('@/features/platform/tenant-detail-page').then(m => m.TenantDetailPage), {
  loading: () => <PageBody><PageSkeleton rows={8} /></PageBody>,
});

export default function Page() {
  return <TenantDetailPage />;
}

'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const TenantsPage = dynamic(() => import('@/features/platform/tenants-page').then(m => m.TenantsPage), {
  loading: () => <PageBody><PageSkeleton rows={8} /></PageBody>,
});

export default function Page() {
  return <TenantsPage />;
}

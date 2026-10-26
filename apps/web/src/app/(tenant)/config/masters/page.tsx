'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const MastersConfigPage = dynamic(() => import('@/features/masters/masters-config-page').then(m => m.MastersConfigPage), {
  loading: () => <PageBody><PageSkeleton rows={6} /></PageBody>,
});

export default function Page() {
  return <MastersConfigPage />;
}

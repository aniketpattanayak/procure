'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const FormsPage = dynamic(() => import('@/features/forms/forms-page').then(m => m.FormsPage), {
  loading: () => <PageBody><PageSkeleton rows={6} /></PageBody>,
});

export default function Page() {
  return <FormsPage />;
}

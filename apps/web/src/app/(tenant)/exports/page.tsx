'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={5} /></PageBody>;
const ExportsPage = dynamic(() => import('@/features/exports/exports-page').then(m => m.ExportsPage), { loading: skeleton });

// Any signed-in user sees their own export jobs (the API scopes /exports to the requester).
export default function Page() {
  return <ExportsPage />;
}

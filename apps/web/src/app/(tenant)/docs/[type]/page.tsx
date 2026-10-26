'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={8} /></PageBody>;
const DocListPage = dynamic(() => import('@/features/documents/doc-list-page').then(m => m.DocListPage), { loading: skeleton });

export default function Page() {
  const { type } = useParams<{ type: string }>();
  return <Suspense fallback={skeleton()}><DocListPage key={type} type={type} /></Suspense>;
}

'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={8} /></PageBody>;
const DocDetailPage = dynamic(() => import('@/features/documents/doc-detail-page').then(m => m.DocDetailPage), { loading: skeleton });

export default function Page() {
  const { type, id } = useParams<{ type: string; id: string }>();
  return <Suspense fallback={skeleton()}><DocDetailPage key={`${type}:${id}`} type={type} id={id} /></Suspense>;
}

'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={8} /></PageBody>;
const ApproveScreen = dynamic(() => import('@/features/approvals/approve-screen').then(m => m.ApproveScreen), { loading: skeleton });

export default function Page() {
  const { type, id } = useParams<{ type: string; id: string }>();
  return <Suspense fallback={skeleton()}><ApproveScreen key={`${type}:${id}`} type={type} id={id} /></Suspense>;
}

'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const Comp = dynamic(() => import('@/features/notify/platform-wa-templates-page').then(m => m.PlatformWaTemplatesPage), { loading: skeleton });

export default function Page() {
  return <Suspense fallback={skeleton()}><Comp /></Suspense>;
}

'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const TriggersPage = dynamic(() => import('@/features/notify/triggers-page').then(m => m.TriggersPage), { loading: skeleton });

export default function Page() {
  return <RequirePermission perm="config.triggers:action.view"><Suspense fallback={skeleton()}><TriggersPage /></Suspense></RequirePermission>;
}

'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={8} /></PageBody>;
const MessagesPage = dynamic(() => import('@/features/messages/messages-page').then(m => m.MessagesPage), { loading: skeleton });

export default function Page() {
  return <RequirePermission perm="messages:action.view"><Suspense fallback={skeleton()}><MessagesPage /></Suspense></RequirePermission>;
}

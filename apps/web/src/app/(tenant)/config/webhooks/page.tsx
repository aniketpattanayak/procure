'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';
import { RequireFeature } from '@/features/webhooks/require-feature';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const WebhooksPage = dynamic(() => import('@/features/webhooks/webhooks-page').then(m => m.WebhooksPage), { loading: skeleton });

export default function Page() {
  return (
    <RequirePermission perm="config.webhooks:action.view">
      <RequireFeature feature="api_access"><Suspense fallback={skeleton()}><WebhooksPage /></Suspense></RequireFeature>
    </RequirePermission>
  );
}

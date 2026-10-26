'use client';
import dynamic from 'next/dynamic';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const TemplatesPage = dynamic(() => import('@/features/templates/templates-page').then(m => m.TemplatesPage), { loading: skeleton });

export default function Page() {
  return <RequirePermission perm="config.templates:action.view"><Suspense fallback={skeleton()}><TemplatesPage /></Suspense></RequirePermission>;
}

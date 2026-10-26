'use client';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
// The designer (dnd-kit, Recharts) loads only on this route.
const DashboardDesigner = dynamic(() => import('@/features/dashboards/designer').then(m => m.DashboardDesigner), { ssr: false, loading: skeleton });

function Inner() {
  const id = useSearchParams().get('id') ?? undefined;
  return <DashboardDesigner key={id ?? 'mine'} id={id} />;
}

export default function Page() {
  return <RequirePermission perm="dashboards:action.edit"><Suspense fallback={skeleton()}><Inner /></Suspense></RequirePermission>;
}

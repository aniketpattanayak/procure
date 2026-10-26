'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={8} /></PageBody>;
// Recharts and the virtualised results table load only on this route.
const ReportViewer = dynamic(() => import('@/features/reports/report-viewer').then(m => m.ReportViewer), { ssr: false, loading: skeleton });

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequirePermission perm="reports:action.view">
      <Suspense fallback={skeleton()}><ReportViewer id={id} /></Suspense>
    </RequirePermission>
  );
}

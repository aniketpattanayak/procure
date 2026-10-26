'use client';
import { Skeleton, SkeletonGroup } from '@procure/ui';
import dynamic from 'next/dynamic';

/** The builder (dnd-kit, Recharts, preview table) loads lazily, only on /reports/new and /reports/:id/edit. */
export const ReportBuilderPage = dynamic(() => import('@/features/reports/builder/builder-page').then(m => m.ReportBuilderPage), {
  ssr: false,
  loading: () => (
    <SkeletonGroup className="flex h-[calc(100dvh-var(--topbar-h))] flex-col">
      <div className="border-b border-border px-4 py-3"><Skeleton className="h-6 w-64" /></div>
      <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[17rem_1fr_19rem]"><Skeleton className="h-full" /><Skeleton className="h-full" /><Skeleton className="h-full" /></div>
    </SkeletonGroup>
  ),
});

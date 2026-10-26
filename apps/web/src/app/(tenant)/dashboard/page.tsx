'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

// Phase 7: the configurable dashboard (GET /dashboards/mine). The Phase 3 approvals widget renders as the
// `inbox_counts` widget type, and the page falls back to the Phase 3 cards when the dashboards API is unavailable.
const DashboardHome = dynamic(() => import('@/features/dashboards/dashboard-home').then(m => m.DashboardHome), {
  loading: () => <PageBody><PageSkeleton rows={4} /></PageBody>,
});

export default function DashboardPage() {
  return <DashboardHome />;
}

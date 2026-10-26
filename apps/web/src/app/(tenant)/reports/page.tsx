'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={6} /></PageBody>;
const ReportsHome = dynamic(() => import('@/features/reports/reports-home').then(m => m.ReportsHome), { loading: skeleton });

export default function Page() {
  return <RequirePermission perm="reports:action.view"><ReportsHome /></RequirePermission>;
}

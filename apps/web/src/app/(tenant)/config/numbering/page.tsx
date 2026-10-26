'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const NumberingPage = dynamic(() => import('@/features/numbering/numbering-page').then(m => m.NumberingPage), {
  loading: () => <PageBody><PageSkeleton rows={5} /></PageBody>,
});

export default function Page() {
  return <RequirePermission perm="config.numbering:action.view"><NumberingPage /></RequirePermission>;
}

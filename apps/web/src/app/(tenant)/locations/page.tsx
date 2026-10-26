'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const LocationsPage = dynamic(() => import('@/features/locations/locations-page').then(m => m.LocationsPage), {
  loading: () => <PageBody><PageSkeleton rows={8} /></PageBody>,
});

export default function Page() {
  return <RequirePermission perm="admin.locations:action.view"><LocationsPage /></RequirePermission>;
}

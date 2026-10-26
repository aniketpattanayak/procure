'use client';
import dynamic from 'next/dynamic';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const Wizard = dynamic(() => import('@/features/platform/create-tenant-wizard').then(m => m.CreateTenantWizard), {
  loading: () => <PageBody className="max-w-3xl"><PageSkeleton /></PageBody>,
});

export default function Page() {
  return <Wizard />;
}

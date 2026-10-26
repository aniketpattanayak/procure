'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const MasterRecordsPage = dynamic(() => import('@/features/masters/master-records-page').then(m => m.MasterRecordsPage), {
  loading: () => <PageBody><PageSkeleton rows={8} /></PageBody>,
});

export default function Page() {
  const { key } = useParams<{ key: string }>();
  return <MasterRecordsPage key={key} masterKey={key} />;
}

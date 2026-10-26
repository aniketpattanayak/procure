'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { PageSkeleton } from '@/components/guards';
import { PageBody } from '@/components/page';

const DocFormPage = dynamic(() => import('@/features/documents/doc-form-page').then(m => m.DocFormPage), {
  loading: () => <PageBody><PageSkeleton rows={8} /></PageBody>,
});

export default function Page() {
  const { type } = useParams<{ type: string }>();
  return <DocFormPage key={type} type={type} />;
}

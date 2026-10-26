'use client';
import { Skeleton, SkeletonGroup } from '@procure/ui';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';

// The builder (dnd-kit, renderer, CodeMirror via its own chunk) loads only on this route.
const FormBuilderPage = dynamic(() => import('@/engines/form-builder/builder-page').then(m => m.FormBuilderPage), {
  ssr: false,
  loading: () => (
    <SkeletonGroup className="flex h-[calc(100dvh-var(--topbar-h))] flex-col">
      <div className="border-b border-border px-4 py-3"><Skeleton className="h-6 w-56" /></div>
      <div className="flex-1 space-y-3 p-6"><Skeleton className="mx-auto h-16 max-w-4xl" /><Skeleton className="mx-auto h-16 max-w-4xl" /></div>
    </SkeletonGroup>
  ),
});

export default function Page() {
  const { formKey } = useParams<{ formKey: string }>();
  return <FormBuilderPage formKey={formKey} />;
}

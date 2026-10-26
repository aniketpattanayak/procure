'use client';
import { Skeleton, SkeletonGroup } from '@procure/ui';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/guards';

// The designer (CodeMirror, previews) loads only on this route.
const skeleton = () => (
  <SkeletonGroup className="flex h-[calc(100dvh-var(--topbar-h))] flex-col">
    <div className="border-b border-border px-4 py-3"><Skeleton className="h-7 w-72" /></div>
    <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[15rem_1fr_1fr]"><Skeleton /><Skeleton /><Skeleton /></div>
  </SkeletonGroup>
);
const TemplateEditorPage = dynamic(() => import('@/features/templates/template-editor-page').then(m => m.TemplateEditorPage), { ssr: false, loading: skeleton });

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <RequirePermission perm="config.templates:action.view"><Suspense fallback={skeleton()}><TemplateEditorPage key={id} id={id} /></Suspense></RequirePermission>;
}

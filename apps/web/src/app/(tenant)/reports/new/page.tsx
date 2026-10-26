'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { RequirePermission } from '@/components/guards';
import { ReportBuilderPage } from '../builder-route';

function Inner() {
  const from = useSearchParams().get('from') ?? undefined;
  return <ReportBuilderPage key={from ?? 'new'} from={from} />;
}

export default function Page() {
  return <RequirePermission perm="reports:action.build"><Suspense><Inner /></Suspense></RequirePermission>;
}

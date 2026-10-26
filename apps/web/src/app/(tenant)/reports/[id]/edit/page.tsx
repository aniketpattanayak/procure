'use client';
import { useParams } from 'next/navigation';
import { RequirePermission } from '@/components/guards';
import { ReportBuilderPage } from '../../builder-route';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <RequirePermission perm="reports:action.build"><ReportBuilderPage key={id} id={id} /></RequirePermission>;
}

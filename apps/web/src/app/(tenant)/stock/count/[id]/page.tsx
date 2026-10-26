'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { PageSkeleton, RequirePermission } from '@/components/guards';
import { PageBody } from '@/components/page';

const skeleton = () => <PageBody><PageSkeleton rows={8} /></PageBody>;
const CountSheetPage = dynamic(() => import('@/features/stock/count-sheet-page').then(m => m.CountSheetPage), { loading: skeleton });

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequirePermission perm="doc.stock_count:action.view">
      <CountSheetPage id={id} />
    </RequirePermission>
  );
}

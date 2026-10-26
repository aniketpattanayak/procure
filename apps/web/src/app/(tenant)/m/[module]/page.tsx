'use client';
import { EmptyState } from '@procure/ui';
import { Construction } from 'lucide-react';
import { notFound, useParams } from 'next/navigation';
import { PageBody, PageHeader } from '@/components/page';
import { tenantNav } from '@/components/shell/nav';
import { t } from '@/i18n';
import { useSession } from '@/lib/session';

/** Placeholder for Phase 2+ modules. Only reachable when the plan includes the feature. */
export default function ModulePlaceholder() {
  const { module } = useParams<{ module: string }>();
  const { features } = useSession();
  const item = tenantNav.find(i => i.feature === module);
  if (!item || !features.has(module)) notFound();
  return (
    <PageBody>
      <PageHeader title={t(item.label)} />
      <EmptyState icon={<Construction />} title={t('module.soonTitle')} description={t('module.soonBody')} />
    </PageBody>
  );
}

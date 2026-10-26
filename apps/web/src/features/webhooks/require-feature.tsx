'use client';
import { EmptyState } from '@procure/ui';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import { useSession } from '@/lib/session';

/** Plan-gated page content: hidden when the plan feature is off (nav hides the entry too). */
export function RequireFeature({ feature, children }: { feature: string; children: ReactNode }) {
  const { features, status } = useSession();
  if (status !== 'ready') return null;
  if (!features.has(feature)) return <EmptyState icon={<Lock />} title={t('webhook.notInPlan')} description={t('webhook.notInPlanHint')} />;
  return <>{children}</>;
}

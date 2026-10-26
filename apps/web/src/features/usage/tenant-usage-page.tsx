'use client';
import type { Entitlements } from '@procure/schema';
import { Badge, Card, CardBody, CardHeader, Skeleton, SkeletonGroup } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { SubscriptionBadge } from '@/components/status';
import { t } from '@/i18n';
import { http } from '@/lib/api';
import { LimitsList } from './limits-list';

/** Limits tied to a feature the plan doesn't include are hidden (Phase 2 contract: `limits[].featureKey`). */
export function visibleLimits(e: Entitlements) {
  const on = new Set(e.features.filter(f => f.enabled).map(f => f.key));
  return e.limits.filter(l => !l.featureKey || on.has(l.featureKey));
}

export function TenantUsagePage() {
  const q = useQuery({ queryKey: ['tenant', 'usage'], queryFn: ({ signal }) => http.get<Entitlements>('/tenant/usage', undefined, signal) });
  return (
    <PageBody className="max-w-4xl">
      <PageHeader title={t('usage.title')} description={t('usage.description')} />
      {q.isLoading ? (
        <SkeletonGroup className="space-y-4">
          <Skeleton className="h-20" />
          <div className="space-y-5 rounded-lg border border-border p-5">{[0, 1, 2, 3].map(i => <div key={i} className="space-y-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-2" /></div>)}</div>
        </SkeletonGroup>
      ) : q.isError ? (
        <InlineAlert>{(q.error as Error).message}</InlineAlert>
      ) : q.data && (
        <div className="space-y-4">
          <Card>
            <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div><p className="text-sm text-fg-muted">{t('usage.plan')}</p><p className="text-md font-semibold">{q.data.planName ?? '—'}</p></div>
              <div><p className="text-sm text-fg-muted">{t('usage.subscription')}</p><SubscriptionBadge status={q.data.subscriptionStatus} /></div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t('usage.limits')} description={t('usage.limitsHint')} />
            <CardBody className="py-0">
              {visibleLimits(q.data).length ? <LimitsList limits={visibleLimits(q.data)} /> : <p className="py-4 text-fg-muted">{t('usage.noLimits')}</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t('usage.features')} />
            <CardBody>
              <ul className="flex flex-wrap gap-2">
                {q.data.features.filter(f => f.enabled).map(f => <li key={f.key}><Badge tone="accent">{f.name}</Badge></li>)}
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
    </PageBody>
  );
}

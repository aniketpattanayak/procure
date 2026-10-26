'use client';
import { Badge, Button, Card, EmptyState, Skeleton, SkeletonGroup, StatusBadge, Table, TBody, TD, TH, THead, TR } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Layers, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { t, tMaybe } from '@/i18n';
import { fmtMoney } from '@/lib/format';
import { platformApi } from './api';

export function PlansPage() {
  const router = useRouter();
  const plans = useQuery({ queryKey: ['platform', 'plans'], queryFn: platformApi.plans });
  return (
    <PageBody>
      <PageHeader
        title={t('plans.title')}
        description={t('plans.description')}
        actions={<Button asChild data-testid="create-plan-button"><Link href="/platform/plans/new"><Plus aria-hidden />{t('plans.create')}</Link></Button>}
      />
      <Card className="overflow-hidden">
        {plans.isLoading ? (
          <SkeletonGroup className="space-y-2 p-4">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}</SkeletonGroup>
        ) : plans.isError ? (
          <div className="p-4"><InlineAlert>{(plans.error as Error).message}</InlineAlert></div>
        ) : !plans.data?.length ? (
          <EmptyState icon={<Layers />} title={t('plans.empty')} />
        ) : (
          <Table data-testid="plans-table">
            <THead><TR>
              <TH>{t('plans.col.name')}</TH><TH>{t('plans.col.price')}</TH><TH className="hidden md:table-cell">{t('plans.col.features')}</TH>
              <TH className="text-right">{t('plans.col.users')}</TH><TH className="text-right">{t('plans.col.tenants')}</TH><TH>{t('plans.col.status')}</TH>
            </TR></THead>
            <TBody>
              {plans.data.map(p => (
                <TR key={p.id} className="cursor-pointer hover:bg-subtle" onClick={() => router.push(`/platform/plans/${p.id}`)}>
                  <TD>
                    <Link href={`/platform/plans/${p.id}`} className="font-medium hover:underline" onClick={e => e.stopPropagation()}>{p.name}</Link>
                    <p className="font-mono text-sm text-fg-muted">{p.code}</p>
                  </TD>
                  <TD className="whitespace-nowrap tabular">{fmtMoney(p.price, p.currency)} <span className="text-fg-muted">/ {tMaybe(`cycle.${p.billingCycle}`, p.billingCycle)}</span></TD>
                  <TD className="hidden md:table-cell"><Badge>{t('plans.featureCount', { n: p.features.length })}</Badge></TD>
                  <TD className="text-right tabular">{p.limits.max_users === null ? '∞' : (p.limits.max_users ?? 0)}</TD>
                  <TD className="text-right tabular">{p.tenantCount}</TD>
                  <TD>{p.isActive ? <StatusBadge tone="success">{t('plans.active')}</StatusBadge> : <StatusBadge>{t('plans.inactive')}</StatusBadge>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </PageBody>
  );
}

'use client';
import { Button, Skeleton } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid } from 'lucide-react';
import Link from 'next/link';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { ApprovalsWidget } from '@/features/approvals/inbox-widget';
import { DocTypesCard } from '@/features/documents/doc-types-card';
import { REPORT_PERMS, dashboardsApi, reportKeys } from '@/features/reports/api';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useTenantPrincipal } from '@/lib/session';
import { DashboardGrid } from './dashboard-grid';
import { readingOrder } from './grid';
import { WidgetView } from './widgets';

/** /dashboard: the user's dashboard from GET /dashboards/mine (role default → personal → built-in "My work"). */
export function DashboardHome() {
  const me = useTenantPrincipal();
  const p = usePermissions();
  const mine = useQuery({ queryKey: reportKeys.dashMine, queryFn: dashboardsApi.mine, enabled: p.ready, retry: false, staleTime: 60_000 });
  const d = mine.data;
  const canEdit = p.has(REPORT_PERMS.dashEdit);
  const kind = d?.source ?? (d?.builtin ? 'builtin' : d?.isMine ? 'personal' : d ? 'role' : null);
  const sourceNote = kind ? t(`dash.source.${kind}` as 'dash.source.role') : null;

  return (
    <PageBody className="max-w-[90rem]">
      <PageHeader
        title={t('dashboard.greeting', { name: me?.name.split(' ')[0] ?? '' })}
        description={d ? <span data-testid="dash-name">{d.name}{sourceNote ? <span className="text-fg-subtle"> · {sourceNote}</span> : null}</span> : me?.tenantName}
        actions={canEdit ? (
          <Button asChild variant="secondary" size="sm">
            <Link href={d?.id && !d.builtin && d.canEdit !== false ? `/dashboard/design?id=${d.id}` : '/dashboard/design'} data-testid="dash-customise"><LayoutGrid aria-hidden />{t('dash.customise')}</Link>
          </Button>
        ) : undefined}
      />
      {mine.isLoading || !p.ready ? (
        <div className="grid gap-4 lg:grid-cols-12" aria-busy="true" aria-label={t('common.loading')} data-testid="dash-skeleton">
          <Skeleton className="h-44 lg:col-span-3" /><Skeleton className="h-44 lg:col-span-3" /><Skeleton className="h-44 lg:col-span-6" />
          <Skeleton className="h-72 lg:col-span-6" /><Skeleton className="h-72 lg:col-span-6" />
        </div>
      ) : mine.isError ? (
        // The dashboards API is not reachable (older API or missing permission): fall back to the Phase 3 home.
        <div className="space-y-4" data-testid="dash-fallback">
          {isApiError(mine.error) && mine.error.status !== 404 && mine.error.status !== 403 && <InlineAlert tone="warning">{mine.error.message}</InlineAlert>}
          <div className="grid gap-4 md:grid-cols-3"><DocTypesCard className="md:col-span-2" /><ApprovalsWidget /></div>
        </div>
      ) : d && d.widgets.length ? (
        <DashboardGrid widgets={readingOrder(d.widgets)} render={w => <WidgetView widget={w} dashboardId={d.id} />} />
      ) : (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center" data-testid="dash-empty">
          <p className="font-medium">{t('dash.empty')}</p>
          {canEdit && <Button asChild size="sm" className="mt-3"><Link href="/dashboard/design">{t('dash.customise')}</Link></Button>}
        </div>
      )}
    </PageBody>
  );
}

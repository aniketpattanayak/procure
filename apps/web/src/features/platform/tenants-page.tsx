'use client';
import { TenantStatus, type TenantListRow } from '@procure/schema';
import { Button, DataTable, EmptyState, Input, NativeSelect, type DataTableColumn } from '@procure/ui';
import { Building2, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { PageBody, PageHeader } from '@/components/page';
import { SubscriptionBadge, TenantStatusBadge } from '@/components/status';
import { t, tMaybe } from '@/i18n';
import { fmtDate } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { platformApi } from './api';

export function TenantsPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const q = useDebounced(search, 300);
  const fetchPage = useCallback((cursor: string | null) => platformApi.tenants({ cursor, q: q || undefined, status: status || undefined }), [q, status]);

  const columns = useMemo<DataTableColumn<TenantListRow>[]>(() => [
    {
      id: 'name', header: t('tenants.col.name'), width: 240, alwaysVisible: true,
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.original.name}</p>
          <p className="truncate font-mono text-sm text-fg-muted">{row.original.code}</p>
        </div>
      ),
    },
    { id: 'status', header: t('tenants.col.status'), width: 120, cell: ({ row }) => <TenantStatusBadge status={row.original.status} /> },
    { id: 'plan', header: t('tenants.col.plan'), width: 150, cell: ({ row }) => row.original.planName ?? '—' },
    { id: 'subscription', header: t('tenants.col.subscription'), width: 130, cell: ({ row }) => <SubscriptionBadge status={row.original.subscriptionStatus} /> },
    {
      id: 'users', header: t('tenants.col.users'), width: 110, align: 'right',
      cell: ({ row }) => <span>{row.original.activeUsers} / {row.original.maxUsers ?? '∞'}</span>,
    },
    { id: 'renewal', header: t('tenants.col.renewal'), width: 130, cell: ({ row }) => fmtDate(row.original.renewalDate) },
    { id: 'created', header: t('tenants.col.created'), width: 130, defaultHidden: true, cell: ({ row }) => fmtDate(row.original.createdAt) },
  ], []);

  return (
    <PageBody>
      <PageHeader
        title={t('tenants.title')}
        description={t('tenants.description')}
        actions={<Button asChild data-testid="create-tenant-button"><Link href="/platform/tenants/new"><Plus aria-hidden />{t('tenants.create')}</Link></Button>}
      />
      <DataTable
        data-testid="tenants-table"
        columns={columns}
        fetchPage={fetchPage}
        queryKey={`${q}|${status}`}
        getRowId={r => r.id}
        onRowClick={r => router.push(`/platform/tenants/${r.id}`)}
        storageKey="platform-tenants"
        labels={{ caption: t('tenants.title'), columns: t('table.columns'), loadMore: t('table.loadMore'), error: t('table.error'), retry: t('common.retry'), loading: t('common.loading') }}
        toolbar={<>
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('tenants.search')} aria-label={t('tenants.search')} className="pl-8" data-testid="tenants-search" />
          </div>
          <NativeSelect value={status} onChange={e => setStatus(e.target.value)} aria-label={t('tenants.filterStatus')} className="w-auto" data-testid="tenants-status-filter">
            <option value="">{t('tenants.allStatuses')}</option>
            {TenantStatus.options.map(s => <option key={s} value={s}>{tMaybe(`tenantStatus.${s}`, s)}</option>)}
          </NativeSelect>
        </>}
        empty={<EmptyState icon={<Building2 />} title={q || status ? t('tenants.emptySearch') : t('tenants.empty')} />}
      />
    </PageBody>
  );
}

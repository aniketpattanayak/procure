'use client';
import type { PlatformAuditRow } from '@procure/schema';
import { Badge, DataTable, EmptyState, Input, type DataTableColumn } from '@procure/ui';
import { ScrollText, Search } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { fmtDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { platformApi } from './api';

export function AuditPage() {
  const params = useSearchParams();
  const tenantId = params.get('tenantId') ?? undefined;
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const fetchPage = useCallback((cursor: string | null) => platformApi.audit({ cursor, q: q || undefined, tenantId }), [q, tenantId]);

  const columns = useMemo<DataTableColumn<PlatformAuditRow>[]>(() => [
    { id: 'at', header: t('audit.col.when'), width: 170, alwaysVisible: true, cell: ({ row }) => <span className="tabular text-fg-muted">{fmtDateTime(row.original.at)}</span> },
    { id: 'actor', header: t('audit.col.actor'), width: 170, cell: ({ row }) => row.original.actorName ?? <span className="font-mono text-sm">{row.original.actorId?.slice(0, 8) ?? '—'}</span> },
    { id: 'action', header: t('audit.col.action'), width: 140, cell: ({ row }) => <Badge tone={/imperson/.test(row.original.action) ? 'warning' : 'neutral'}>{row.original.action}</Badge> },
    { id: 'entity', header: t('audit.col.entity'), width: 200, cell: ({ row }) => <span>{row.original.entity}{row.original.entityId && <span className="ml-1 font-mono text-sm text-fg-muted">{row.original.entityId.slice(0, 8)}</span>}</span> },
    {
      id: 'tenant', header: t('audit.col.tenant'), width: 180,
      cell: ({ row }) => row.original.tenantId
        ? <Link href={`/platform/tenants/${row.original.tenantId}`} onClick={e => e.stopPropagation()} className="text-accent hover:underline">{row.original.tenantCode ?? row.original.tenantId.slice(0, 8)}</Link>
        : <span className="text-fg-subtle">—</span>,
    },
    { id: 'ip', header: t('audit.col.ip'), width: 130, defaultHidden: true, cell: ({ row }) => <span className="tabular text-fg-muted">{row.original.ip ?? '—'}</span> },
  ], []);

  return (
    <PageBody>
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      <DataTable
        data-testid="audit-table"
        columns={columns}
        fetchPage={fetchPage}
        queryKey={`${q}|${tenantId ?? ''}`}
        getRowId={r => r.id}
        storageKey="platform-audit"
        labels={{ caption: t('audit.title'), columns: t('table.columns'), loadMore: t('table.loadMore'), error: t('table.error'), retry: t('common.retry'), loading: t('common.loading') }}
        toolbar={
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('audit.search')} aria-label={t('audit.search')} className="pl-8" />
          </div>
        }
        empty={<EmptyState icon={<ScrollText />} title={t('audit.empty')} />}
      />
    </PageBody>
  );
}

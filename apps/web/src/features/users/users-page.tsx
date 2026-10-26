'use client';
import type { UserRow } from '@procure/schema';
import { Badge, Button, DataTable, EmptyState, Input, type DataTableColumn } from '@procure/ui';
import { Plus, Search, Users } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { PageBody, PageHeader } from '@/components/page';
import { UserStatusBadge } from '@/components/status';
import { useDefaultView, ViewChips } from '@/components/view-chips';
import { t } from '@/i18n';
import { fmtRelative } from '@/lib/format';
import { Can, perm } from '@/lib/permissions';
import { useDebounced } from '@/lib/use-debounced';
import { usersApi } from './api';
import { CreateUserDialog } from './create-user-dialog';
import { UserDetailSheet } from './user-detail-sheet';

const TAB = 'admin.users';
const VIEWS = ['active', 'inactive'] as const;

export function UsersPage() {
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'active' | 'inactive'>(useDefaultView(TAB, VIEWS, 'active'));
  const [version, setVersion] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useDebounced(search, 300);

  const fetchPage = useCallback(
    (cursor: string | null) => usersApi.list({ cursor, q: q || undefined, view }),
    [q, view],
  );

  const columns = useMemo<DataTableColumn<UserRow>[]>(() => [
    {
      id: 'name', header: t('users.col.name'), width: 220, alwaysVisible: true,
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.original.name}</p>
          <p className="truncate text-sm text-fg-muted sm:hidden">{row.original.email}</p>
        </div>
      ),
    },
    { id: 'email', header: t('users.col.email'), width: 240, cell: ({ row }) => <span className="text-fg-muted">{row.original.email}</span> },
    {
      id: 'roles', header: t('users.col.roles'), width: 200,
      cell: ({ row }) => (
        <div className="flex gap-1 overflow-hidden">
          {row.original.isTenantAdmin && <Badge tone="accent">{t('users.adminBadge')}</Badge>}
          {row.original.roles.map(r => <Badge key={r.id}>{r.name}</Badge>)}
        </div>
      ),
    },
    { id: 'status', header: t('users.col.status'), width: 120, cell: ({ row }) => <UserStatusBadge user={row.original} /> },
    { id: 'phone', header: t('users.col.phone'), width: 140, defaultHidden: true, cell: ({ row }) => row.original.phone ?? '—' },
    { id: 'lastLogin', header: t('users.col.lastLogin'), width: 150, cell: ({ row }) => <span className="text-fg-muted">{row.original.lastLoginAt ? fmtRelative(row.original.lastLoginAt) : t('users.never')}</span> },
  ], []);

  const bump = () => setVersion(v => v + 1);

  return (
    <PageBody>
      <PageHeader
        title={t('users.title')}
        description={t('users.description')}
        actions={<Can perm={perm.action(TAB, 'add')}><Button onClick={() => setCreateOpen(true)} data-testid="create-user-button"><Plus aria-hidden />{t('users.create.button')}</Button></Can>}
      />
      <DataTable
        data-testid="users-table"
        columns={columns}
        fetchPage={fetchPage}
        queryKey={`${q}|${view}|${version}`}
        getRowId={u => u.id}
        onRowClick={u => setSelected(u.id)}
        storageKey="users"
        labels={{ caption: t('users.title'), columns: t('table.columns'), loadMore: t('table.loadMore'), error: t('table.error'), retry: t('common.retry'), loading: t('common.loading') }}
        toolbar={
          <>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('users.search')} aria-label={t('users.search')} className="pl-8" data-testid="users-search" />
            </div>
            <ViewChips
              tab={TAB}
              label={t('users.filter.status')}
              value={view}
              onChange={setView}
              testId="users-view"
              options={[{ value: 'active', label: t('users.filter.active') }, { value: 'inactive', label: t('users.filter.inactive') }]}
            />
          </>
        }
        empty={
          <EmptyState
            icon={<Users />}
            title={q ? t('users.emptySearch') : t('users.empty')}
            description={q ? undefined : t('users.emptyHint')}
            action={!q && <Can perm={perm.action(TAB, 'add')}><Button variant="secondary" onClick={() => setCreateOpen(true)}><Plus aria-hidden />{t('users.create.button')}</Button></Can>}
          />
        }
      />
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={bump} />
      <UserDetailSheet userId={selected} onOpenChange={o => { if (!o) setSelected(null); }} onChanged={bump} />
    </PageBody>
  );
}

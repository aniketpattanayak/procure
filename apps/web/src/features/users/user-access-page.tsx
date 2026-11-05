'use client';
import type { UserRow } from '@procure/schema';
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Skeleton, SkeletonGroup, Tabs, TabsContent, TabsList, TabsTrigger, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, SearchX } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { UserStatusBadge } from '@/components/status';
import { permissionsApi, qk } from '@/features/permissions/api';
import { EffectivePanel } from '@/features/permissions/effective-panel';
import { PermissionWorkbench } from '@/features/permissions/permission-workbench';
import { ScopeEditor } from '@/features/permissions/scope-editor';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { perm, usePermissions } from '@/lib/permissions';
import { useSession } from '@/lib/session';
import { rolesApi, usersApi } from './api';

/** User access: role assignment, per-user overrides, data scope and the "why" view. */
export function UserAccessPage({ userId }: { userId: string }) {
  const user = useQuery({ queryKey: ['users', userId], queryFn: () => usersApi.get(userId) });
  const p = usePermissions();
  const canManage = p.has(perm.action('admin.users', 'manage_permissions'));
  const back = <Link href="/users" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden />{t('users.title')}</Link>;

  if (user.isLoading) return <PageBody><SkeletonGroup className="space-y-4"><Skeleton className="h-4 w-20" /><Skeleton className="h-7 w-64" /><Skeleton className="h-24" /><Skeleton className="h-96" /></SkeletonGroup></PageBody>;
  if (user.isError) {
    return <PageBody>{isApiError(user.error) && user.error.status === 404 ? <EmptyState icon={<SearchX />} title={t('users.notFound')} action={back} /> : <InlineAlert>{(user.error as Error).message}</InlineAlert>}</PageBody>;
  }
  const u = user.data!;
  return (
    <PageBody>
      <PageHeader
        back={back}
        title={<span className="flex flex-wrap items-center gap-2">{t('access.title', { name: u.name })}<UserStatusBadge user={u} />{u.isTenantAdmin && <Badge tone="accent">{t('users.adminBadge')}</Badge>}</span>}
        description={u.email}
      />
      <div className="space-y-5">
        <RoleAssignment user={u} canManage={canManage} />
        <Tabs defaultValue={canManage ? 'permissions' : 'why'}>
          <TabsList>
            {canManage && <TabsTrigger value="permissions" data-testid="access-tab-permissions">{t('perm.tabPermissions')}</TabsTrigger>}
            {canManage && <TabsTrigger value="scope" data-testid="access-tab-scope">{t('perm.tabScope')}</TabsTrigger>}
            <TabsTrigger value="why" data-testid="access-tab-why">{t('perm.tabWhy')}</TabsTrigger>
          </TabsList>
          {canManage && (
            <TabsContent value="permissions">
              <PermissionWorkbench subject={{ kind: 'user', id: u.id }} userRoles={u.roles} isTenantAdmin={u.isTenantAdmin} />
            </TabsContent>
          )}
          {canManage && (
            <TabsContent value="scope">
              <ScopeEditor subject={{ kind: 'user', id: u.id }} isTenantAdmin={u.isTenantAdmin} />
            </TabsContent>
          )}
          <TabsContent value="why"><EffectivePanel userId={u.id} /></TabsContent>
        </Tabs>
      </div>
    </PageBody>
  );
}

function RoleAssignment({ user, canManage }: { user: UserRow; canManage: boolean }) {
  const qc = useQueryClient();
  const { reloadMe } = useSession();
  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesApi.list });
  const initial = user.roles.map(r => r.id).sort().join(',');
  const [picked, setPicked] = useState<Set<string>>(new Set(user.roles.map(r => r.id)));
  useEffect(() => setPicked(new Set(initial ? initial.split(',') : [])), [initial]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = [...picked].sort().join(',') !== initial;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = await permissionsApi.setUserRoles(user.id, [...picked]);
      qc.setQueryData(['users', user.id], next);
      void qc.invalidateQueries({ queryKey: qk.effective(user.id) });
      void qc.invalidateQueries({ queryKey: ['roles'] });
      void reloadMe();
      toast.success(t('access.rolesSaved'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="user-roles-card">
      <CardHeader
        title={t('access.roles')}
        description={t('access.rolesHint')}
        actions={canManage && <Button size="sm" disabled={!dirty} loading={saving} onClick={() => void save()} data-testid="user-roles-save">{t('access.saveRoles')}</Button>}
      />
      <CardBody>
        {error && <InlineAlert className="mb-3">{error}</InlineAlert>}
        {roles.isLoading ? (
          <SkeletonGroup className="flex flex-wrap gap-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8 w-32" />)}</SkeletonGroup>
        ) : !roles.data?.length ? (
          <p className="text-fg-muted">{t('users.noRoles')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label={t('access.roles')}>
            {roles.data.map(r => (
              <li key={r.id}>
                <label className={`flex h-9 items-center gap-2 rounded border px-3 ${picked.has(r.id) ? 'border-accent/50 bg-accent-soft' : 'border-border'} ${canManage ? 'cursor-pointer hover:bg-subtle' : ''}`}>
                  <Checkbox
                    checked={picked.has(r.id)}
                    disabled={!canManage}
                    onCheckedChange={v => { const n = new Set(picked); if (v === true) n.add(r.id); else n.delete(r.id); setPicked(n); }}
                    data-testid={`user-role-${r.key}`}
                  />
                  {r.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

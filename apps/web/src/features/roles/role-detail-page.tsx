'use client';
import { Badge, Button, EmptyState, Skeleton, SkeletonGroup, Tabs, TabsContent, TabsList, TabsTrigger } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, SearchX } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { PermissionWorkbench } from '@/features/permissions/permission-workbench';
import { ScopeEditor } from '@/features/permissions/scope-editor';
import { rolesApi } from '@/features/users/api';
import { t } from '@/i18n';
import { perm, usePermissions } from '@/lib/permissions';
import { RoleDialog } from './roles-page';

export function RoleDetailPage({ roleId }: { roleId: string }) {
  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesApi.list });
  const p = usePermissions();
  const [editOpen, setEditOpen] = useState(false);
  const role = roles.data?.find(r => r.id === roleId);
  const canManage = p.has(perm.action('admin.roles', 'manage_permissions'));

  const back = <Link href="/roles" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden />{t('roles.title')}</Link>;

  if (roles.isLoading) {
    return <PageBody><SkeletonGroup className="space-y-4"><Skeleton className="h-4 w-20" /><Skeleton className="h-7 w-64" /><Skeleton className="h-96" /></SkeletonGroup></PageBody>;
  }
  if (roles.isError) return <PageBody><InlineAlert>{(roles.error as Error).message}</InlineAlert></PageBody>;
  if (!role) return <PageBody><EmptyState icon={<SearchX />} title={t('roles.notFound')} action={back} /></PageBody>;

  return (
    <PageBody>
      <PageHeader
        back={back}
        title={<span className="flex items-center gap-2">{role.name}{role.isSystem && <Badge>{t('roles.system')}</Badge>}</span>}
        description={role.description ?? t('roles.usersCount', { count: role.userCount ?? 0 })}
        actions={!role.isSystem && p.can('admin.roles', 'edit') && (
          <Button variant="secondary" onClick={() => setEditOpen(true)} data-testid="role-edit"><Pencil aria-hidden />{t('common.edit')}</Button>
        )}
      />
      <Tabs defaultValue="permissions">
        <TabsList>
          <TabsTrigger value="permissions" data-testid="role-tab-permissions">{t('perm.tabPermissions')}</TabsTrigger>
          <TabsTrigger value="scope" data-testid="role-tab-scope">{t('perm.tabScope')}</TabsTrigger>
        </TabsList>
        <TabsContent value="permissions">
          <PermissionWorkbench subject={{ kind: 'role', id: role.id }} readOnly={role.isSystem || !canManage} readOnlyReason={role.isSystem ? t('roles.systemReadOnly') : !canManage ? t('perm.noManage') : undefined} />
        </TabsContent>
        <TabsContent value="scope">
          <ScopeEditor subject={{ kind: 'role', id: role.id }} readOnly={role.isSystem || !canManage} />
        </TabsContent>
      </Tabs>
      {editOpen && <RoleDialog open role={role} onOpenChange={setEditOpen} />}
    </PageBody>
  );
}

'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { RoleInput, type RoleRow } from '@procure/schema';
import {
  Badge, Button, Card, Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, FormField, Input,
  Skeleton, SkeletonGroup, Table, TBody, TD, TH, THead, TR, Textarea, toast,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { roleAdminApi } from '@/features/permissions/api';
import { rolesApi } from '@/features/users/api';
import { t } from '@/i18n';
import { applyProblemToForm, isApiError } from '@/lib/api';
import { Can, perm, usePermissions } from '@/lib/permissions';

const TAB = 'admin.roles';

export function RolesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [deleting, setDeleting] = useState<RoleRow | null>(null);
  const qc = useQueryClient();
  const router = useRouter();
  const p = usePermissions();
  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesApi.list });
  const canOpen = p.hasAny(perm.action(TAB, 'manage_permissions'), perm.action(TAB, 'edit'));
  const rowActions = p.hasAny(perm.action(TAB, 'edit'), perm.action(TAB, 'delete'));

  return (
    <PageBody className="max-w-5xl">
      <PageHeader
        title={t('roles.title')}
        description={t('roles.description')}
        actions={<Can perm={perm.action(TAB, 'add')}><Button onClick={() => setCreateOpen(true)} data-testid="create-role-button"><Plus aria-hidden />{t('roles.create.button')}</Button></Can>}
      />
      <Card className="overflow-hidden">
        {roles.isLoading ? (
          <SkeletonGroup className="space-y-2 p-4">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-9" />)}</SkeletonGroup>
        ) : roles.isError ? (
          <div className="p-4"><InlineAlert>{(roles.error as Error).message}</InlineAlert></div>
        ) : !roles.data?.length ? (
          <EmptyState icon={<ShieldCheck />} title={t('roles.empty')} description={t('roles.emptyHint')} />
        ) : (
          <Table data-testid="roles-table">
            <THead>
              <TR>
                <TH>{t('roles.col.name')}</TH><TH>{t('roles.col.key')}</TH><TH className="hidden md:table-cell">{t('roles.col.description')}</TH>
                <TH className="text-right">{t('roles.col.users')}</TH>
                {rowActions && <TH className="w-12"><span className="sr-only">{t('common.actions')}</span></TH>}
              </TR>
            </THead>
            <TBody>
              {roles.data.map(r => (
                <TR key={r.id} data-testid={`role-row-${r.key}`} className={canOpen ? 'cursor-pointer hover:bg-subtle' : undefined} onClick={canOpen ? () => router.push(`/roles/${r.id}`) : undefined}>
                  <TD className="font-medium">
                    <span className="flex items-center gap-2">
                      {canOpen ? <Link href={`/roles/${r.id}`} onClick={e => e.stopPropagation()} className="text-accent hover:underline focus-visible:underline" data-testid={`role-open-${r.key}`}>{r.name}</Link> : r.name}
                      {r.isSystem && <Badge>{t('roles.system')}</Badge>}
                    </span>
                  </TD>
                  <TD className="font-mono text-sm text-fg-muted">{r.key}</TD>
                  <TD className="hidden text-fg-muted md:table-cell">{r.description ?? '—'}</TD>
                  <TD className="text-right tabular">{r.userCount ?? '—'}</TD>
                  {rowActions && (
                    <TD className="text-right" onClick={e => e.stopPropagation()}>
                      {!r.isSystem && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={t('roles.actionsFor', { name: r.name })} data-testid={`role-menu-${r.key}`}><MoreHorizontal aria-hidden /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canOpen && <DropdownMenuItem onSelect={() => router.push(`/roles/${r.id}`)}><ShieldCheck aria-hidden />{t('roles.permissions')}</DropdownMenuItem>}
                            {p.can(TAB, 'edit') && <DropdownMenuItem onSelect={() => setEditing(r)} data-testid="role-edit"><Pencil aria-hidden />{t('common.edit')}</DropdownMenuItem>}
                            {p.can(TAB, 'delete') && <DropdownMenuItem destructive onSelect={() => setDeleting(r)} data-testid="role-delete"><Trash2 aria-hidden />{t('roles.delete')}</DropdownMenuItem>}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <RoleDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={r => router.push(`/roles/${r.id}`)} />
      {editing && <RoleDialog open role={editing} onOpenChange={o => { if (!o) setEditing(null); }} />}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={o => { if (!o) setDeleting(null); }}
          title={t('roles.deleteConfirm.title', { name: deleting.name })}
          description={deleting.userCount ? t('roles.deleteConfirm.inUse', { count: deleting.userCount }) : t('roles.deleteConfirm.body')}
          confirmLabel={t('roles.delete')}
          tone="danger"
          testId="confirm-role-delete"
          onConfirm={async () => {
            try {
              await roleAdminApi.remove(deleting.id);
            } catch (e) {
              if (isApiError(e) && e.status === 409) throw new Error(t('roles.deleteBlocked'));
              throw e;
            }
            toast.success(t('roles.deleted'));
            void qc.invalidateQueries({ queryKey: ['roles'] });
          }}
        />
      )}
    </PageBody>
  );
}

/** Create (no role) or edit (role given). The key can't change after creation. */
export function RoleDialog({ open, onOpenChange, role, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; role?: RoleRow; onSaved?: (r: RoleRow) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(RoleInput), defaultValues: { key: role?.key ?? '', name: role?.name ?? '', description: role?.description ?? '' } });
  const { register, handleSubmit, setValue, getFieldState, formState: { errors, isSubmitting } } = form;

  const close = (o: boolean) => { if (!o) { form.reset(); setError(null); } onOpenChange(o); };

  const submit = handleSubmit(async v => {
    setError(null);
    try {
      const body = { ...v, description: v.description || undefined };
      const saved = role ? await roleAdminApi.update(role.id, { ...body, version: role.version }) : await rolesApi.create(body);
      toast.success(role ? t('roles.saved') : t('roles.created'));
      void qc.invalidateQueries({ queryKey: ['roles'] });
      onSaved?.(saved);
      close(false);
    } catch (e) {
      const msg = applyProblemToForm(e, form.setError, ['key', 'name', 'description']);
      if (msg) setError(msg);
    }
  });

  const nameField = register('name', {
    onChange: e => {
      if (!role && !getFieldState('key').isDirty) {
        const k = String(e.target.value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+|_+$/g, '').slice(0, 41);
        setValue('key', k);
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={role ? t('roles.edit.title') : t('roles.create.title')}
        closeLabel={t('common.close')}
        data-testid={role ? 'edit-role-dialog' : 'create-role-dialog'}
        footer={<>
          <Button variant="secondary" onClick={() => close(false)}>{t('common.cancel')}</Button>
          <Button type="submit" form="role-form" loading={isSubmitting} data-testid={role ? 'edit-role-submit' : 'create-role-submit'}>{role ? t('common.saveChanges') : t('roles.create.submit')}</Button>
        </>}
      >
        <form id="role-form" onSubmit={submit} noValidate className="space-y-4">
          {error && <InlineAlert>{error}</InlineAlert>}
          <FormField label={t('roles.field.name')} error={errors.name?.message} required>
            <Input {...nameField} data-testid="role-name" />
          </FormField>
          <FormField label={t('roles.field.key')} error={errors.key?.message} hint={t('roles.field.keyHint')} required>
            <Input className="font-mono" autoCapitalize="none" spellCheck={false} readOnly={!!role} {...register('key')} data-testid="role-key" />
          </FormField>
          <FormField label={t('roles.field.description')} error={errors.description?.message} hint={t('common.optional')}>
            <Textarea rows={3} {...register('description')} data-testid="role-description" />
          </FormField>
        </form>
      </DialogContent>
    </Dialog>
  );
}

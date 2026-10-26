'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { ErrorCode, UserUpdate, type UserRow } from '@procure/schema';
import { Badge, Button, Card, CardBody, CardHeader, Dialog, DialogContent, Sheet, SheetContent, Skeleton, SkeletonGroup, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, Power, ShieldCheck, Unlock } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useForm, type Control, type UseFormRegister } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DetailList, InlineAlert } from '@/components/page';
import { SecretReveal } from '@/components/secret-reveal';
import { isLocked, UserStatusBadge } from '@/components/status';
import { t } from '@/i18n';
import { applyProblemToForm, isApiError } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { perm, usePermissions } from '@/lib/permissions';
import { useTenantPrincipal } from '@/lib/session';
import { usersApi } from './api';
import { SessionsTable } from './sessions-table';
import { cleanOptional, UserFormFields, type UserFormShape } from './user-form-fields';
import type { FormRendererHandle } from '@/engines/form-renderer/form-renderer';
import type { ErrorMap } from '@/engines/form-renderer/validation';
import { customErrorsFrom, UserCustomFields, useUserCustomForm } from './user-custom-fields';

type Confirm = null | 'deactivate' | 'activate' | 'reset' | 'unlock' | 'forceLogout';

export function UserDetailSheet({ userId, onOpenChange, onChanged }: { userId: string | null; onOpenChange: (o: boolean) => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const me = useTenantPrincipal();
  const p = usePermissions();
  const can = (a: string) => p.has(perm.action('admin.users', a));
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const user = useQuery({ queryKey: ['users', userId], queryFn: () => usersApi.get(userId!), enabled: !!userId });
  const sessions = useQuery({ queryKey: ['users', userId, 'sessions'], queryFn: () => usersApi.sessions(userId!), enabled: !!userId && can('force_logout') });

  useEffect(() => { setEditing(false); setActionError(null); }, [userId]);

  function refresh(u?: UserRow) {
    if (u) qc.setQueryData(['users', u.id], u);
    else void qc.invalidateQueries({ queryKey: ['users', userId] });
    void qc.invalidateQueries({ queryKey: ['users', userId, 'sessions'] });
    onChanged();
  }

  const u = user.data;
  const isSelf = !!u && me?.userId === u.id;

  async function runAction(kind: Exclude<Confirm, null>) {
    if (!u) return;
    setActionError(null);
    try {
      if (kind === 'deactivate') { refresh(await usersApi.deactivate(u.id)); toast.success(t('users.deactivated')); }
      if (kind === 'activate') {
        refresh(await usersApi.activate(u.id));
        // Activation counts against max_users and can emit limit warnings (QA-BUG-005).
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        toast.success(t('users.activated'));
      }
      if (kind === 'unlock') { refresh(await usersApi.unlock(u.id)); toast.success(t('users.unlocked')); }
      if (kind === 'forceLogout') { await usersApi.forceLogout(u.id); refresh(); toast.success(t('users.forcedLogout')); }
      if (kind === 'reset') { const r = await usersApi.resetPassword(u.id); setTempPassword(r.temporaryPassword); refresh(); }
    } catch (e) {
      // Limit on re-activation is shown inline in the sheet, like on create.
      if (kind === 'activate' && isApiError(e) && e.is(ErrorCode.LIMIT_EXCEEDED)) {
        setActionError(e.message);
        return;
      }
      throw e;
    }
  }

  const confirmCopy: Record<Exclude<Confirm, null>, { title: string; body: string; cta: string; danger?: boolean }> = {
    deactivate: { title: t('users.confirm.deactivate.title'), body: t('users.confirm.deactivate.body'), cta: t('users.action.deactivate'), danger: true },
    activate: { title: t('users.confirm.activate.title'), body: t('users.confirm.activate.body'), cta: t('users.action.activate') },
    reset: { title: t('users.confirm.reset.title'), body: t('users.confirm.reset.body'), cta: t('users.action.reset') },
    unlock: { title: t('users.confirm.unlock.title'), body: t('users.confirm.unlock.body'), cta: t('users.action.unlock') },
    forceLogout: { title: t('users.confirm.forceLogout.title'), body: t('users.confirm.forceLogout.body'), cta: t('users.action.forceLogout'), danger: true },
  };

  return (
    <Sheet open={!!userId} onOpenChange={onOpenChange}>
      <SheetContent side="right" title={u?.name ?? t('users.detail')} className="max-w-xl sm:w-[36rem]" closeLabel={t('common.close')} data-testid="user-detail">
        {user.isLoading || !u ? (
          <SkeletonGroup className="space-y-4 p-4">
            <Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-64" /><Skeleton className="h-32" /><Skeleton className="h-24" />
          </SkeletonGroup>
        ) : (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <UserStatusBadge user={u} />
              {u.isTenantAdmin && <Badge tone="accent">{t('users.adminBadge')}</Badge>}
              {isSelf && <Badge>{t('users.you')}</Badge>}
            </div>

            {actionError && <InlineAlert tone="warning" data-testid="user-limit-error">{actionError}</InlineAlert>}

            <div className="flex flex-wrap gap-2">
              {isLocked(u) && can('reset_password') && <Button size="sm" variant="secondary" onClick={() => setConfirm('unlock')} data-testid="user-unlock"><Unlock aria-hidden />{t('users.action.unlock')}</Button>}
              {can('reset_password') && <Button size="sm" variant="secondary" onClick={() => setConfirm('reset')} data-testid="user-reset-password"><KeyRound aria-hidden />{t('users.action.reset')}</Button>}
              {can('force_logout') && <Button size="sm" variant="secondary" onClick={() => setConfirm('forceLogout')} disabled={isSelf} data-testid="user-force-logout"><LogOut aria-hidden />{t('users.action.forceLogout')}</Button>}
              {!can('deactivate') ? null : u.isActive ? (
                <Button size="sm" variant="danger-outline" onClick={() => setConfirm('deactivate')} disabled={isSelf} data-testid="user-deactivate"><Power aria-hidden />{t('users.action.deactivate')}</Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setConfirm('activate')} data-testid="user-activate"><Power aria-hidden />{t('users.action.activate')}</Button>
              )}
            </div>

            {(can('manage_permissions') || can('view')) && (
              <Link
                href={`/users/${u.id}/access`}
                className="flex items-center gap-3 rounded-lg border border-border bg-subtle px-4 py-3 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                data-testid="user-access-link"
              >
                <ShieldCheck className="size-5 text-accent" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{t('access.link')}</span>
                  <span className="block text-sm text-fg-muted">{t(can('manage_permissions') ? 'access.linkHint' : 'access.linkHintView')}</span>
                </span>
              </Link>
            )}

            <Card>
              <CardHeader
                title={t('users.profile')}
                actions={!editing && can('edit') && <Button size="sm" variant="ghost" onClick={() => setEditing(true)} data-testid="user-edit">{t('common.edit')}</Button>}
              />
              <CardBody>
                {editing ? (
                  <EditUserForm user={u} onCancel={() => setEditing(false)} onSaved={nu => { refresh(nu); setEditing(false); toast.success(t('users.saved')); }} />
                ) : (
                  <DetailList items={[
                    { label: t('users.field.email'), value: u.email },
                    { label: t('users.field.phone'), value: u.phone ?? '—' },
                    { label: t('users.field.roles'), value: u.roles.length ? u.roles.map(r => r.name).join(', ') : '—' },
                    { label: t('users.lastLogin'), value: u.lastLoginAt ? <span title={fmtDateTime(u.lastLoginAt)}>{fmtRelative(u.lastLoginAt)}</span> : t('users.never') },
                    ...(isLocked(u) ? [{ label: t('users.lockedUntil'), value: fmtDateTime(u.lockedUntil) }] : []),
                  ]} />
                )}
              </CardBody>
            </Card>

            {can('force_logout') && <Card>
              <CardHeader title={t('sessions.active')} />
              <CardBody className="p-0">
                <SessionsTable sessions={sessions.data} loading={sessions.isLoading} />
              </CardBody>
            </Card>}
          </div>
        )}

        {confirm && (
          <ConfirmDialog
            open
            onOpenChange={o => { if (!o) setConfirm(null); }}
            title={confirmCopy[confirm].title}
            description={confirmCopy[confirm].body}
            confirmLabel={confirmCopy[confirm].cta}
            tone={confirmCopy[confirm].danger ? 'danger' : 'primary'}
            onConfirm={() => runAction(confirm)}
            testId={`confirm-${confirm}`}
          />
        )}

        <Dialog open={!!tempPassword} onOpenChange={o => { if (!o) setTempPassword(null); }}>
          <DialogContent
            title={t('users.resetDone.title')}
            description={t('users.resetDone.body', { name: u?.name ?? '' })}
            size="sm"
            closeLabel={t('common.close')}
            footer={<Button onClick={() => setTempPassword(null)}>{t('common.done')}</Button>}
          >
            {tempPassword && <SecretReveal label={t('users.tempPassword')} value={tempPassword} />}
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

function EditUserForm({ user, onCancel, onSaved }: { user: UserRow; onCancel: () => void; onSaved: (u: UserRow) => void }) {
  const [error, setError] = useState<string | null>(null);
  // Tenant-defined fields from the `user` form (UserRow.custom per the Phase 2 contract), sent back as `custom`.
  const customForm = useUserCustomForm();
  const [custom, setCustom] = useState<Record<string, unknown>>(() => (user.custom ?? {}));
  const [customErrors, setCustomErrors] = useState<ErrorMap>({});
  const customRef = useRef<FormRendererHandle>(null);
  const form = useForm({
    resolver: zodResolver(UserUpdate),
    defaultValues: { name: user.name, phone: user.phone ?? '', isTenantAdmin: user.isTenantAdmin, roleIds: user.roles.map(r => r.id), version: user.version },
  });
  const submit = form.handleSubmit(async values => {
    setError(null);
    if (customForm.form && Object.keys(customRef.current?.validate() ?? {}).length) return;
    try {
      onSaved(await usersApi.update(user.id, { ...cleanOptional(values), ...(customForm.form ? { custom } : {}) }));
    } catch (e) {
      setCustomErrors(customErrorsFrom(e));
      const msg = applyProblemToForm(e, form.setError, ['name', 'phone', 'isTenantAdmin', 'roleIds', 'custom']);
      if (msg) setError(msg);
    }
  });
  return (
    <form onSubmit={submit} noValidate className="space-y-4" data-testid="edit-user-form">
      {error && <InlineAlert>{error}</InlineAlert>}
      <UserFormFields
        register={form.register as unknown as UseFormRegister<UserFormShape>}
        control={form.control as unknown as Control<UserFormShape>}
        errors={form.formState.errors}
        includeEmail={false}
      />
      {customForm.form && <UserCustomFields form={customForm.form} value={custom} onChange={setCustom} errors={customErrors} handleRef={customRef} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="submit" loading={form.formState.isSubmitting} data-testid="edit-user-submit">{t('common.saveChanges')}</Button>
      </div>
    </form>
  );
}

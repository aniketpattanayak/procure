'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { SubscriptionChange, SubscriptionStatus, TenantUpdate, type Entitlements, type TenantRecord } from '@procure/schema';
import {
  Badge, Button, Card, CardBody, CardHeader, Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  FormField, Input, NativeSelect, Skeleton, SkeletonGroup, StatusBadge, Table, TBody, TD, TH, THead, TR, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, toast, UsageBar,
} from '@procure/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ChevronDown, KeyRound, LogIn, Pause, Pencil, Play, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DetailList, InlineAlert, PageBody, PageHeader } from '@/components/page';
import { SecretReveal } from '@/components/secret-reveal';
import { SubscriptionBadge, TenantStatusBadge } from '@/components/status';
import { t, tMaybe } from '@/i18n';
import { applyProblemToForm } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtNumber } from '@/lib/format';
import { useSession } from '@/lib/session';
import { platformApi, type TenantDetail } from './api';
import { OverrideEditor, type OverrideTarget } from './override-editor';
import { TenantWaTemplatesPanel } from '@/features/notify/platform-wa-templates-page';

type StatusAction = 'suspend' | 'reactivate' | 'archive';

export function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { startImpersonation } = useSession();
  const detail = useQuery({ queryKey: ['platform', 'tenant', id], queryFn: () => platformApi.tenant(id) });
  const [statusAction, setStatusAction] = useState<StatusAction | null>(null);
  const [impersonateOpen, setImpersonateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['platform', 'tenant', id] });
    void qc.invalidateQueries({ queryKey: ['platform', 'tenant-history', id] });
  };

  if (detail.isLoading) {
    return (
      <PageBody>
        <SkeletonGroup className="space-y-5">
          <Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-72" />
          <div className="flex gap-2"><Skeleton className="h-9 w-24" /><Skeleton className="h-9 w-24" /><Skeleton className="h-9 w-24" /></div>
          <Skeleton className="h-64" />
        </SkeletonGroup>
      </PageBody>
    );
  }
  if (detail.isError || !detail.data) {
    return <PageBody><InlineAlert>{(detail.error as Error)?.message ?? t('error.generic')}</InlineAlert></PageBody>;
  }

  const { tenant, subscription, entitlements } = detail.data;
  const statusCopy: Record<StatusAction, { title: string; body: string; cta: string; danger: boolean }> = {
    suspend: { title: t('tenant.suspend.title', { name: tenant.name }), body: t('tenant.suspend.body'), cta: t('tenant.action.suspend'), danger: true },
    reactivate: { title: t('tenant.reactivate.title', { name: tenant.name }), body: t('tenant.reactivate.body'), cta: t('tenant.action.reactivate'), danger: false },
    archive: { title: t('tenant.archive.title', { name: tenant.name }), body: t('tenant.archive.body'), cta: t('tenant.action.archive'), danger: true },
  };

  return (
    <PageBody>
      <PageHeader
        back={<Link href="/platform/tenants" className="text-sm text-accent hover:underline">{t('tenants.back')}</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{tenant.name}<TenantStatusBadge status={tenant.status} /></span>}
        description={<span className="font-mono">{tenant.code}</span>}
        actions={<>
          <Button variant="secondary" onClick={() => setImpersonateOpen(true)} disabled={tenant.status !== 'active'} data-testid="impersonate-button">
            <LogIn aria-hidden />{t('tenant.action.impersonate')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" data-testid="tenant-actions">{t('common.actions')}<ChevronDown aria-hidden /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setResetOpen(true)} data-testid="tenant-reset-admin"><KeyRound aria-hidden />{t('tenant.action.resetAdmin')}</DropdownMenuItem>
              {tenant.status === 'active' && <DropdownMenuItem onSelect={() => setStatusAction('suspend')} data-testid="tenant-suspend"><Pause aria-hidden />{t('tenant.action.suspend')}</DropdownMenuItem>}
              {tenant.status !== 'active' && <DropdownMenuItem onSelect={() => setStatusAction('reactivate')} data-testid="tenant-reactivate"><Play aria-hidden />{t('tenant.action.reactivate')}</DropdownMenuItem>}
              {tenant.status !== 'archived' && <DropdownMenuItem destructive onSelect={() => setStatusAction('archive')} data-testid="tenant-archive"><Archive aria-hidden />{t('tenant.action.archive')}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </>}
      />

      {tenant.status !== 'active' && tenant.statusReason && (
        <InlineAlert tone="warning" className="mb-4">{t('tenant.statusReason', { reason: tenant.statusReason })}</InlineAlert>
      )}

      <Tabs defaultValue="entitlements">
        <TabsList>
          <TabsTrigger value="entitlements">{t('tenant.tab.entitlements')}</TabsTrigger>
          <TabsTrigger value="subscription">{t('tenant.tab.subscription')}</TabsTrigger>
          <TabsTrigger value="profile">{t('tenant.tab.profile')}</TabsTrigger>
          <TabsTrigger value="history">{t('tenant.tab.overrideHistory')}</TabsTrigger>
          <TabsTrigger value="whatsapp" data-testid="tenant-tab-whatsapp">{t('tenant.tab.whatsapp')}</TabsTrigger>
        </TabsList>
        <TabsContent value="entitlements"><EntitlementsPanel tenantId={id} entitlements={entitlements} onChanged={invalidate} /></TabsContent>
        <TabsContent value="subscription"><SubscriptionPanel tenantId={id} subscription={subscription} onChanged={invalidate} /></TabsContent>
        <TabsContent value="profile">
          <ProfilePanel tenantId={id} tenant={tenant} onSaved={next => qc.setQueryData<TenantDetail>(['platform', 'tenant', id], d => (d ? { ...d, tenant: next } : d))} />
          <LogoPanel tenantId={id} tenant={tenant} onSaved={next => qc.setQueryData<TenantDetail>(['platform', 'tenant', id], d => (d ? { ...d, tenant: next } : d))} />
          <DomainPanel tenantId={id} tenant={tenant} onSaved={next => qc.setQueryData<TenantDetail>(['platform', 'tenant', id], d => (d ? { ...d, tenant: next } : d))} />
        </TabsContent>
        <TabsContent value="history"><OverrideHistory tenantId={id} /></TabsContent>
        <TabsContent value="whatsapp"><TenantWaTemplatesPanel tenantId={id} /></TabsContent>
      </Tabs>

      {statusAction && (
        <ConfirmDialog
          open
          onOpenChange={o => { if (!o) setStatusAction(null); }}
          title={statusCopy[statusAction].title}
          description={statusCopy[statusAction].body}
          confirmLabel={statusCopy[statusAction].cta}
          tone={statusCopy[statusAction].danger ? 'danger' : 'primary'}
          requireReason
          testId={`tenant-${statusAction}-dialog`}
          onConfirm={async reason => {
            await platformApi.changeStatus(id, statusAction, reason);
            toast.success(t(`tenant.${statusAction}.done`));
            invalidate();
            void qc.invalidateQueries({ queryKey: ['platform', 'tenants'] });
          }}
        />
      )}

      <ConfirmDialog
        open={impersonateOpen}
        onOpenChange={setImpersonateOpen}
        title={t('impersonation.confirmTitle', { name: tenant.name })}
        description={t('impersonation.confirmBody')}
        confirmLabel={t('tenant.action.impersonate')}
        requireReason
        testId="impersonate-dialog"
        onConfirm={async reason => {
          const result = await platformApi.impersonate(id, reason);
          await startImpersonation(result, { tenantId: id, tenantName: tenant.name });
        }}
      />

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t('tenant.resetAdmin.title')}
        description={t('tenant.resetAdmin.body')}
        confirmLabel={t('tenant.action.resetAdmin')}
        testId="reset-admin-dialog"
        onConfirm={async () => { const r = await platformApi.resetAdminPassword(id); setTempPassword(r.temporaryPassword); }}
      />
      <Dialog open={!!tempPassword} onOpenChange={o => { if (!o) setTempPassword(null); }}>
        <DialogContent title={t('tenant.resetAdmin.doneTitle')} size="sm" closeLabel={t('common.close')} footer={<Button onClick={() => setTempPassword(null)}>{t('common.done')}</Button>}>
          {tempPassword && <SecretReveal label={t('users.tempPassword')} value={tempPassword} />}
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}

// ---------------------------------------------------------------------------

function sourceBadge(source: 'plan' | 'override' | 'none') {
  if (source === 'override') return <Badge tone="warning">{t('entitlement.source.override')}</Badge>;
  if (source === 'plan') return <Badge>{t('entitlement.source.plan')}</Badge>;
  return <span className="text-fg-subtle">—</span>;
}

function EntitlementsPanel({ tenantId, entitlements, onChanged }: { tenantId: string; entitlements: Entitlements; onChanged: () => void }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<OverrideTarget | null>(null);
  const save = async (body: unknown) => {
    const next = await platformApi.setOverride(tenantId, body);
    qc.setQueryData<TenantDetail>(['platform', 'tenant', tenantId], d => (d ? { ...d, entitlements: next } : d));
    toast.success(t('override.saved'));
    onChanged();
  };
  return (
    <div className="space-y-4" data-testid="entitlements">
      <Card className="overflow-hidden">
        <CardHeader title={t('entitlement.limits')} description={t('entitlement.limitsHint')} />
        <Table data-testid="entitlements-limits">
          <THead><TR>
            <TH>{t('entitlement.col.limit')}</TH>
            <TH className="text-right">{t('entitlement.col.plan')}</TH>
            <TH className="text-right">{t('entitlement.col.override')}</TH>
            <TH className="min-w-40">{t('entitlement.col.usage')}</TH>
            <TH><span className="sr-only">{t('common.actions')}</span></TH>
          </TR></THead>
          <TBody>
            {entitlements.limits.map(l => (
              <TR key={l.key} data-testid={`limit-row-${l.key}`}>
                <TD><p className="font-medium">{l.name}</p><p className="text-sm text-fg-muted">{tMaybe(`meter.${l.meter}`, l.meter)}</p></TD>
                <TD className="text-right tabular">{l.planValue === null ? t('usage.unlimited') : fmtNumber(l.planValue)}</TD>
                <TD className="text-right tabular">{l.override === undefined ? <span className="text-fg-subtle">—</span> : <Badge tone="warning">{l.override === null ? t('usage.unlimited') : fmtNumber(l.override)}</Badge>}</TD>
                <TD>
                  <div className="space-y-1">
                    <p className="text-sm tabular">{fmtNumber(l.used)} / {l.effective === null ? t('usage.unlimited') : fmtNumber(l.effective)}</p>
                    <UsageBar used={l.used} max={l.effective} label={l.name} />
                  </div>
                </TD>
                <TD className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => setTarget({ kind: 'limit', row: l })} aria-label={t('override.editFor', { name: l.name })} data-testid={`override-edit-${l.key}`}>
                    <Pencil aria-hidden />{t('override.edit')}
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title={t('entitlement.features')} description={t('entitlement.featuresHint')} />
        <Table data-testid="entitlements-features">
          <THead><TR><TH>{t('entitlement.col.feature')}</TH><TH>{t('entitlement.col.state')}</TH><TH>{t('entitlement.col.source')}</TH><TH><span className="sr-only">{t('common.actions')}</span></TH></TR></THead>
          <TBody>
            {entitlements.features.map(f => (
              <TR key={f.key} data-testid={`feature-row-${f.key}`}>
                <TD className="font-medium">{f.name}</TD>
                <TD>{f.enabled ? <StatusBadge tone="success">{t('entitlement.on')}</StatusBadge> : <StatusBadge>{t('entitlement.off')}</StatusBadge>}</TD>
                <TD>{sourceBadge(f.source)}</TD>
                <TD className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => setTarget({ kind: 'feature', row: f })} aria-label={t('override.editFor', { name: f.name })} data-testid={`override-edit-${f.key}`}>
                    <Pencil aria-hidden />{t('override.edit')}
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <OverrideEditor target={target} onClose={() => setTarget(null)} onSave={save} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function SubscriptionPanel({ tenantId, subscription, onChanged }: { tenantId: string; subscription: TenantDetail['subscription']; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const history = useQuery({ queryKey: ['platform', 'tenant-history', tenantId, 'subs'], queryFn: () => platformApi.subscriptions(tenantId) });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('subscription.current')} actions={<Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="change-subscription">{t('subscription.change')}</Button>} />
        <CardBody>
          {subscription ? (
            <DetailList items={[
              { label: t('subscription.plan'), value: subscription.planName ?? '—' },
              { label: t('subscription.status'), value: <SubscriptionBadge status={subscription.status} /> },
              { label: t('subscription.since'), value: fmtDate(subscription.effectiveFrom ?? subscription.startDate) },
              { label: t('subscription.renewal'), value: fmtDate(subscription.renewalDate) },
            ]} />
          ) : <p className="text-fg-muted">{t('subscription.none')}</p>}
        </CardBody>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title={t('subscription.history')} />
        {history.isLoading ? (
          <SkeletonGroup className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</SkeletonGroup>
        ) : !history.data?.length ? (
          <p className="p-5 text-fg-muted">{t('subscription.noHistory')}</p>
        ) : (
          <Table>
            <THead><TR><TH>{t('subscription.plan')}</TH><TH>{t('subscription.status')}</TH><TH>{t('subscription.from')}</TH><TH>{t('subscription.to')}</TH><TH>{t('common.reason')}</TH></TR></THead>
            <TBody>
              {history.data.map((s, i) => (
                <TR key={s.id ?? i}>
                  <TD className="font-medium">{s.planName ?? '—'}</TD>
                  <TD><SubscriptionBadge status={s.status} /></TD>
                  <TD className="text-fg-muted">{fmtDate(s.effectiveFrom ?? s.startDate)}</TD>
                  <TD className="text-fg-muted">{s.effectiveTo ? fmtDate(s.effectiveTo) : t('subscription.current')}</TD>
                  <TD className="max-w-xs truncate text-fg-muted" title={s.changeReason ?? undefined}>{s.changeReason ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <ChangeSubscriptionDialog open={open} onOpenChange={setOpen} tenantId={tenantId} current={subscription} onChanged={onChanged} />
    </div>
  );
}

function ChangeSubscriptionDialog({ open, onOpenChange, tenantId, current, onChanged }: { open: boolean; onOpenChange: (o: boolean) => void; tenantId: string; current: TenantDetail['subscription']; onChanged: () => void }) {
  const plans = useQuery({ queryKey: ['platform', 'plans'], queryFn: platformApi.plans, enabled: open });
  const [error, setError] = useState<string | null>(null);
  type V = z.input<typeof SubscriptionChange>;
  const form = useForm<V>({
    resolver: async (v, c, o) => zodResolver(SubscriptionChange)({ ...v, renewalDate: v.renewalDate || undefined, effectiveFrom: undefined }, c, o),
    values: { planId: current?.planId ?? '', status: current?.status ?? 'active', renewalDate: current?.renewalDate?.slice(0, 10) ?? '', reason: '' },
  });
  const { register, handleSubmit, formState: { errors, isSubmitting } } = form;
  const submit = handleSubmit(async v => {
    setError(null);
    try {
      await platformApi.changeSubscription(tenantId, v);
      toast.success(t('subscription.changed'));
      onChanged();
      onOpenChange(false);
    } catch (e) {
      const msg = applyProblemToForm(e, form.setError, ['planId', 'status', 'renewalDate', 'reason']);
      if (msg) setError(msg);
    }
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) setError(null); onOpenChange(o); }}>
      <DialogContent
        title={t('subscription.change')}
        description={t('subscription.changeHint')}
        closeLabel={t('common.close')}
        data-testid="subscription-dialog"
        footer={<>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button type="submit" form="sub-form" loading={isSubmitting} data-testid="subscription-save">{t('subscription.save')}</Button>
        </>}
      >
        <form id="sub-form" onSubmit={submit} noValidate className="space-y-4">
          {error && <InlineAlert>{error}</InlineAlert>}
          <FormField label={t('subscription.plan')} error={errors.planId ? t('wizard.pickPlan') : undefined} required>
            {plans.isLoading ? <Skeleton className="h-9" /> : (
              <NativeSelect {...register('planId')}>
                <option value="">{t('wizard.selectPlan')}</option>
                {plans.data?.map(p => <option key={p.id} value={p.id}>{p.name}{p.isActive ? '' : ` (${t('plans.inactive')})`}</option>)}
              </NativeSelect>
            )}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('subscription.status')} error={errors.status?.message} required>
              <NativeSelect {...register('status')}>
                {SubscriptionStatus.options.map(s => <option key={s} value={s}>{tMaybe(`subStatus.${s}`, s)}</option>)}
              </NativeSelect>
            </FormField>
            <FormField label={t('subscription.renewal')} error={errors.renewalDate?.message}>
              <Input type="date" {...register('renewalDate')} />
            </FormField>
          </div>
          <FormField label={t('common.reason')} error={errors.reason?.message} required>
            <Textarea rows={3} {...register('reason')} data-testid="subscription-reason" />
          </FormField>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

/* ---- Logo upload panel ---- */
function LogoPanel({ tenantId, tenant, onSaved }: { tenantId: string; tenant: TenantRecord; onSaved: (t: TenantRecord) => void }) {
  const [url, setUrl] = useState(tenant.logoUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (logoUrl: string | null) => {
    setBusy(true); setError(null);
    try {
      const updated = await platformApi.setLogoUrl(tenantId, logoUrl);
      onSaved(updated);
      toast.success(logoUrl ? 'Logo updated' : 'Logo removed');
      if (logoUrl) setUrl(logoUrl);
      else setUrl('');
    } catch { setError('Failed to save logo'); }
    finally { setBusy(false); }
  };

  return (
    <Card className="mt-4">
      <CardHeader title="Company Logo" />
      <CardBody className="space-y-3">
        {error && <InlineAlert>{error}</InlineAlert>}
        {tenant.logoUrl && (
          <div className="flex items-center gap-3">
            <img src={tenant.logoUrl} alt="Logo" className="h-12 max-w-[160px] rounded border border-border object-contain p-1" />
            <Button size="sm" variant="ghost" onClick={() => save(null)} disabled={busy}>
              <X aria-hidden className="size-3.5" /> Remove
            </Button>
          </div>
        )}
        <p className="text-xs text-fg-subtle">Paste a public image URL (PNG/SVG, hosted on your server or CDN)</p>
        <div className="flex gap-2">
          <Input
            placeholder="https://example.com/logo.png"
            value={url}
            onChange={e => setUrl(e.target.value)}
            className="flex-1"
          />
          <Button size="sm" onClick={() => save(url || null)} disabled={busy || !url.trim()} loading={busy}>
            <Upload aria-hidden className="size-3.5" /> Save
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/* ---- Domain management panel ---- */
function DomainPanel({ tenantId, tenant, onSaved }: { tenantId: string; tenant: TenantRecord; onSaved: (t: TenantRecord) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const togglePermission = async () => {
    setBusy(true); setError(null);
    try {
      const updated = await platformApi.setDomainPermission(tenantId, !tenant.allowCustomDomain);
      onSaved(updated);
      toast.success(tenant.allowCustomDomain ? 'Custom domain permission revoked' : 'Custom domain permission granted');
    } catch { setError('Failed to update permission'); }
    finally { setBusy(false); }
  };

  const baseDomain = process.env.NEXT_PUBLIC_BASE_DOMAIN ?? 'ourdomain.com';

  return (
    <Card className="mt-4">
      <CardHeader title="Domain Settings" />
      <CardBody className="space-y-4">
        {error && <InlineAlert>{error}</InlineAlert>}
        <div className="space-y-1">
          <p className="text-sm font-medium">Platform subdomain</p>
          <p className="rounded bg-bg-subtle px-3 py-2 font-mono text-sm text-fg-muted">
            {tenant.code}.{baseDomain}
          </p>
          <p className="text-xs text-fg-subtle">This subdomain is always active. Users can log in here and the company code is pre-filled automatically.</p>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Custom domain permission</p>
              <p className="text-xs text-fg-subtle">Allow this company to set their own domain (e.g. procure.arv.com)</p>
            </div>
            <Button
              size="sm"
              variant={tenant.allowCustomDomain ? 'primary' : 'secondary'}
              onClick={togglePermission}
              disabled={busy}
              loading={busy}
            >
              {tenant.allowCustomDomain ? 'Permitted ✓' : 'Grant permission'}
            </Button>
          </div>
          {tenant.customDomain && (
            <div className="rounded border border-border bg-bg-subtle px-3 py-2">
              <p className="text-xs text-fg-subtle">Custom domain set by company:</p>
              <p className="font-mono text-sm">{tenant.customDomain}</p>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function ProfilePanel({ tenantId, tenant, onSaved }: { tenantId: string; tenant: TenantRecord; onSaved: (t: TenantRecord) => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type V = z.input<typeof TenantUpdate>;
  const defaults: V = {
    name: tenant.name, legalName: tenant.legalName ?? '', timezone: tenant.timezone, currency: tenant.currency, fyStartMonth: tenant.fyStartMonth,
    taxIds: { gstin: tenant.taxIds?.gstin ?? '', pan: tenant.taxIds?.pan ?? '' },
    address: { line1: tenant.address?.line1 ?? '', city: tenant.address?.city ?? '', state: tenant.address?.state ?? '', postalCode: tenant.address?.postalCode ?? '', country: tenant.address?.country ?? 'IN' },
    version: tenant.version,
  };
  const clean = (v: V): V => JSON.parse(JSON.stringify(v, (_k, val) => (val === '' ? undefined : val)));
  const form = useForm<V>({ resolver: async (v, c, o) => zodResolver(TenantUpdate)(clean(v), c, o), values: defaults });
  const { register, handleSubmit, formState: { errors, isSubmitting } } = form;
  const save = useMutation({ mutationFn: (v: V) => platformApi.updateTenant(tenantId, clean(v)) });

  const submit = handleSubmit(async v => {
    setError(null);
    try {
      onSaved(await save.mutateAsync(v));
      toast.success(t('tenant.saved'));
      setEditing(false);
    } catch (e) {
      const msg = applyProblemToForm(e, form.setError);
      if (msg) setError(msg);
    }
  });

  return (
    <Card>
      <CardHeader title={t('tenant.tab.profile')} actions={!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)} data-testid="tenant-edit">{t('common.edit')}</Button>} />
      <CardBody>
        {!editing ? (
          <DetailList items={[
            { label: t('tenant.field.name'), value: tenant.name },
            { label: t('tenant.field.legalName'), value: tenant.legalName || '—' },
            { label: t('tenant.field.gstin'), value: tenant.taxIds?.gstin || '—' },
            { label: t('tenant.field.pan'), value: tenant.taxIds?.pan || '—' },
            { label: t('tenant.field.address'), value: [tenant.address?.line1, tenant.address?.city, tenant.address?.state, tenant.address?.postalCode].filter(Boolean).join(', ') || '—' },
            { label: t('tenant.field.timezone'), value: tenant.timezone },
            { label: t('tenant.field.currency'), value: tenant.currency },
            { label: t('tenant.field.fyStart'), value: new Intl.DateTimeFormat('en', { month: 'long' }).format(new Date(2000, tenant.fyStartMonth - 1, 1)) },
            ...(tenant.createdAt ? [{ label: t('tenants.col.created'), value: fmtDateTime(tenant.createdAt) }] : []),
          ]} />
        ) : (
          <form onSubmit={submit} noValidate className="space-y-4" data-testid="tenant-profile-form">
            {error && <InlineAlert>{error}</InlineAlert>}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('tenant.field.name')} error={errors.name?.message} required><Input {...register('name')} /></FormField>
              <FormField label={t('tenant.field.legalName')} error={errors.legalName?.message}><Input {...register('legalName')} /></FormField>
              <FormField label={t('tenant.field.gstin')} error={errors.taxIds?.gstin?.message}><Input className="uppercase" {...register('taxIds.gstin')} /></FormField>
              <FormField label={t('tenant.field.pan')} error={errors.taxIds?.pan?.message}><Input className="uppercase" {...register('taxIds.pan')} /></FormField>
              <FormField label={t('tenant.field.line1')} error={errors.address?.line1?.message} className="sm:col-span-2"><Input {...register('address.line1')} /></FormField>
              <FormField label={t('tenant.field.city')} error={errors.address?.city?.message}><Input {...register('address.city')} /></FormField>
              <FormField label={t('tenant.field.state')} error={errors.address?.state?.message}><Input {...register('address.state')} /></FormField>
              <FormField label={t('tenant.field.postalCode')} error={errors.address?.postalCode?.message}><Input {...register('address.postalCode')} /></FormField>
              <FormField label={t('tenant.field.timezone')} error={errors.timezone?.message}><Input {...register('timezone')} /></FormField>
              <FormField label={t('tenant.field.currency')} error={errors.currency?.message}><Input className="uppercase" maxLength={3} {...register('currency')} /></FormField>
              <FormField label={t('tenant.field.fyStart')} error={errors.fyStartMonth?.message}>
                <NativeSelect {...register('fyStartMonth', { valueAsNumber: true })}>
                  {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Intl.DateTimeFormat('en', { month: 'long' }).format(new Date(2000, i, 1))}</option>)}
                </NativeSelect>
              </FormField>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => { form.reset(defaults); setEditing(false); setError(null); }}>{t('common.cancel')}</Button>
              <Button type="submit" loading={isSubmitting} data-testid="tenant-profile-save">{t('common.saveChanges')}</Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function fmtOverrideValue(v: unknown) {
  if (v === undefined) return '—';
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v; } }
  if (v === null) return t('usage.unlimited');
  if (typeof v === 'boolean') return v ? t('entitlement.on') : t('entitlement.off');
  return String(v);
}

function OverrideHistory({ tenantId }: { tenantId: string }) {
  const q = useQuery({ queryKey: ['platform', 'tenant-history', tenantId, 'overrides'], queryFn: () => platformApi.overrideHistory(tenantId) });
  return (
    <Card className="overflow-hidden" data-testid="override-history">
      <CardHeader title={t('tenant.tab.overrideHistory')} />
      {q.isLoading ? (
        <SkeletonGroup className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</SkeletonGroup>
      ) : !q.data?.length ? (
        <p className="p-5 text-fg-muted">{t('override.noHistory')}</p>
      ) : (
        <Table>
          <THead><TR><TH>{t('override.col.when')}</TH><TH>{t('override.col.item')}</TH><TH>{t('override.col.change')}</TH><TH>{t('common.reason')}</TH><TH>{t('override.col.by')}</TH></TR></THead>
          <TBody>
            {q.data.map(h => (
              <TR key={h.id}>
                <TD className="whitespace-nowrap text-fg-muted">{fmtDateTime(h.changedAt)}</TD>
                <TD><span className="font-mono text-sm">{h.key}</span> <Badge>{tMaybe(`override.kind.${h.kind}`, h.kind)}</Badge></TD>
                <TD className="whitespace-nowrap">
                  {h.kind === 'feature' && h.newValue === null ? t('override.removed') : <>{h.oldValue === null ? t('override.none') : fmtOverrideValue(h.oldValue)} → {fmtOverrideValue(h.newValue)}</>}
                </TD>
                <TD className="max-w-xs text-fg-muted">{h.reason}</TD>
                <TD className="text-fg-muted">{h.changedByName ?? '—'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

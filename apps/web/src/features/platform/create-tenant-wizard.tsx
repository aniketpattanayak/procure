'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { SubscriptionStatus, TenantCreate, type Plan } from '@procure/schema';
import { Button, Card, CardBody, cn, FormField, Input, NativeSelect, Skeleton } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm, useWatch, type FieldPath } from 'react-hook-form';
import type { z } from 'zod';
import { DetailList, InlineAlert, PageBody, PageHeader } from '@/components/page';
import { SecretReveal } from '@/components/secret-reveal';
import { t, tMaybe, type MessageKey } from '@/i18n';
import { applyProblemToForm } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { platformApi } from './api';

type Input = z.input<typeof TenantCreate>;

const STEPS: { key: MessageKey; fields: FieldPath<Input>[] }[] = [
  { key: 'wizard.step.profile', fields: ['code', 'name', 'legalName', 'taxIds.gstin', 'taxIds.pan', 'address.city', 'address.state', 'address.postalCode', 'timezone', 'currency', 'fyStartMonth'] },
  { key: 'wizard.step.plan', fields: ['planId', 'subscription.status', 'subscription.startDate', 'subscription.renewalDate'] },
  { key: 'wizard.step.admin', fields: ['admin.name', 'admin.email'] },
  { key: 'wizard.step.review', fields: [] },
];

const MONTHS = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat('en', { month: 'long' }).format(new Date(2000, i, 1)));
const today = () => new Date().toISOString().slice(0, 10);

/** Drop empty strings recursively so optional fields validate as absent. */
function prune<T>(v: T): T {
  if (Array.isArray(v)) return v.map(prune) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === '' || val === undefined) continue;
      out[k] = prune(val);
    }
    return out as T;
  }
  return v;
}

export function CreateTenantWizard() {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ tenantId: string; adminEmail: string; temporaryPassword: string } | null>(null);
  const plans = useQuery({ queryKey: ['platform', 'plans'], queryFn: platformApi.plans });

  const form = useForm<Input>({
    resolver: async (values, ctx, opts) => zodResolver(TenantCreate)(prune(values), ctx, opts),
    mode: 'onTouched',
    defaultValues: {
      code: '', name: '', legalName: '', taxIds: { gstin: '', pan: '' }, address: { city: '', state: '', postalCode: '', country: 'IN' },
      timezone: 'Asia/Kolkata', currency: 'INR', fyStartMonth: 4,
      planId: '', subscription: { status: 'trial', startDate: today(), renewalDate: '' },
      admin: { name: '', email: '' },
    },
  });
  const { register, trigger, formState: { errors, isSubmitting }, handleSubmit, control } = form;
  const values = useWatch({ control });
  const plan = plans.data?.find(p => p.id === values.planId);

  async function next() {
    const ok = await trigger(STEPS[step]!.fields);
    if (ok) setStep(s => Math.min(s + 1, STEPS.length - 1));
  }

  const submit = handleSubmit(async v => {
    setError(null);
    try {
      setDone(await platformApi.createTenant(prune(v)));
    } catch (e) {
      const msg = applyProblemToForm(e, form.setError);
      setError(msg ?? t('wizard.fixErrors'));
      // Jump back to the first step that has a server-side field error.
      const firstBad = STEPS.findIndex(s => s.fields.some(f => form.getFieldState(f).error));
      if (firstBad >= 0) setStep(firstBad);
    }
  });

  if (done) {
    return (
      <PageBody className="max-w-2xl">
        <PageHeader title={t('wizard.done.title')} description={t('wizard.done.body', { email: done.adminEmail })} />
        <Card>
          <CardBody className="space-y-5">
            <SecretReveal label={t('wizard.done.password')} value={done.temporaryPassword} note={t('wizard.done.note')} />
            <div className="flex flex-wrap gap-2">
              <Button asChild data-testid="wizard-open-tenant"><Link href={`/platform/tenants/${done.tenantId}`}>{t('wizard.done.open')}</Link></Button>
              <Button asChild variant="secondary"><Link href="/platform/tenants">{t('wizard.done.back')}</Link></Button>
            </div>
          </CardBody>
        </Card>
      </PageBody>
    );
  }

  return (
    <PageBody className="max-w-3xl">
      <PageHeader title={t('wizard.title')} back={<Link href="/platform/tenants" className="text-sm text-accent hover:underline">{t('tenants.back')}</Link>} />

      <ol className="mb-5 grid grid-cols-4 gap-2" aria-label={t('wizard.progress')}>
        {STEPS.map((s, i) => (
          <li key={s.key} aria-current={i === step ? 'step' : undefined} className="min-w-0">
            <div className={cn('mb-2 h-1 rounded-full', i <= step ? 'bg-accent' : 'bg-muted')} />
            <p className={cn('flex items-center gap-1.5 truncate text-sm', i === step ? 'font-medium text-fg' : 'text-fg-muted')}>
              {i < step ? <Check className="size-3.5 shrink-0 text-accent" aria-hidden /> : <span className="tabular" aria-hidden>{i + 1}.</span>}
              <span className="truncate">{t(s.key)}</span>
              {i < step && <span className="sr-only">({t('wizard.complete')})</span>}
            </p>
          </li>
        ))}
      </ol>

      <Card>
        <form onSubmit={e => { e.preventDefault(); if (step === STEPS.length - 1) void submit(e); else void next(); }} noValidate data-testid="create-tenant-wizard">
          <CardBody className="space-y-4">
            {error && <InlineAlert>{error}</InlineAlert>}

            {step === 0 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label={t('tenant.field.code')} error={errors.code?.message} hint={t('tenant.field.codeHint')} required>
                  <Input className="font-mono" autoCapitalize="none" spellCheck={false} {...register('code')} data-testid="tenant-code" />
                </FormField>
                <FormField label={t('tenant.field.name')} error={errors.name?.message} required>
                  <Input {...register('name')} data-testid="tenant-name" />
                </FormField>
                <FormField label={t('tenant.field.legalName')} error={errors.legalName?.message} className="sm:col-span-2">
                  <Input {...register('legalName')} />
                </FormField>
                <FormField label={t('tenant.field.gstin')} error={errors.taxIds?.gstin?.message}>
                  <Input className="uppercase" {...register('taxIds.gstin')} />
                </FormField>
                <FormField label={t('tenant.field.pan')} error={errors.taxIds?.pan?.message}>
                  <Input className="uppercase" {...register('taxIds.pan')} />
                </FormField>
                <FormField label={t('tenant.field.city')} error={errors.address?.city?.message}>
                  <Input {...register('address.city')} />
                </FormField>
                <FormField label={t('tenant.field.state')} error={errors.address?.state?.message}>
                  <Input {...register('address.state')} />
                </FormField>
                <FormField label={t('tenant.field.timezone')} error={errors.timezone?.message}>
                  <Input {...register('timezone')} />
                </FormField>
                <FormField label={t('tenant.field.currency')} error={errors.currency?.message}>
                  <Input className="uppercase" maxLength={3} {...register('currency')} />
                </FormField>
                <FormField label={t('tenant.field.fyStart')} error={errors.fyStartMonth?.message}>
                  <NativeSelect {...register('fyStartMonth', { valueAsNumber: true })}>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </NativeSelect>
                </FormField>
              </div>
            )}

            {step === 1 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label={t('tenant.field.plan')} error={errors.planId?.message ? t('wizard.pickPlan') : undefined} required className="sm:col-span-2">
                  {plans.isLoading ? <Skeleton className="h-9" /> : (
                    <NativeSelect {...register('planId')} data-testid="tenant-plan">
                      <option value="">{t('wizard.selectPlan')}</option>
                      {plans.data?.filter(p => p.isActive).map(p => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(p.price, p.currency)} / {tMaybe(`cycle.${p.billingCycle}`, p.billingCycle)}</option>)}
                    </NativeSelect>
                  )}
                </FormField>
                {plan && <PlanSummary plan={plan} />}
                <FormField label={t('tenant.field.subStatus')} error={errors.subscription?.status?.message} required>
                  <NativeSelect {...register('subscription.status')} data-testid="tenant-sub-status">
                    {SubscriptionStatus.options.map(s => <option key={s} value={s}>{tMaybe(`subStatus.${s}`, s)}</option>)}
                  </NativeSelect>
                </FormField>
                <FormField label={t('tenant.field.startDate')} error={errors.subscription?.startDate?.message} required>
                  <Input type="date" {...register('subscription.startDate')} />
                </FormField>
                <FormField label={t('tenant.field.renewalDate')} error={errors.subscription?.renewalDate?.message} hint={t('common.optional')}>
                  <Input type="date" {...register('subscription.renewalDate')} />
                </FormField>
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <p className="text-fg-muted sm:col-span-2">{t('wizard.adminHint')}</p>
                <FormField label={t('tenant.field.adminName')} error={errors.admin?.name?.message} required>
                  <Input {...register('admin.name')} data-testid="tenant-admin-name" />
                </FormField>
                <FormField label={t('tenant.field.adminEmail')} error={errors.admin?.email?.message} required>
                  <Input type="email" {...register('admin.email')} data-testid="tenant-admin-email" />
                </FormField>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-5">
                <section>
                  <h2 className="mb-2 font-semibold">{t('wizard.step.profile')}</h2>
                  <DetailList items={[
                    { label: t('tenant.field.code'), value: <span className="font-mono">{values.code}</span> },
                    { label: t('tenant.field.name'), value: values.name },
                    { label: t('tenant.field.legalName'), value: values.legalName || '—' },
                    { label: t('tenant.field.gstin'), value: values.taxIds?.gstin || '—' },
                  ]} />
                </section>
                <section>
                  <h2 className="mb-2 font-semibold">{t('wizard.step.plan')}</h2>
                  <DetailList items={[
                    { label: t('tenant.field.plan'), value: plan?.name ?? '—' },
                    { label: t('tenant.field.subStatus'), value: tMaybe(`subStatus.${values.subscription?.status}`, values.subscription?.status ?? '') },
                    { label: t('tenant.field.startDate'), value: values.subscription?.startDate },
                    { label: t('tenant.field.renewalDate'), value: values.subscription?.renewalDate || '—' },
                  ]} />
                </section>
                <section>
                  <h2 className="mb-2 font-semibold">{t('wizard.step.admin')}</h2>
                  <DetailList items={[
                    { label: t('tenant.field.adminName'), value: values.admin?.name },
                    { label: t('tenant.field.adminEmail'), value: values.admin?.email },
                  ]} />
                </section>
                <InlineAlert tone="info">{t('wizard.reviewNote')}</InlineAlert>
              </div>
            )}
          </CardBody>
          <div className="flex justify-between gap-2 border-t border-border px-5 py-3">
            <Button variant="secondary" onClick={() => setStep(s => s - 1)} disabled={step === 0}>{t('common.back')}</Button>
            {step < STEPS.length - 1 ? (
              <Button type="submit" data-testid="wizard-next">{t('common.continue')}</Button>
            ) : (
              <Button type="submit" loading={isSubmitting} data-testid="wizard-submit">{t('wizard.submit')}</Button>
            )}
          </div>
        </form>
      </Card>
    </PageBody>
  );
}

function PlanSummary({ plan }: { plan: Plan }) {
  const users = plan.limits.max_users;
  return (
    <div className="rounded border border-border bg-subtle px-3 py-2.5 text-sm sm:col-span-2">
      <p className="font-medium">{plan.name}</p>
      {plan.description && <p className="text-fg-muted">{plan.description}</p>}
      <p className="mt-1 text-fg-muted">
        {t('wizard.planFacts', { features: plan.features.length, users: users === null ? t('usage.unlimited') : (users ?? 0), trial: plan.trialDays })}
      </p>
    </div>
  );
}

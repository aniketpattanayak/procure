'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { BillingCycle, PlanInput, type FeatureCatalogRow, type LimitCatalogRow, type Plan } from '@procure/schema';
import { Button, Card, CardBody, CardHeader, Checkbox, FormField, Input, Label, NativeSelect, Skeleton, SkeletonGroup, Switch, Textarea, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch, type Control } from 'react-hook-form';
import type { z } from 'zod';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { t, tMaybe } from '@/i18n';
import { applyProblemToForm } from '@/lib/api';
import { platformApi } from './api';

type V = z.input<typeof PlanInput>;
const KINDS: FeatureCatalogRow['kind'][] = ['module', 'capability', 'channel'];

export function PlanEditorPage() {
  const params = useParams<{ id?: string }>();
  const id = params.id && params.id !== 'new' ? params.id : null;
  const catalog = useQuery({ queryKey: ['platform', 'catalog'], queryFn: platformApi.catalog, staleTime: 10 * 60_000 });
  const plans = useQuery({ queryKey: ['platform', 'plans'], queryFn: platformApi.plans, enabled: !!id });
  const plan = id ? plans.data?.find(p => p.id === id) : undefined;

  const loading = catalog.isLoading || (!!id && plans.isLoading);
  if (loading) {
    return <PageBody className="max-w-4xl"><SkeletonGroup className="space-y-4"><Skeleton className="h-8 w-60" /><Skeleton className="h-48" /><Skeleton className="h-64" /></SkeletonGroup></PageBody>;
  }
  if (catalog.isError) return <PageBody><InlineAlert>{(catalog.error as Error).message}</InlineAlert></PageBody>;
  if (id && !plan) return <PageBody><InlineAlert>{t('plans.notFound')}</InlineAlert></PageBody>;
  return <PlanForm plan={plan} features={catalog.data!.features} limits={catalog.data!.limits} />;
}

function PlanForm({ plan, features, limits }: { plan?: Plan; features: FeatureCatalogRow[]; limits: LimitCatalogRow[] }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<V>({
    resolver: zodResolver(PlanInput),
    defaultValues: plan
      ? { code: plan.code, name: plan.name, description: plan.description ?? '', price: plan.price, currency: plan.currency, billingCycle: plan.billingCycle, trialDays: plan.trialDays, isActive: plan.isActive, features: plan.features, limits: { ...Object.fromEntries(limits.map(l => [l.key, 0])), ...plan.limits } }
      : { code: '', name: '', description: '', price: 0, currency: 'INR', billingCycle: 'monthly', trialDays: 0, isActive: true, features: [], limits: Object.fromEntries(limits.map(l => [l.key, 0])) },
  });
  const { register, handleSubmit, control, formState: { errors, isSubmitting } } = form;

  const grouped = useMemo(() => KINDS.map(k => ({ kind: k, items: features.filter(f => f.kind === k).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) })).filter(g => g.items.length), [features]);

  const submit = handleSubmit(async v => {
    setError(null);
    const body = { ...v, description: v.description || undefined };
    try {
      if (plan) await platformApi.updatePlan(plan.id, { ...body, version: plan.version });
      else await platformApi.createPlan(body);
      toast.success(plan ? t('plans.saved') : t('plans.created'));
      await qc.invalidateQueries({ queryKey: ['platform', 'plans'] });
      router.push('/platform/plans');
    } catch (e) {
      const msg = applyProblemToForm(e, form.setError);
      if (msg) setError(msg);
    }
  });

  return (
    <PageBody className="max-w-4xl">
      <PageHeader back={<Link href="/platform/plans" className="text-sm text-accent hover:underline">{t('plans.back')}</Link>} title={plan ? t('plans.editTitle', { name: plan.name }) : t('plans.newTitle')} description={plan && plan.tenantCount > 0 ? t('plans.editWarning', { n: plan.tenantCount }) : undefined} />
      <form onSubmit={submit} noValidate className="space-y-4" data-testid="plan-form">
        {error && <InlineAlert>{error}</InlineAlert>}
        <Card>
          <CardHeader title={t('plans.section.details')} />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('plans.field.name')} error={errors.name?.message} required><Input {...register('name')} data-testid="plan-name" /></FormField>
            <FormField label={t('plans.field.code')} error={errors.code?.message} required hint={t('plans.field.codeHint')}><Input className="font-mono" autoCapitalize="none" {...register('code')} data-testid="plan-code" /></FormField>
            <FormField label={t('plans.field.description')} error={errors.description?.message} className="sm:col-span-2"><Textarea rows={2} {...register('description')} /></FormField>
            <FormField label={t('plans.field.price')} error={errors.price?.message} required><Input type="number" min={0} step="0.01" {...register('price', { valueAsNumber: true })} data-testid="plan-price" /></FormField>
            <FormField label={t('plans.field.currency')} error={errors.currency?.message}><Input className="uppercase" maxLength={3} {...register('currency')} /></FormField>
            <FormField label={t('plans.field.cycle')} error={errors.billingCycle?.message}>
              <NativeSelect {...register('billingCycle')}>{BillingCycle.options.map(c => <option key={c} value={c}>{tMaybe(`cycle.${c}`, c)}</option>)}</NativeSelect>
            </FormField>
            <FormField label={t('plans.field.trialDays')} error={errors.trialDays?.message}><Input type="number" min={0} max={365} {...register('trialDays', { valueAsNumber: true })} /></FormField>
            <Controller control={control} name="isActive" render={({ field }) => (
              <div className="flex items-center gap-2 sm:col-span-2">
                <Switch id="plan-active" checked={!!field.value} onCheckedChange={field.onChange} />
                <Label htmlFor="plan-active">{t('plans.field.active')}</Label>
              </div>
            )} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t('plans.section.features')} description={t('plans.section.featuresHint')} />
          <CardBody className="space-y-5">
            <Controller control={control} name="features" render={({ field }) => {
              const value = field.value ?? [];
              return (
                <>
                  {grouped.map(g => (
                    <fieldset key={g.kind}>
                      <legend className="mb-2 text-sm font-medium text-fg-muted">{tMaybe(`featureKind.${g.kind}`, g.kind)}</legend>
                      <ul className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
                        {g.items.map(f => (
                          <li key={f.key} className="flex items-start gap-2.5">
                            <Checkbox id={`f-${f.key}`} className="mt-0.5" checked={value.includes(f.key)} onCheckedChange={c => field.onChange(c ? [...value, f.key] : value.filter(k => k !== f.key))} data-testid={`plan-feature-${f.key}`} />
                            <Label htmlFor={`f-${f.key}`} className="font-normal leading-snug">
                              {f.name}
                              {f.description && <span className="block text-sm text-fg-muted">{f.description}</span>}
                            </Label>
                          </li>
                        ))}
                      </ul>
                    </fieldset>
                  ))}
                </>
              );
            }} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t('plans.section.limits')} description={t('plans.section.limitsHint')} />
          <CardBody className="divide-y divide-border py-0">
            {limits.map(l => <LimitInput key={l.key} limit={l} control={control} features={features} error={(errors.limits as Record<string, { message?: string }> | undefined)?.[l.key]?.message} />)}
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" asChild><Link href="/platform/plans">{t('common.cancel')}</Link></Button>
          <Button type="submit" loading={isSubmitting} data-testid="plan-save">{plan ? t('common.saveChanges') : t('plans.create')}</Button>
        </div>
      </form>
    </PageBody>
  );
}

function LimitInput({ limit, control, features, error }: { limit: LimitCatalogRow; control: Control<V>; features: FeatureCatalogRow[]; error?: string }) {
  const selected = useWatch({ control, name: 'features' }) ?? [];
  const requires = limit.featureKey ? features.find(f => f.key === limit.featureKey) : undefined;
  const inactive = !!limit.featureKey && !selected.includes(limit.featureKey);
  return (
    <Controller control={control} name={`limits.${limit.key}`} render={({ field }) => {
      const unlimited = field.value === null;
      const id = `limit-${limit.key}`;
      return (
        <div className="grid gap-3 py-3.5 sm:grid-cols-[1fr_auto_10rem] sm:items-center" data-inactive={inactive || undefined} data-testid={`plan-limit-${limit.key}`}>
          <div>
            <Label htmlFor={id}>{limit.name}</Label>
            <p className="text-sm text-fg-muted">
              {tMaybe(`meter.${limit.meter}`, limit.meter)} · {limit.unit}
              {requires && <> · {t('plans.limitRequires', { feature: requires.name })}</>}
            </p>
          </div>
          {/* A11Y8-005: only the controls are dimmed for an inactive feature; label text keeps full contrast */}
          <div className="flex items-center gap-2">
            <Switch id={`${id}-unl`} className={inactive ? 'opacity-60' : undefined} checked={unlimited} onCheckedChange={c => field.onChange(c ? null : 0)} data-testid={`plan-limit-${limit.key}-unlimited`} />
            <Label htmlFor={`${id}-unl`} className="font-normal">{t('usage.unlimited')}</Label>
          </div>
          <div>
            <Input
              id={id}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              disabled={unlimited}
              value={unlimited ? '' : (field.value ?? '')}
              placeholder={unlimited ? '∞' : undefined}
              onChange={e => field.onChange(e.target.value === '' ? 0 : Math.max(0, Math.trunc(Number(e.target.value))))}
              aria-invalid={error ? true : undefined}
              data-testid={`plan-limit-${limit.key}-value`}
            />
            {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
          </div>
        </div>
      );
    }} />
  );
}

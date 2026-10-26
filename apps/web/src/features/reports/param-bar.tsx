'use client';
import { Button, Input, Label, NativeSelect } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Play, RotateCcw } from 'lucide-react';
import { useId, type FormEvent } from 'react';
import { locationKeys, locationsApi } from '@/features/locations/api';
import { t } from '@/i18n';
import { useMe } from '@/lib/permissions';
import { DATE_PRESETS, resolvePreset } from './params';
import type { DatePreset, ReportParam } from './types';

export function useFyStartMonth() {
  const v = Number(useMe()?.settings?.['tenant.fy_start_month'] ?? 4);
  return Number.isFinite(v) && v >= 1 && v <= 12 ? v : 4;
}

export function useLocationOptions(enabled = true) {
  return useQuery({ queryKey: locationKeys.mine, queryFn: () => locationsApi.tree({ scope: 'mine', view: 'active' }), staleTime: 5 * 60_000, retry: false, enabled });
}

/** Date range with presets first (dataviz: presets before a custom range). Value: [from, to] ISO dates. */
export function DateRangeInput({ value, onChange, label, testId, idBase }: { value: unknown; onChange: (v: [string, string] | undefined) => void; label: string; testId: string; idBase: string }) {
  const fy = useFyStartMonth();
  const range = Array.isArray(value) ? (value as string[]) : [];
  const from = range[0] ?? '';
  const to = range[1] ?? '';
  const preset = DATE_PRESETS.find(p => { const r = resolvePreset(p, fy); return r && r[0] === from && r[1] === to; }) ?? (from || to ? 'custom' : '');
  return (
    <fieldset className="flex min-w-0 flex-wrap items-end gap-2" data-testid={testId}>
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idBase}-preset`} className="text-sm text-fg-muted">{label}</Label>
        <NativeSelect id={`${idBase}-preset`} className="h-8 w-40" value={preset} data-testid={`${testId}-preset`}
          onChange={e => {
            const v = e.target.value;
            if (!v) onChange(undefined);
            else if (v !== 'custom') onChange(resolvePreset(v as DatePreset, fy) ?? undefined);
          }}>
          <option value="">{t('report.param.anyTime')}</option>
          {DATE_PRESETS.map(p => <option key={p} value={p}>{t(`report.preset.${p}` as 'report.preset.today')}</option>)}
          <option value="custom">{t('report.preset.custom')}</option>
        </NativeSelect>
      </div>
      <div className="flex items-center gap-1.5">
        <Input type="date" className="h-8 w-[9.5rem]" aria-label={t('report.param.from', { label })} value={from} onChange={e => onChange([e.target.value, to])} data-testid={`${testId}-from`} />
        <span className="text-fg-subtle" aria-hidden>–</span>
        <Input type="date" className="h-8 w-[9.5rem]" aria-label={t('report.param.to', { label })} value={to} onChange={e => onChange([from, e.target.value])} data-testid={`${testId}-to`} />
      </div>
    </fieldset>
  );
}

export function LocationInput({ value, onChange, id, testId }: { value: unknown; onChange: (v: string | undefined) => void; id: string; testId: string }) {
  const locs = useLocationOptions();
  return (
    <NativeSelect id={id} className="h-8 w-full sm:w-52" value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value || undefined)} data-testid={testId}>
      <option value="">{t('report.param.allLocations')}</option>
      {(locs.data ?? []).map(n => <option key={n.id} value={n.id}>{`${'  '.repeat(Math.max(0, n.depth - 1))}${n.name}`}</option>)}
    </NativeSelect>
  );
}

/** Key of the run-time override for the definition's date preset. */
export const PERIOD_KEY = 'datePreset';

/** One control for a parameter, typed from its field and operator. */
export function ParamInput({ p, value, onChange }: { p: ReportParam; value: unknown; onChange: (v: unknown) => void }) {
  const base = useId();
  const testId = `report-param-${p.key}`;
  const isDate = p.type === 'date' || p.type === 'datetime';
  if (p.key === PERIOD_KEY) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={base} className="text-sm text-fg-muted">{p.label}</Label>
        <NativeSelect id={base} className="h-8 w-44" value={typeof value === 'string' ? value : 'none'} onChange={e => onChange(e.target.value)} data-testid="report-param-period">
          <option value="none">{t('report.param.anyTime')}</option>
          {DATE_PRESETS.map(x => <option key={x} value={x}>{t(`report.preset.${x}` as 'report.preset.today')}</option>)}
        </NativeSelect>
      </div>
    );
  }
  if (p.op === 'between' && isDate) return <DateRangeInput value={value} onChange={onChange} label={p.label} testId={testId} idBase={base} />;
  const label = <Label htmlFor={base} className="text-sm text-fg-muted">{p.label}{p.required && <span className="text-danger" aria-hidden> *</span>}</Label>;
  let control: React.ReactNode;
  if (p.op === 'within_location') {
    control = <LocationInput id={base} value={value} onChange={onChange} testId={testId} />;
  } else if (p.type === 'boolean') {
    control = (
      <NativeSelect id={base} className="h-8 w-32" value={value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : ''} onChange={e => onChange(e.target.value === '' ? undefined : e.target.value === 'true')} data-testid={testId}>
        <option value="">{t('report.param.any')}</option><option value="true">{t('report.yes')}</option><option value="false">{t('report.no')}</option>
      </NativeSelect>
    );
  } else if (p.op === 'between') {
    const r = Array.isArray(value) ? (value as unknown[]) : [];
    control = (
      <div className="flex items-center gap-1.5">
        <Input id={base} type="number" className="h-8 w-28" aria-label={t('report.param.min', { label: p.label })} value={String(r[0] ?? '')} onChange={e => onChange([e.target.value, r[1] ?? ''])} data-testid={`${testId}-from`} />
        <span className="text-fg-subtle" aria-hidden>–</span>
        <Input type="number" className="h-8 w-28" aria-label={t('report.param.max', { label: p.label })} value={String(r[1] ?? '')} onChange={e => onChange([r[0] ?? '', e.target.value])} data-testid={`${testId}-to`} />
      </div>
    );
  } else {
    const numeric = p.type === 'number' || p.type === 'currency';
    const listy = p.op === 'in' || p.op === 'not_in';
    control = (
      <Input id={base} type={isDate ? 'date' : numeric && !listy ? 'number' : 'text'} className="h-8 w-full sm:w-44"
        placeholder={listy ? t('report.param.listHint') : undefined}
        value={Array.isArray(value) ? value.join(', ') : String(value ?? '')}
        onChange={e => onChange(listy ? e.target.value.split(',').map(s => s.trim()).filter(Boolean) : e.target.value || undefined)} data-testid={testId} />
    );
  }
  return <div className="flex min-w-0 flex-col gap-1">{label}{control}</div>;
}

/** Parameters in one row above the results (dataviz: filters scope everything below them). */
export function ParamBar({ params, values, onChange, onRun, onReset, running, dirty, missing }: {
  params: ReportParam[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void; onRun: () => void; onReset: () => void;
  running?: boolean; dirty?: boolean; missing: string[];
}) {
  const submit = (e: FormEvent) => { e.preventDefault(); onRun(); };
  return (
    <form onSubmit={submit} className="mb-4 rounded-lg border border-border bg-surface px-4 py-3" data-testid="report-params" aria-label={t('report.params')}>
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        {params.map(p => <ParamInput key={p.key} p={p} value={values[p.key]} onChange={v => onChange(p.key, v)} />)}
        <div className="ml-auto flex items-center gap-2">
          {dirty && <Button type="button" variant="ghost" size="sm" onClick={onReset} data-testid="report-params-reset"><RotateCcw aria-hidden />{t('report.params.reset')}</Button>}
          <Button type="submit" size="sm" loading={running} data-testid="report-run"><Play aria-hidden />{t('report.run')}</Button>
        </div>
      </div>
      {missing.length > 0 && <p className="mt-2 text-sm text-danger" role="alert" data-testid="report-params-missing">{t('report.params.missing', { list: missing.join(', ') })}</p>}
    </form>
  );
}

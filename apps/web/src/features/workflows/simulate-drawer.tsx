'use client';
import type { FormDefinition, FormEvaluationResult, RenderableForm, SimulateResult } from '@procure/schema';
import { Button, cn, Segmented, Skeleton } from '@procure/ui';
import { CircleCheck, CircleSlash, FlaskConical, ShieldAlert, UserX, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useMemo, useRef, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { todayIn } from '@/engines/form-renderer/formula';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { initialValues, newRowId } from '@/engines/form-renderer/values';
import { workflowsApi } from './api';

const FormRenderer = dynamic(() => import('@/engines/form-renderer/form-renderer').then(m => m.FormRenderer), {
  ssr: false,
  loading: () => <div className="space-y-2"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-24" /></div>,
});

type Outcome = SimulateResult['stages'][number]['outcome'];
const ICON: Record<Outcome, typeof CircleCheck> = {
  run: CircleCheck, skipped_condition: CircleSlash, disabled: CircleSlash, no_actor_skip: UserX, no_actor_admins: ShieldAlert,
};

/** Docked simulation panel (replaces the settings panel while open; full width on phones). */
export function SimulatePanel({ onClose, docType, combined, hasPublished, dirty, canEdit, onSave, result, onResult }: {
  onClose: () => void; docType: string; combined: FormDefinition; hasPublished: boolean; dirty: boolean; canEdit: boolean;
  onSave: () => Promise<boolean>; result: SimulateResult | null; onResult: (r: SimulateResult | null) => void;
}) {
  const { currency, timeZone } = useTenantLocale();
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...initialValues(combined.fields, todayIn(timeZone)), lines: [{ _row: newRowId() }] }));
  const evaluated = useRef<FormEvaluationResult | null>(null);
  const [source, setSource] = useState<'draft' | 'published'>('draft');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useMemo<RenderableForm>(() => ({ formKey: `${docType}_simulate`, formVersionId: 'simulate', definition: combined, readOnlyFields: [] }), [docType, combined]);

  async function run(saveFirst = false) {
    setError(null);
    if (saveFirst && !(await onSave())) return;
    setBusy(true);
    try {
      const all = { ...values, ...(evaluated.current?.values ?? {}) };
      const { lines, ...header } = all as Record<string, unknown> & { lines?: Record<string, unknown>[] };
      const rows = (Array.isArray(lines) ? lines : []).map(({ _row, ...r }) => r).filter(r => Object.values(r).some(v => v !== null && v !== '' && v !== undefined));
      const r = await workflowsApi.simulate(docType, { values: header, lines: rows, useDraft: source === 'draft' });
      onResult(r);
    } catch (e) {
      setError(isApiError(e) ? [e.message, ...e.errors.map(x => x.message)].join(' · ') : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="wf-sim-title" data-testid="wf-sim-drawer">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <FlaskConical className="size-4 text-fg-subtle" aria-hidden />
        <h2 id="wf-sim-title" className="flex-1 text-md font-semibold">{t('wf.sim.title')}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('common.close')} data-testid="wf-sim-close"><X aria-hidden /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 p-4">
          <p className="text-sm text-fg-muted">{t('wf.sim.intro')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t('wf.sim.use')}</span>
            <Segmented<'draft' | 'published'> value={source} onChange={setSource} label={t('wf.sim.use')} data-testid="wf-sim-source"
              options={[{ value: 'draft', label: t('wf.sim.draft') }, { value: 'published', label: t('wf.sim.published'), title: hasPublished ? undefined : t('wf.sim.noPublished') }]} />
          </div>
          {source === 'draft' && dirty && (
            <InlineAlert tone="warning" data-testid="wf-sim-unsaved">
              {t('wf.sim.unsaved')}
              {canEdit && <Button size="sm" variant="secondary" className="ml-2 mt-1" onClick={() => void run(true)} data-testid="wf-sim-save-run">{t('wf.sim.saveAndRun')}</Button>}
            </InlineAlert>
          )}
          <section aria-labelledby="sim-values" className="space-y-2">
            <h3 id="sim-values" className="text-sm font-semibold">{t('wf.sim.values')}</h3>
            {combined.fields.length ? (
              <div className="rounded-lg border border-border bg-bg p-3" data-testid="wf-sim-form">
                <FormRenderer form={form} value={values} onChange={setValues} currency={currency} timeZone={timeZone} idPrefix="sim"
                  onEvaluate={r => { evaluated.current = r; }} />
              </div>
            ) : (
              <p className="text-sm text-fg-muted">{t('wf.sim.noForm')}</p>
            )}
          </section>
          {error && <InlineAlert data-testid="wf-sim-error">{error}</InlineAlert>}
          <div className="sticky bottom-0 -mx-4 flex items-center gap-2 border-t border-border bg-surface px-4 py-3">
            <Button onClick={() => void run()} loading={busy} data-testid="wf-sim-run"><FlaskConical aria-hidden />{t('wf.sim.run')}</Button>
            {result && <Button variant="ghost" onClick={() => onResult(null)} data-testid="wf-sim-clear">{t('wf.sim.clear')}</Button>}
          </div>
          {result && <SimResultList result={result} />}
        </div>
      </div>
    </section>
  );
}

export function SimResultList({ result }: { result: SimulateResult }) {
  const runs = result.stages.filter(s => s.outcome === 'run' || s.outcome === 'no_actor_admins');
  return (
    <section aria-labelledby="sim-result" className="space-y-2" data-testid="wf-sim-result" aria-live="polite">
      <h3 id="sim-result" className="text-sm font-semibold">{t('wf.sim.path')}</h3>
      <p className="text-sm text-fg-muted" data-testid="wf-sim-summary">
        {runs.length === 0 ? t('wf.sim.autoApprove') : t('wf.sim.summary', { n: runs.length, skipped: result.stages.length - runs.length })}
      </p>
      <ol className="relative space-y-0">
        {result.stages.map((s, i) => {
          const Icon = ICON[s.outcome] ?? CircleSlash;
          const runsHere = s.outcome === 'run' || s.outcome === 'no_actor_admins';
          const prevGroup = i > 0 ? result.stages[i - 1]!.parallelGroup : null;
          return (
            <li key={s.key} className={cn('flex gap-3 py-2', s.parallelGroup && s.parallelGroup === prevGroup && 'pl-4')} data-testid={`wf-sim-result-${s.key}`} data-outcome={s.outcome}>
              <Icon className={cn('mt-0.5 size-4 shrink-0', runsHere ? 'text-success' : s.outcome === 'no_actor_skip' ? 'text-warning' : 'text-fg-subtle')} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className={cn('font-medium', !runsHere && 'text-fg-muted')}>
                  {s.name}
                  {s.parallelGroup && <span className="ml-2 text-xs font-normal text-accent">{t('wf.sim.parallel')}</span>}
                </p>
                <p className={cn('text-sm', runsHere ? 'text-success' : 'text-fg-muted')}>{t(`wf.sim.why.${s.outcome}` as 'wf.sim.why.run')}</p>
                {runsHere && <p className="text-sm text-fg-muted">{s.actors.length ? t('wf.sim.actors', { names: s.actors.join(', ') }) : t('wf.sim.noNames')}</p>}
                {s.error && <p className="text-sm text-danger">{s.error}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

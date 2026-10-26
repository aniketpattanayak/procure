'use client';
import type { WorkflowRuntimeView } from '@procure/schema';
import { cn } from '@procure/ui';
import { Check, CircleDashed, Clock, Minus } from 'lucide-react';
import { t, tMaybe } from '@/i18n';
import { fmtDateTime, fmtRelative } from '@/lib/format';

type StageView = WorkflowRuntimeView['stages'][number];

const STATUS_TEXT: Record<StageView['status'], Parameters<typeof t>[0]> = {
  pending: 'docs.wf.pending', active: 'docs.wf.active', done: 'docs.wf.done', skipped: 'docs.wf.skipped', disabled: 'docs.wf.disabled',
};

/**
 * Workflow progress strip: one step per stage with done / active / skipped state, who it waits for and the SLA.
 * Horizontal on wide screens, a vertical list on phones. `submitted` is the implicit first step.
 */
export function WorkflowProgress({ workflow, submittedAt, submittedBy }: { workflow: WorkflowRuntimeView; submittedAt: string | null; submittedBy: string | null }) {
  const stages = workflow.stages;
  return (
    <nav aria-label={t('docs.wf.label')} data-testid="wf-progress" data-status={workflow.status}>
      <ol className="flex flex-col gap-0 md:flex-row md:items-stretch">
        <Step
          index={0}
          last={stages.length === 0}
          state="done"
          name={t('docs.wf.submitted')}
          meta={submittedAt ? `${submittedBy ?? ''} · ${fmtDateTime(submittedAt)}` : null}
          testKey="submitted"
        />
        {stages.map((s, i) => (
          <Step
            key={s.key}
            index={i + 1}
            last={i === stages.length - 1}
            state={s.status}
            name={s.name}
            statusText={t(STATUS_TEXT[s.status])}
            meta={stageMeta(s)}
            overdue={s.overdue && s.status === 'active'}
            due={s.status === 'active' ? dueText(s.dueAt, s.overdue) : null}
            canAct={s.canAct && s.status === 'active'}
            testKey={s.key}
          />
        ))}
      </ol>
      {/* QA3-BUG-010: which published version this document runs on (older documents keep their version). */}
      <p className="mt-2 text-xs text-fg-subtle" data-testid="wf-version">{t('docs.wf.version', { n: workflow.workflowVersion })}</p>
    </nav>
  );
}

function stageMeta(s: StageView): string | null {
  if (s.status === 'done') return s.completedAt ? fmtDateTime(s.completedAt) : null;
  if (s.status === 'skipped' || s.status === 'disabled') return s.skipReason ? tMaybe(`docs.wf.skip.${s.skipReason}`, s.skipReason) : null;
  if (s.status === 'active') {
    const who = s.actors.length ? t('docs.wf.waitingFor', { names: s.actors.slice(0, 3).join(', ') + (s.actors.length > 3 ? ` +${s.actors.length - 3}` : '') }) : null;
    return who;
  }
  return s.actors.length ? s.actors.slice(0, 2).join(', ') : null;
}

function Step({ index, last, state, name, statusText, meta, overdue, due, canAct, title, testKey }: {
  index: number; last: boolean; state: StageView['status']; name: string; statusText?: string; meta: string | null;
  overdue?: boolean; due?: string | null; canAct?: boolean; title?: string; testKey: string;
}) {
  const skipped = state === 'skipped' || state === 'disabled';
  return (
    <li className="relative flex min-w-0 gap-3 pb-4 md:flex-1 md:flex-col md:gap-2 md:pb-0 md:pr-3" data-testid={`wf-stage-${testKey}`} data-state={state} title={title}
      aria-current={state === 'active' ? 'step' : undefined}>
      {/* connector */}
      {!last && <span aria-hidden className={cn('absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-px md:left-7 md:top-[13px] md:h-px md:w-[calc(100%-1.75rem)]', state === 'done' ? 'bg-success' : 'bg-border', skipped && 'bg-transparent border-l border-dashed border-border md:border-l-0 md:border-t')} />}
      <span aria-hidden className={cn(
        'relative z-10 grid size-7 shrink-0 place-items-center rounded-full border-2 text-xs font-semibold',
        state === 'done' && 'border-success bg-success text-white dark:text-bg',
        state === 'active' && (overdue ? 'border-danger bg-danger-soft text-danger' : 'border-accent bg-accent-soft text-accent'),
        state === 'pending' && 'border-border-strong bg-surface text-fg-subtle',
        skipped && 'border-dashed border-border-strong bg-surface text-fg-subtle',
      )}>
        {state === 'done' ? <Check className="size-4" /> : skipped ? <Minus className="size-3.5" /> : state === 'pending' ? <CircleDashed className="size-3.5" /> : index}
      </span>
      <div className="min-w-0 md:pr-2">
        <p className={cn('truncate font-medium', skipped && 'text-fg-subtle line-through decoration-fg-subtle/50', state === 'pending' && 'text-fg-muted')}>{name}</p>
        {statusText && (
          <p className={cn('text-xs', state === 'active' ? (overdue ? 'font-medium text-danger' : 'font-medium text-accent') : 'text-fg-subtle')}>
            {statusText}{canAct ? ` · ${t('docs.wf.yourTurn')}` : ''}
          </p>
        )}
        {meta && <p className="truncate text-xs text-fg-subtle" title={meta}>{meta}</p>}
        {due && <p className={cn('flex items-center gap-1 text-xs', overdue ? 'font-medium text-danger' : 'text-fg-subtle')}><Clock className="size-3" aria-hidden />{due}</p>}
      </div>
    </li>
  );
}

/** Due text for an active stage (inbox + detail). */
export function dueText(dueAt: string | null, overdue: boolean): string | null {
  if (!dueAt) return null;
  return overdue ? t('docs.wf.overdueSince', { when: fmtRelative(dueAt) }) : t('docs.wf.dueIn', { when: fmtRelative(dueAt) });
}

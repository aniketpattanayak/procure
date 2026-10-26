'use client';
import { STAGE_ACTIONS, type FormDefinition, type Stage, type WorkflowDefinition } from '@procure/schema';
import { Badge, Button, Segmented } from '@procure/ui';
import { AlertCircle, Workflow } from 'lucide-react';
import { t } from '@/i18n';
import { FormulaEditor } from '@/engines/formula-editor';
import { ActorControl, ActorsEditor, defaultActor, type ActorContext } from './actors';
import { BoolIn, CheckGroup, Group, NumberIn, Row, SelectIn, TextIn } from './controls';
import { EffectsEditor } from './effects';
import { REASON_ON, type Issue, type ReasonOn, type StageAction } from './model';

export interface PanelContext {
  def: WorkflowDefinition;
  formula: FormDefinition;
  actors: ActorContext;
  lineFields: { key: string; label: string }[];
  available: readonly string[];
  docType: string;
  canEdit: boolean;
}

export function StagePanel({ stage, update, keyLocked, issues, ctx }: {
  stage: Stage; update: (patch: Partial<Stage> & { __keyTouched?: boolean }, tag?: string) => void; keyLocked: boolean; issues: Issue[]; ctx: PanelContext;
}) {
  const ro = !ctx.canEdit;
  const err = (suffix: string) => issues.find(i => i.path.split('.').slice(2).join('.').startsWith(suffix))?.message ?? null;
  const effectCount = stage.effects.onEnter.length + stage.effects.onApprove.length + stage.effects.onReject.length;
  return (
    <div className="pb-8" data-testid="wf-stage-panel" data-stage={stage.key}>
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-md font-semibold">{stage.name || t('wf.card.unnamed')}</h2>
          <p className="text-xs text-fg-subtle">{t('wf.panel.stageHint')}</p>
        </div>
        {!stage.enabled && <Badge>{t('wf.card.disabled')}</Badge>}
      </div>
      {issues.length > 0 && (
        <ul className="space-y-1 border-b border-border bg-danger-soft/50 px-4 py-2 text-sm text-danger" aria-label={t('wf.issues.forStage')}>
          {issues.map((i, n) => <li key={n} className="flex gap-1.5"><AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{i.message}</li>)}
        </ul>
      )}
      <fieldset disabled={ro} className="contents">
        <Group title={t('wf.panel.basics')}>
          <TextIn name="name" label={t('wf.prop.name')} value={stage.name} maxLength={60} onChange={v => update({ name: v }, 'name')} error={err('name')} />
          <TextIn name="key" label={t('wf.prop.key')} value={stage.key} mono maxLength={31} disabled={keyLocked}
            hint={keyLocked ? t('wf.prop.keyLocked') : t('wf.prop.keyHint')} error={err('key')}
            onChange={v => update({ key: v.toLowerCase().replace(/[^a-z0-9_]/g, '_'), __keyTouched: true }, 'key')} />
          <TextIn name="statusLabel" label={t('wf.prop.statusLabel')} value={stage.statusLabel} maxLength={60}
            placeholder={t('wf.prop.statusLabelDefault', { name: stage.name || '…' })} hint={t('wf.prop.statusLabelHint')}
            onChange={v => update({ statusLabel: v || undefined }, 'statusLabel')} />
          <BoolIn name="enabled" toggle label={t('wf.prop.enabled')} hint={t('wf.prop.enabledHint')} value={stage.enabled} onChange={v => update({ enabled: v })} />
        </Group>

        <Group title={t('wf.panel.condition')} badge={stage.when?.trim() ? <Badge tone="warning">{t('wf.panel.conditional')}</Badge> : undefined}>
          <Row label={t('wf.prop.when')} hint={t('wf.prop.whenHint')}>
            <FormulaEditor
              value={stage.when ?? ''}
              onChange={v => update({ when: v.trim() ? v : undefined }, 'when')}
              definition={ctx.formula}
              expected="boolean"
              testId="wf-prop-when"
              label={t('wf.prop.when')}
              placeholder={t('wf.prop.whenPlaceholder')}
            />
          </Row>
        </Group>

        <Group title={t('wf.panel.actors')}>
          <ActorsEditor value={stage.actors} onChange={actors => update({ actors })} ctx={ctx.actors} disabled={ro} />
          <SelectIn<'any' | 'all'> name="quorum" label={t('wf.prop.quorum')} value={stage.quorum} onChange={v => update({ quorum: v })}
            options={[{ value: 'any', label: t('wf.prop.quorumAny') }, { value: 'all', label: t('wf.prop.quorumAll') }]}
            hint={err('quorum') ?? (stage.quorum === 'all' ? t('wf.prop.quorumAllHint') : t('wf.prop.quorumAnyHint'))} />
          <BoolIn name="allowSelfApproval" label={t('wf.prop.selfApproval')} hint={t('wf.prop.selfApprovalHint')} value={stage.allowSelfApproval} onChange={v => update({ allowSelfApproval: v })} />
          <SelectIn<'skip' | 'assign_admins'> name="ifNoActor" label={t('wf.prop.ifNoActor')} value={stage.ifNoActor} onChange={v => update({ ifNoActor: v })}
            options={[{ value: 'assign_admins', label: t('wf.prop.ifNoActorAdmins') }, { value: 'skip', label: t('wf.prop.ifNoActorSkip') }]} />
        </Group>

        <Group title={t('wf.panel.decisions')}>
          <CheckGroup<StageAction> name="actions" legend={t('wf.prop.actions')} value={stage.actions} onChange={v => update({ actions: v })}
            options={STAGE_ACTIONS.map(a => ({ value: a, label: t(`wf.action.${a}` as 'wf.action.approve') }))} hint={err('actions') ?? t('wf.prop.actionsHint')} />
          <CheckGroup<ReasonOn> name="requireReasonOn" legend={t('wf.prop.reasons')} value={stage.requireReasonOn} onChange={v => update({ requireReasonOn: v })}
            options={REASON_ON.map(a => ({ value: a, label: t(`wf.action.${a}` as 'wf.action.approve') }))} hint={t('wf.prop.reasonsHint')} />
          {ctx.lineFields.length > 0 && (
            <CheckGroup<string> name="editableLineFields" legend={t('wf.prop.editableLineFields')} value={stage.editableLineFields} onChange={v => update({ editableLineFields: v.slice(0, 20) })}
              options={ctx.lineFields.map(f => ({ value: f.key, label: f.label }))} hint={t('wf.prop.editableLineFieldsHint')} />
          )}
        </Group>

        <Group title={t('wf.panel.sla')} defaultOpen={!!stage.sla} badge={stage.sla ? <Badge>{t('wf.card.sla', { h: stage.sla.hours })}</Badge> : undefined}>
          <BoolIn name="sla" toggle label={t('wf.prop.slaOn')} hint={t('wf.prop.slaHint')} value={!!stage.sla}
            onChange={v => update({ sla: v ? { hours: 24 } : undefined })} />
          {stage.sla && (
            <>
              <NumberIn name="slaHours" label={t('wf.prop.slaHours')} suffix={t('wf.prop.hours')} min={1} max={2160} value={stage.sla.hours}
                onChange={v => update({ sla: { ...stage.sla!, hours: v ?? 0 } }, 'slaHours')} />
              <NumberIn name="slaRemind" label={t('wf.prop.slaRemind')} suffix={t('wf.prop.hours')} min={1} max={720} value={stage.sla.remindEveryHours} placeholder={t('wf.prop.never')}
                onChange={v => update({ sla: { ...stage.sla!, remindEveryHours: v || undefined } }, 'slaRemind')} hint={t('wf.prop.slaRemindHint')} />
              <BoolIn name="slaEscalate" label={t('wf.prop.slaEscalate')} hint={t('wf.prop.slaEscalateHint')} value={!!stage.sla.escalateTo}
                onChange={v => update({ sla: { ...stage.sla!, escalateTo: v ? defaultActor(ctx.actors.roles.length ? 'role' : 'users', ctx.actors) : undefined } })} />
              {stage.sla.escalateTo && (
                <ActorControl value={stage.sla.escalateTo} ctx={ctx.actors} testId="wf-prop-slaEscalateTo" onChange={a => update({ sla: { ...stage.sla!, escalateTo: a } })} />
              )}
            </>
          )}
        </Group>

        <Group title={t('wf.panel.effects')} defaultOpen={effectCount > 0} badge={effectCount ? <Badge>{effectCount}</Badge> : undefined}>
          {(['onEnter', 'onApprove', 'onReject'] as const).map(h => (
            <section key={h} className="space-y-1.5">
              <h3 className="text-sm font-medium">{t(`wf.hook.${h}` as 'wf.hook.onEnter')}</h3>
              <p className="text-xs text-fg-subtle">{t(`wf.hookHint.${h}` as 'wf.hookHint.onEnter')}</p>
              <EffectsEditor hook={h} value={stage.effects[h]} onChange={v => update({ effects: { ...stage.effects, [h]: v } })} available={ctx.available}
                stages={ctx.def.stages} selfKey={stage.key} ctx={ctx.actors} docType={ctx.docType} disabled={ro} />
            </section>
          ))}
        </Group>
      </fieldset>
    </div>
  );
}

export function WorkflowPanel({ def, change, ctx, issues, onAddStage }: { def: WorkflowDefinition; change: (d: WorkflowDefinition, tag?: string) => void; ctx: PanelContext; issues: Issue[]; onAddStage: () => void }) {
  const ro = !ctx.canEdit;
  return (
    <div className="pb-8" data-testid="wf-workflow-panel">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <Workflow className="mt-0.5 size-4 text-fg-subtle" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-md font-semibold">{t('wf.panel.workflow')}</h2>
          <p className="text-xs text-fg-subtle">{t('wf.panel.workflowHint')}</p>
        </div>
      </div>
      {issues.length > 0 && (
        <ul className="space-y-1 border-b border-border bg-danger-soft/50 px-4 py-2 text-sm text-danger">
          {issues.map((i, n) => <li key={n} className="flex gap-1.5"><AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{i.message}</li>)}
        </ul>
      )}
      <fieldset disabled={ro} className="contents">
        <Group title={t('wf.panel.granularity')}>
          <Segmented<'line' | 'document'>
            value={def.granularity}
            onChange={v => change({ ...def, granularity: v })}
            options={[{ value: 'line', label: t('wf.granularity.line') }, { value: 'document', label: t('wf.granularity.document') }]}
            label={t('wf.panel.granularity')}
            disabled={ro}
            data-testid="wf-prop-granularity"
          />
          <p className="text-xs text-fg-subtle">{def.granularity === 'line' ? t('wf.granularity.lineHint') : t('wf.granularity.documentHint')}</p>
        </Group>
        <Group title={t('wf.hook.onSubmit')} defaultOpen>
          <p className="text-xs text-fg-subtle">{t('wf.hookHint.onSubmit')}</p>
          <EffectsEditor hook="onSubmit" value={def.onSubmit} onChange={v => change({ ...def, onSubmit: v })} available={ctx.available} stages={def.stages} selfKey={null} ctx={ctx.actors} docType={ctx.docType} disabled={ro} />
        </Group>
        <Group title={t('wf.hook.onComplete')} defaultOpen>
          <p className="text-xs text-fg-subtle">{t('wf.hookHint.onComplete')}</p>
          <EffectsEditor hook="onComplete" value={def.onComplete} onChange={v => change({ ...def, onComplete: v })} available={ctx.available} stages={def.stages} selfKey={null} ctx={ctx.actors} docType={ctx.docType} disabled={ro} />
        </Group>
      </fieldset>
      <div className="space-y-2 px-4 py-4 text-sm text-fg-muted">
        <p>{def.stages.length ? t('wf.panel.howItWorks') : t('wf.panel.noStagesYet')}</p>
        {!ro && !def.stages.length && <Button size="sm" onClick={onAddStage}>{t('wf.lane.addFirst')}</Button>}
      </div>
    </div>
  );
}

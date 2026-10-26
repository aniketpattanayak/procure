'use client';
import { EFFECTS, type Effect, type Stage, type WorkflowActor } from '@procure/schema';
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input, NativeSelect,
} from '@procure/ui';
import { Plus, X } from 'lucide-react';
import { t } from '@/i18n';
import { ActorControl, defaultActor, type ActorContext } from './actors';
import { effectLabel } from './lane';
import { EFFECT_MODULE, type EffectName, type Hook } from './model';

type Recipient = Extract<Effect, { effect: 'notify' }>['to'][number];
type EffectHook = Hook | 'onSubmit' | 'onComplete';

function defaultEffect(name: EffectName, stages: Stage[], selfKey: string | null, docType: string): Effect {
  switch (name) {
    case 'notify': return { effect: 'notify', to: [{ type: 'submitter' }] };
    case 'emit': return { effect: 'emit', event: `${docType}.${selfKey ?? 'workflow'}_done`.replace(/[^a-z0-9_.]/g, '_').slice(0, 60) };
    case 'route_to': return { effect: 'route_to', stage: stages.find(s => s.key !== selfKey)?.key ?? '' };
    case 'post_stock': return { effect: 'post_stock', stockStatus: 'available' };
    case 'generate_pdf': return { effect: 'generate_pdf' };
    case 'send_email': return { effect: 'send_email', template: '' };
    case 'send_whatsapp': return { effect: 'send_whatsapp', template: '' };
    default: return { effect: name } as Effect;
  }
}

/** Effects for one hook. Only `availableEffects` can be added; others are listed disabled with the module that brings them. */
export function EffectsEditor({ hook, value, onChange, available, stages, selfKey, ctx, docType, disabled }: {
  hook: EffectHook; value: Effect[]; onChange: (v: Effect[]) => void; available: readonly string[]; stages: Stage[]; selfKey: string | null;
  ctx: ActorContext; docType: string; disabled?: boolean;
}) {
  const base = `wf-effects-${hook}`;
  const names = EFFECTS.filter(e => e !== 'route_to' || hook === 'onReject');
  const usable = names.filter(n => available.includes(n));
  const later = names.filter(n => !available.includes(n));
  const set = (i: number, e: Effect) => onChange(value.map((x, j) => (j === i ? e : x)));
  return (
    <div className="space-y-2" data-testid={base}>
      {value.length === 0 && <p className="text-xs text-fg-subtle">{t('wf.effect.none')}</p>}
      {value.map((e, i) => (
        <div key={i} className="rounded border border-border bg-subtle/60 p-2" data-testid={`${base}-${i}`} data-effect={e.effect}>
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm font-medium">{effectLabel(e)}</p>
            {!available.includes(e.effect) && <span className="text-xs text-warning">{t('wf.effect.unavailableShort')}</span>}
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t('wf.effect.remove', { name: effectLabel(e) })} data-testid={`${base}-${i}-remove`}><X aria-hidden /></Button>
          </div>
          <EffectParams effect={e} onChange={n => set(i, n)} stages={stages} selfKey={selfKey} ctx={ctx} testId={`${base}-${i}`} />
        </div>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" disabled={disabled} data-testid={`${base}-add`}><Plus aria-hidden />{t('wf.effect.add')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
          {usable.map(n => (
            <DropdownMenuItem key={n} onSelect={() => onChange([...value, defaultEffect(n, stages, selfKey, docType)])} data-testid={`${base}-add-${n}`}>
              <span className="flex flex-col">
                <span>{t(`wf.effect.${n}` as 'wf.effect.notify')}</span>
                <span className="text-xs text-fg-subtle">{t(`wf.effectHint.${n}` as 'wf.effectHint.notify')}</span>
              </span>
            </DropdownMenuItem>
          ))}
          {later.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-medium text-fg-subtle">{t('wf.effect.later')}</DropdownMenuLabel>
              {later.map(n => (
                <DropdownMenuItem key={n} disabled data-testid={`${base}-add-${n}`}>
                  <span className="flex flex-col">
                    <span>{t(`wf.effect.${n}` as 'wf.effect.notify')}</span>
                    <span className="text-xs">{t('wf.effect.availableAfter', { module: t(`wf.module.${EFFECT_MODULE[n] ?? 'other'}` as 'wf.module.store') })}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function EffectParams({ effect: e, onChange, stages, selfKey, ctx, testId }: { effect: Effect; onChange: (e: Effect) => void; stages: Stage[]; selfKey: string | null; ctx: ActorContext; testId: string }) {
  switch (e.effect) {
    case 'notify':
      return (
        <div className="mt-2 space-y-2">
          <RecipientsEditor value={e.to} onChange={to => onChange({ ...e, to })} stages={stages} ctx={ctx} testId={`${testId}-to`} />
          <Input className="h-8 text-sm" value={e.message ?? ''} maxLength={300} placeholder={t('wf.effect.messagePlaceholder')} aria-label={t('wf.effect.message')}
            onChange={ev => onChange({ ...e, message: ev.target.value || undefined })} data-testid={`${testId}-message`} />
        </div>
      );
    case 'emit':
      return (
        <div className="mt-2">
          <Input className="h-8 font-mono text-sm" value={e.event} maxLength={61} aria-label={t('wf.effect.event')} onChange={ev => onChange({ ...e, event: ev.target.value })} data-testid={`${testId}-event`} />
          <p className="mt-1 text-xs text-fg-subtle">{t('wf.effect.eventHint')}</p>
        </div>
      );
    case 'route_to':
      return (
        <NativeSelect className="mt-2 h-8 text-sm" value={e.stage} aria-label={t('wf.effect.routeTarget')} onChange={ev => onChange({ ...e, stage: ev.target.value })} data-testid={`${testId}-stage`}>
          {!stages.some(s => s.key === e.stage) && <option value={e.stage} disabled>{e.stage || t('wf.effect.pickStage')}</option>}
          {stages.filter(s => s.key !== selfKey).map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </NativeSelect>
      );
    case 'post_stock':
      return (
        <NativeSelect className="mt-2 h-8 text-sm" value={e.stockStatus} aria-label={t('wf.effect.stockStatus')} onChange={ev => onChange({ ...e, stockStatus: ev.target.value as 'available' | 'quarantine' })} data-testid={`${testId}-stock`}>
          <option value="available">{t('wf.effect.stockAvailable')}</option>
          <option value="quarantine">{t('wf.effect.stockQuarantine')}</option>
        </NativeSelect>
      );
    case 'generate_pdf':
    case 'send_email':
    case 'send_whatsapp':
      return (
        <Input className="mt-2 h-8 text-sm" value={e.template ?? ''} placeholder={t('wf.effect.template')} aria-label={t('wf.effect.template')}
          onChange={ev => onChange({ ...e, template: ev.target.value } as Effect)} data-testid={`${testId}-template`} />
      );
    default:
      return null;
  }
}

type RecipientType = Recipient['type'];
const RECIPIENT_TYPES: RecipientType[] = ['submitter', 'stage_actors', 'role', 'users', 'reporting_manager', 'field'];

function RecipientsEditor({ value, onChange, stages, ctx, testId }: { value: Recipient[]; onChange: (v: Recipient[]) => void; stages: Stage[]; ctx: ActorContext; testId: string }) {
  const make = (ty: RecipientType): Recipient =>
    ty === 'submitter' ? { type: 'submitter' } : ty === 'stage_actors' ? { type: 'stage_actors', stage: stages[0]?.key ?? '' } : defaultActor(ty, ctx);
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <p className="text-xs font-medium text-fg-muted">{t('wf.effect.notifyWho')}</p>
      {value.map((r, i) => (
        <div key={i} className="flex items-start gap-1.5">
          {r.type === 'submitter' || r.type === 'stage_actors' ? (
            <div className="min-w-0 flex-1 space-y-1.5">
              <NativeSelect className="h-8 text-sm" value={r.type} aria-label={t('wf.actor.type')} onChange={e => onChange(value.map((x, j) => (j === i ? make(e.target.value as RecipientType) : x)))} data-testid={`${testId}-${i}-type`}>
                {RECIPIENT_TYPES.map(ty => <option key={ty} value={ty}>{t(`wf.recipient.${ty}` as 'wf.recipient.submitter')}</option>)}
              </NativeSelect>
              {r.type === 'stage_actors' && (
                <NativeSelect className="h-8 text-sm" value={r.stage} aria-label={t('wf.effect.pickStage')} onChange={e => onChange(value.map((x, j) => (j === i ? { type: 'stage_actors', stage: e.target.value } : x)))} data-testid={`${testId}-${i}-stage`}>
                  {stages.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                </NativeSelect>
              )}
            </div>
          ) : (
            <RecipientActor value={r} onChange={n => onChange(value.map((x, j) => (j === i ? n : x)))} ctx={ctx} testId={`${testId}-${i}`} make={make} />
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t('wf.actor.remove')} data-testid={`${testId}-${i}-remove`}><X aria-hidden /></Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" onClick={() => onChange([...value, { type: 'submitter' }])} data-testid={`${testId}-add`}><Plus aria-hidden />{t('wf.effect.addRecipient')}</Button>
    </div>
  );
}

/** Actor-shaped recipient: the actor control with the two notify-only types added to its type list. */
function RecipientActor({ value, onChange, ctx, testId, make }: { value: WorkflowActor; onChange: (r: Recipient) => void; ctx: ActorContext; testId: string; make: (t: RecipientType) => Recipient }) {
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <NativeSelect className="h-8 text-sm" value={value.type} aria-label={t('wf.actor.type')} onChange={e => onChange(make(e.target.value as RecipientType))} data-testid={`${testId}-type`}>
        {RECIPIENT_TYPES.map(ty => <option key={ty} value={ty} disabled={ty === 'field' && !ctx.userFields.length}>{t(`wf.recipient.${ty}` as 'wf.recipient.submitter')}</option>)}
      </NativeSelect>
      {value.type !== 'reporting_manager' && (
        <ActorControl value={value} onChange={onChange} ctx={ctx} testId={testId} hideType />
      )}
    </div>
  );
}

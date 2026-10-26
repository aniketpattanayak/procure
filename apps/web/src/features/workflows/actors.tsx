'use client';
import type { RoleRow, WorkflowActor } from '@procure/schema';
import { Button, NativeSelect } from '@procure/ui';
import { Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { t } from '@/i18n';
import { useDebounced } from '@/lib/use-debounced';
import { Combobox, type ComboOption } from '@/engines/form-renderer/combobox';
import { useUserOptions } from './api';

export interface ActorContext {
  roles: RoleRow[];
  userFields: { key: string; label: string }[];
  userName: (id: string) => string;
}

type ActorType = WorkflowActor['type'];
const TYPES: ActorType[] = ['role', 'users', 'reporting_manager', 'field'];

export function defaultActor(type: ActorType, ctx: ActorContext): WorkflowActor {
  switch (type) {
    case 'role': return { type: 'role', roleId: ctx.roles[0]?.id ?? '' };
    case 'users': return { type: 'users', userIds: [] };
    case 'reporting_manager': return { type: 'reporting_manager' };
    case 'field': return { type: 'field', field: ctx.userFields[0]?.key ?? '' };
    default: return { type: 'reporting_manager' };
  }
}

/** Multi user picker over GET /users/options (async search). */
export function UserPicker({ value, onChange, userName, testId, label }: { value: string[]; onChange: (ids: string[]) => void; userName: (id: string) => string; testId: string; label: string }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const opts = useUserOptions(dq);
  const options: ComboOption[] = (opts.data ?? []).map(u => ({ value: u.id, label: u.name, secondary: u.email }));
  const selected = value.map(id => ({ value: id, label: userName(id) }));
  return (
    <Combobox
      multiple
      options={options}
      selected={selected}
      onSelect={o => { if (!value.includes(o.value)) onChange([...value, o.value].slice(0, 50)); }}
      onRemove={id => onChange(value.filter(v => v !== id))}
      onClear={() => onChange([])}
      query={q}
      onQueryChange={setQ}
      loading={opts.isFetching}
      placeholder={t('wf.actor.searchUsers')}
      emptyText={t('wf.actor.noUsers')}
      compact
      testId={testId}
      aria-label={label}
    />
  );
}

/** One actor rule: a type select plus the value control for that type. */
export function ActorControl({ value, onChange, ctx, testId, allowTypes = TYPES, hideType }: {
  value: WorkflowActor; onChange: (a: WorkflowActor) => void; ctx: ActorContext; testId: string; allowTypes?: ActorType[]; hideType?: boolean;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      {!hideType && <NativeSelect className="h-8 text-sm" value={value.type} onChange={e => onChange(defaultActor(e.target.value as ActorType, ctx))}
        aria-label={t('wf.actor.type')} data-testid={`${testId}-type`}>
        {allowTypes.map(ty => <option key={ty} value={ty} disabled={ty === 'field' && !ctx.userFields.length}>{t(`wf.actor.${ty}` as 'wf.actor.role')}</option>)}
      </NativeSelect>}
      {value.type === 'role' && (
        <NativeSelect className="h-8 text-sm" value={value.roleId} onChange={e => onChange({ type: 'role', roleId: e.target.value })} aria-label={t('wf.actor.role')} data-testid={`${testId}-role`}>
          {!value.roleId && <option value="" disabled>{t('wf.actor.pickRole')}</option>}
          {value.roleId && !ctx.roles.some(r => r.id === value.roleId) && <option value={value.roleId}>{t('wf.actor.unknownRole')}</option>}
          {ctx.roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </NativeSelect>
      )}
      {value.type === 'users' && (
        <UserPicker value={value.userIds} onChange={ids => onChange({ type: 'users', userIds: ids })} userName={ctx.userName} testId={`${testId}-users`} label={t('wf.actor.users')} />
      )}
      {value.type === 'field' && (
        <NativeSelect className="h-8 text-sm" value={value.field} onChange={e => onChange({ type: 'field', field: e.target.value })} aria-label={t('wf.actor.field')} data-testid={`${testId}-field`}>
          {!ctx.userFields.some(f => f.key === value.field) && <option value={value.field} disabled>{value.field || t('wf.actor.pickField')}</option>}
          {ctx.userFields.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </NativeSelect>
      )}
      {value.type === 'reporting_manager' && !hideType && <p className="text-xs text-fg-subtle">{t('wf.actor.reportingHint')}</p>}
      {value.type === 'field' && !hideType && <p className="text-xs text-fg-subtle">{t('wf.actor.fieldHint')}</p>}
    </div>
  );
}

/** The stage's actor rules (OR-ed). Empty = anyone holding the stage permission. */
export function ActorsEditor({ value, onChange, ctx, disabled }: { value: WorkflowActor[]; onChange: (v: WorkflowActor[]) => void; ctx: ActorContext; disabled?: boolean }) {
  const typesUsed = useMemo(() => new Set(value.map(a => a.type)), [value]);
  return (
    <div className="space-y-2" data-testid="wf-prop-actors">
      {value.length === 0 && <p className="rounded border border-dashed border-border px-3 py-2 text-sm text-fg-muted">{t('wf.actor.anyoneHint')}</p>}
      {value.map((a, i) => (
        <div key={i} className="flex items-start gap-1.5">
          {i > 0 && <span className="sr-only">{t('wf.card.or')}</span>}
          <ActorControl value={a} ctx={ctx} testId={`wf-prop-actor-${i}`} onChange={next => onChange(value.map((x, j) => (j === i ? next : x)))} />
          <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t('wf.actor.remove')} data-testid={`wf-prop-actor-${i}-remove`}><X aria-hidden /></Button>
        </div>
      ))}
      {value.length < 10 && (
        <Button variant="secondary" size="sm" disabled={disabled} data-testid="wf-prop-actor-add"
          onClick={() => onChange([...value, defaultActor(!typesUsed.has('role') && ctx.roles.length ? 'role' : 'users', ctx)])}>
          <Plus aria-hidden />{t('wf.actor.add')}
        </Button>
      )}
    </div>
  );
}

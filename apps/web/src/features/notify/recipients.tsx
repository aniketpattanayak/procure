'use client';
import type { FormDefinition, RoleRow } from '@procure/schema';
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input, NativeSelect, Switch,
} from '@procure/ui';
import { AtSign, Building2, Plus, Shield, TextCursorInput, User, UserCheck, Users, X } from 'lucide-react';
import { useMemo } from 'react';
import { t, type MessageKey } from '@/i18n';
import { UserPicker } from '@/features/workflows/actors';
import { useUserOptions } from '@/features/workflows/api';
import type { MessageChannel, TriggerRecipientSpec } from './api';

export type RecipientType = TriggerRecipientSpec['type'];
const TYPES: RecipientType[] = ['party', 'submitter', 'role', 'users', 'stage_actors', 'field', 'fixed'];
const ICON = { party: Building2, submitter: User, role: Shield, users: Users, stage_actors: UserCheck, field: TextCursorInput, fixed: AtSign } as const;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+[1-9]\d{7,14}$/;

export function addressError(channel: MessageChannel, a: string): string | null {
  const v = a.trim();
  if (!v) return t('trigger.rcpt.addressRequired');
  if (channel === 'email' && !EMAIL_RE.test(v)) return t('trigger.rcpt.badEmail');
  if (channel === 'whatsapp' && !PHONE_RE.test(v)) return t('trigger.rcpt.badPhone');
  return null;
}

function blank(type: RecipientType): TriggerRecipientSpec {
  switch (type) {
    case 'role': return { type, roleId: '', withinScope: true };
    case 'users': return { type, userIds: [] };
    case 'stage_actors': return { type, stage: '' };
    case 'field': return { type, field: '' };
    case 'fixed': return { type, address: '' };
    default: return { type } as TriggerRecipientSpec;
  }
}

/**
 * Who receives a rule's message. Each row is one recipient source; the server resolves addresses at send time
 * (party email/phone from the vendor master, users' email/phone, role holders within the document's location scope).
 */
export function RecipientsBuilder({ value, onChange, channel, roles, stages, header, docScoped, errors }: {
  value: TriggerRecipientSpec[]; onChange: (v: TriggerRecipientSpec[]) => void; channel: MessageChannel; roles: RoleRow[];
  stages: { key: string; name: string }[]; header: FormDefinition | null; docScoped: boolean; errors?: Record<number, string>;
}) {
  const users = useUserOptions('');
  const names = useMemo(() => new Map((users.data ?? []).map(u => [u.id, u.name])), [users.data]);
  const contactFields = useMemo(() => (header?.fields ?? [])
    .filter(f => !('removed' in f && f.removed) && (f.type === 'email' || f.type === 'phone' || (f.type === 'lookup' && 'source' in f && (f.source as { kind?: string }).kind === 'user')))
    .map(f => ({ key: f.key, label: 'label' in f ? String(f.label) : f.key, type: f.type })), [header]);
  const docOnly: RecipientType[] = ['party', 'submitter', 'stage_actors', 'field'];
  const available = TYPES.filter(x => (docScoped || !docOnly.includes(x)) && (x !== 'fixed' || channel !== 'inapp'));
  const update = (i: number, next: TriggerRecipientSpec) => onChange(value.map((r, j) => (j === i ? next : r)));

  return (
    <div className="space-y-2" data-testid="trigger-recipients">
      {!value.length && <p className="rounded border border-dashed border-border-strong px-3 py-3 text-sm text-fg-muted">{t('trigger.rcpt.empty')}</p>}
      <ul className="space-y-2">
        {value.map((r, i) => {
          const Icon = ICON[r.type];
          return (
            <li key={i} className="rounded-lg border border-border bg-surface p-2.5" data-testid={`trigger-recipient-${i}`} data-type={r.type}>
              <div className="flex items-start gap-2.5">
                <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-subtle text-fg-muted"><Icon className="size-3.5" aria-hidden /></span>
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="pt-1 text-sm font-medium">{t(`trigger.rcpt.type.${r.type}` as MessageKey)}</p>
                  {r.type === 'party' && <p className="text-xs text-fg-muted">{t(channel === 'whatsapp' ? 'trigger.rcpt.partyPhone' : 'trigger.rcpt.partyEmail')}</p>}
                  {r.type === 'submitter' && <p className="text-xs text-fg-muted">{t('trigger.rcpt.submitterHint')}</p>}
                  {r.type === 'role' && (
                    <div className="flex flex-wrap items-center gap-3">
                      <NativeSelect aria-label={t('trigger.rcpt.role')} value={r.roleId} onChange={e => update(i, { ...r, roleId: e.target.value })} className="h-8 w-auto min-w-[12rem] text-sm" data-testid={`trigger-recipient-${i}-role`}>
                        <option value="">{t('trigger.rcpt.chooseRole')}</option>
                        {roles.map(ro => <option key={ro.id} value={ro.id}>{ro.name}</option>)}
                      </NativeSelect>
                      {docScoped && (
                        <label className="flex items-center gap-2 text-sm">
                          <Switch checked={r.withinScope !== false} onCheckedChange={c => update(i, { ...r, withinScope: c })} data-testid={`trigger-recipient-${i}-scope`} />
                          {t('trigger.rcpt.withinScope')}
                        </label>
                      )}
                    </div>
                  )}
                  {r.type === 'users' && (
                    <UserPicker value={r.userIds} onChange={ids => update(i, { ...r, userIds: ids })} userName={id => names.get(id) ?? id.slice(0, 8)} testId={`trigger-recipient-${i}-users`} label={t('trigger.rcpt.type.users')} />
                  )}
                  {r.type === 'stage_actors' && (
                    <NativeSelect aria-label={t('trigger.rcpt.stage')} value={r.stage} onChange={e => update(i, { ...r, stage: e.target.value })} className="h-8 w-auto min-w-[12rem] text-sm" data-testid={`trigger-recipient-${i}-stage`}>
                      <option value="">{t('trigger.rcpt.chooseStage')}</option>
                      <option value="_current">{t('trigger.rcpt.currentStage')}</option>
                      {stages.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                      {r.stage && r.stage !== '_current' && !stages.some(s => s.key === r.stage) && <option value={r.stage}>{r.stage}</option>}
                    </NativeSelect>
                  )}
                  {r.type === 'field' && (
                    <NativeSelect aria-label={t('trigger.rcpt.field')} value={r.field} onChange={e => update(i, { ...r, field: e.target.value })} className="h-8 w-auto min-w-[12rem] text-sm" data-testid={`trigger-recipient-${i}-field`}>
                      <option value="">{contactFields.length ? t('trigger.rcpt.chooseField') : t('trigger.rcpt.noFields')}</option>
                      {contactFields.map(f => <option key={f.key} value={f.key}>{f.label} ({t(`trigger.rcpt.fieldType.${f.type === 'lookup' ? 'user' : f.type}` as MessageKey)})</option>)}
                    </NativeSelect>
                  )}
                  {r.type === 'fixed' && (
                    <Input value={r.address} onChange={e => update(i, { ...r, address: e.target.value })} inputMode={channel === 'whatsapp' ? 'tel' : 'email'}
                      placeholder={channel === 'whatsapp' ? '+919812345678' : 'purchase@example.com'} aria-label={t('trigger.rcpt.address')} className="h-8 max-w-sm text-sm"
                      aria-invalid={!!(r.address && addressError(channel, r.address))} data-testid={`trigger-recipient-${i}-address`} />
                  )}
                  {r.type === 'fixed' && r.address && addressError(channel, r.address) && <p className="text-xs text-danger">{addressError(channel, r.address)}</p>}
                  {errors?.[i] && <p className="text-xs text-danger">{errors[i]}</p>}
                </div>
                <Button size="icon-sm" variant="ghost" aria-label={t('trigger.rcpt.remove')} onClick={() => onChange(value.filter((_, j) => j !== i))} data-testid={`trigger-recipient-${i}-remove`}><X aria-hidden /></Button>
              </div>
            </li>
          );
        })}
      </ul>
      {value.length < 20 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="secondary" size="sm" data-testid="trigger-recipient-add"><Plus aria-hidden />{t('trigger.rcpt.add')}</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {available.map(x => {
              const Icon = ICON[x];
              return <DropdownMenuItem key={x} onSelect={() => onChange([...value, blank(x)])} data-testid={`trigger-recipient-add-${x}`}><Icon className="size-4" aria-hidden />{t(`trigger.rcpt.type.${x}` as MessageKey)}</DropdownMenuItem>;
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** One-line description of a recipient spec for lists. */
export function describeRecipient(r: TriggerRecipientSpec, roleName: (id: string) => string | undefined): string {
  switch (r.type) {
    case 'role': return t('trigger.rcpt.sum.role', { role: roleName(r.roleId) ?? '?' });
    case 'users': return t('trigger.rcpt.sum.users', { n: r.userIds.length });
    case 'stage_actors': return r.stage === '_current' ? t('trigger.rcpt.sum.currentStage') : t('trigger.rcpt.sum.stage', { stage: r.stage });
    case 'field': return t('trigger.rcpt.sum.field', { field: r.field });
    case 'fixed': return r.address;
    default: return t(`trigger.rcpt.type.${r.type}` as MessageKey);
  }
}


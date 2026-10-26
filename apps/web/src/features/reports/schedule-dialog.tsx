'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { ScheduleInput } from '@procure/schema';
import { Button, Dialog, DialogContent, FormField, Input, Segmented, Skeleton, StatusBadge, toast } from '@procure/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Mail, Trash2, User, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { InlineAlert } from '@/components/page';
import { docsApi } from '@/features/documents/api';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useTenantPrincipal } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { reportKeys, reportsApi } from './api';
import type { ExportFormat, ScheduleRow } from './types';

export const CRON_PRESETS = [
  { key: 'daily', cron: '0 9 * * *' },
  { key: 'weekly', cron: '0 9 * * 1' },
  { key: 'monthly', cron: '0 9 1 * *' },
] as const;
type Freq = (typeof CRON_PRESETS)[number]['key'] | 'custom';

export function describeCron(cron: string) {
  const p = CRON_PRESETS.find(x => x.cron === cron);
  return p ? t(`report.schedule.freq.${p.key}Long` as 'report.schedule.freq.dailyLong') : t('report.schedule.cron', { cron });
}

const Form = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'custom']),
  cron: z.string().regex(/^(\S+\s){4}\S+$/, t('report.schedule.cronInvalid')),
  format: z.enum(['xlsx', 'csv', 'pdf']),
  recipients: ScheduleInput.shape.recipients,
});
type FormValues = z.infer<typeof Form>;
type Recipient = FormValues['recipients'][number];

function RecipientPicker({ value, onChange, names, setNames }: { value: Recipient[]; onChange: (v: Recipient[]) => void; names: Record<string, string>; setNames: (n: Record<string, string>) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.trim());
  const users = useQuery({ queryKey: ['users-options', dq], queryFn: ({ signal }) => docsApi.userOptions(dq, signal), enabled: dq.trim().length > 0, staleTime: 60_000 });
  const add = (r: Recipient) => {
    if (value.some(v => (v.type === 'user' && r.type === 'user' && v.userId === r.userId) || (v.type === 'email' && r.type === 'email' && v.address.toLowerCase() === r.address.toLowerCase()))) return;
    onChange([...value, r]);
    setQ('');
  };
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" data-testid="report-schedule-recipients">
          {value.map((r, i) => (
            <li key={i} className="flex items-center gap-1 rounded-full border border-border bg-subtle py-0.5 pl-2 pr-1 text-sm">
              {r.type === 'user' ? <User className="size-3.5 text-fg-subtle" aria-hidden /> : <Mail className="size-3.5 text-fg-subtle" aria-hidden />}
              <span className="max-w-[14rem] truncate">{r.type === 'user' ? names[r.userId] ?? t('report.schedule.user') : r.address}</span>
              <button type="button" className="rounded-full p-0.5 text-fg-subtle hover:bg-muted hover:text-fg" aria-label={t('report.schedule.removeRecipient')} onClick={() => onChange(value.filter((_, j) => j !== i))}><X className="size-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t('report.schedule.recipientsHint')} aria-label={t('report.schedule.addRecipient')} data-testid="report-schedule-recipient-input"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (isEmail) add({ type: 'email', address: q.trim() }); } }} />
        {q.trim() && (
          <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded border border-border bg-surface py-1 shadow-pop" role="listbox" aria-label={t('report.schedule.addRecipient')}>
            {isEmail && (
              <li role="option" aria-selected={false}><button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-subtle" onClick={() => add({ type: 'email', address: q.trim() })} data-testid="report-schedule-add-email"><Mail className="size-4 text-fg-subtle" aria-hidden />{t('report.schedule.addEmail', { email: q.trim() })}</button></li>
            )}
            {(users.data ?? []).map(u => (
              <li key={u.id} role="option" aria-selected={false}>
                <button type="button" className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-subtle" data-testid="report-schedule-user-option"
                  onClick={() => { setNames({ ...names, [u.id]: u.name }); add({ type: 'user', userId: u.id }); }}>
                  <span>{u.name}</span><span className="text-sm text-fg-muted">{u.email}</span>
                </button>
              </li>
            ))}
            {!isEmail && users.data?.length === 0 && <li className="px-3 py-1.5 text-sm text-fg-muted">{t('report.schedule.noUsers')}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Schedule a report by email: frequency presets (daily 9am, weekly Monday, monthly on the 1st) or a cron, format, recipients. */
export function ScheduleDialog({ open, onOpenChange, reportId, reportName, params }: { open: boolean; onOpenChange: (o: boolean) => void; reportId: string; reportName: string; params: Record<string, unknown> }) {
  const me = useTenantPrincipal();
  const qc = useQueryClient();
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const schedules = useQuery({ queryKey: reportKeys.schedules(reportId), queryFn: () => reportsApi.schedules(reportId), enabled: open, retry: false });
  const defaults = useMemo<FormValues>(() => ({ freq: 'weekly', cron: '0 9 * * 1', format: 'xlsx', recipients: me ? [{ type: 'user', userId: me.userId }] : [] }), [me]);
  const form = useForm<FormValues>({ resolver: zodResolver(Form), defaultValues: defaults });
  useEffect(() => { if (open) { form.reset(defaults); setError(null); if (me) setNames(n => ({ ...n, [me.userId]: t('report.schedule.you', { name: me.name }) })); } }, [open, defaults, form, me]);
  const freq = form.watch('freq');

  const add = useMutation({
    mutationFn: (v: FormValues) => reportsApi.addSchedule(reportId, { cron: v.cron, format: v.format, recipients: v.recipients, params, isActive: true }),
    onSuccess: () => { toast.success(t('report.schedule.saved'), describeCron(form.getValues('cron'))); void qc.invalidateQueries({ queryKey: reportKeys.schedules(reportId) }); onOpenChange(false); },
    onError: e => setError(isApiError(e) ? e.message : String(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => reportsApi.removeSchedule(reportId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: reportKeys.schedules(reportId) }),
    onError: e => toast.error(isApiError(e) ? e.message : t('report.schedule.removeError')),
  });

  const existing: ScheduleRow[] = schedules.data ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" title={t('report.schedule.title')} description={t('report.schedule.subtitle', { name: reportName })} data-testid="report-schedule-dialog"
        footer={(
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button onClick={form.handleSubmit(v => { setError(null); add.mutate(v); })} loading={add.isPending} data-testid="report-schedule-save">{t('report.schedule.save')}</Button>
          </>
        )}>
        <div className="space-y-4">
          {error && <InlineAlert data-testid="report-schedule-error">{error}</InlineAlert>}
          <FormField label={t('report.schedule.frequency')}>
            <Controller control={form.control} name="freq" render={({ field }) => (
              <Segmented<Freq> label={t('report.schedule.frequency')} value={field.value} data-testid="report-schedule-freq"
                onChange={v => { field.onChange(v); const p = CRON_PRESETS.find(x => x.key === v); if (p) form.setValue('cron', p.cron, { shouldValidate: true }); }}
                options={[...CRON_PRESETS.map(p => ({ value: p.key as Freq, label: t(`report.schedule.freq.${p.key}` as 'report.schedule.freq.daily') })), { value: 'custom' as Freq, label: t('report.schedule.freq.custom') }]} />
            )} />
          </FormField>
          {freq === 'custom' ? (
            <FormField label={t('report.schedule.cronLabel')} hint={t('report.schedule.cronHint')} error={form.formState.errors.cron?.message}>
              <Input {...form.register('cron')} className="font-mono" data-testid="report-schedule-cron" />
            </FormField>
          ) : (
            <p className="flex items-center gap-2 text-sm text-fg-muted"><CalendarClock className="size-4" aria-hidden />{describeCron(form.watch('cron'))}</p>
          )}
          <FormField label={t('report.schedule.format')}>
            <Controller control={form.control} name="format" render={({ field }) => (
              <Segmented<ExportFormat> label={t('report.schedule.format')} value={field.value} onChange={field.onChange} data-testid="report-schedule-format"
                options={(['xlsx', 'csv', 'pdf'] as const).map(f => ({ value: f, label: t(`export.format.${f}` as 'export.format.xlsx') }))} />
            )} />
          </FormField>
          <FormField label={t('report.schedule.recipients')} error={form.formState.errors.recipients?.message ?? form.formState.errors.recipients?.root?.message}>
            <Controller control={form.control} name="recipients" render={({ field }) => <RecipientPicker value={field.value} onChange={field.onChange} names={names} setNames={setNames} />} />
          </FormField>
          {Object.keys(params).length > 0 && <p className="text-sm text-fg-muted">{t('report.schedule.paramsNote')}</p>}

          <section aria-labelledby="sched-existing" className="border-t border-border pt-3">
            <h3 id="sched-existing" className="mb-2 text-sm font-medium text-fg-muted">{t('report.schedule.existing')}</h3>
            {schedules.isLoading ? <Skeleton className="h-10" /> : existing.length === 0 ? (
              <p className="text-sm text-fg-subtle">{t('report.schedule.none')}</p>
            ) : (
              <ul className="divide-y divide-border rounded border border-border" data-testid="report-schedule-list">
                {existing.map(s => (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm" data-testid="report-schedule-row">
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{describeCron(s.cron)} <span className="uppercase text-fg-subtle">{s.format}</span></p>
                      <p className="truncate text-fg-muted">{t('report.schedule.recipientsCount', { n: s.recipients.length })}{s.nextRunAt ? ` · ${t('report.schedule.next', { when: fmtDateTime(s.nextRunAt) })}` : ''}</p>
                    </div>
                    {!s.isActive && <StatusBadge tone="neutral">{t('report.schedule.paused')}</StatusBadge>}
                    <Button variant="ghost" size="icon-sm" aria-label={t('report.schedule.remove')} onClick={() => remove.mutate(s.id)} data-testid="report-schedule-remove"><Trash2 aria-hidden /></Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

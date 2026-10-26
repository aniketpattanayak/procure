'use client';
import type { DocumentRow, FollowupRow } from '@procure/schema';
import { FollowupInput } from '@procure/schema';
import { Button, Card, FormField, Input, NativeSelect, Segmented, Skeleton, Textarea, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Mail, MapPin, MessageCircle, MoreHorizontal, Phone } from 'lucide-react';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { docKeys } from '@/features/documents/api';
import { lineItemLabel } from '@/features/documents/lines-table';
import { procApi, procKeys, type FollowupBody } from '../api';
import { fmtShortDate } from '../calc';

type Mode = 'call' | 'email' | 'whatsapp' | 'visit' | 'other';
const MODE_ICON = { call: Phone, email: Mail, whatsapp: MessageCircle, visit: MapPin, other: MoreHorizontal } as const;

/** Current expected date: latest follow-up revision, else the PO header value. */
export function currentExpected(doc: DocumentRow, rows: FollowupRow[] | undefined): string | null {
  const rev = (rows ?? []).filter(r => r.revisedExpectedDate && !r.lineId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return rev?.revisedExpectedDate ?? (typeof doc.values.expected_date === 'string' ? doc.values.expected_date : null);
}

/** PO follow-ups: log a vendor contact (optionally revising the expected date) and the append-only history. */
export function FollowupsPanel({ doc, canLog, onChanged }: { doc: DocumentRow; canLog: boolean; onChanged: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: procKeys.followups(doc.id), queryFn: () => procApi.followups(doc.id), retry: false });
  const expected = currentExpected(doc, list.data);
  const [d, setD] = useState({ mode: 'call' as Mode, person: '', lineId: '', promised: '', revised: '', reason: '', notes: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof d, v: string) => setD(x => ({ ...x, [k]: v }));

  const submit = async () => {
    setFormError(null);
    const body: FollowupBody = {
      contactMode: d.mode,
      ...(d.lineId ? { lineId: d.lineId } : {}),
      ...(d.person.trim() ? { contactPerson: d.person.trim() } : {}),
      ...(d.promised ? { promisedDate: d.promised } : {}),
      ...(d.revised ? { revisedExpectedDate: d.revised } : {}),
      ...(d.reason.trim() ? { reason: d.reason.trim() } : {}),
      ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
    };
    const parsed = FollowupInput.safeParse(body);
    if (!parsed.success) {
      const e: Record<string, string> = {};
      for (const i of parsed.error.issues) e[String(i.path[0] ?? 'form')] = i.path[0] === 'reason' ? t('po.fu.err.reason') : i.message;
      setErrors(e);
      return;
    }
    if (!d.notes.trim() && !d.revised && !d.promised) { setErrors({ notes: t('po.fu.err.empty') }); return; }
    setErrors({});
    setSaving(true);
    try {
      await procApi.addFollowup(doc.id, body);
      toast.success(d.revised ? t('po.fu.loggedDate', { date: fmtShortDate(d.revised) }) : t('po.fu.logged'));
      setD({ mode: d.mode, person: d.person, lineId: '', promised: '', revised: '', reason: '', notes: '' });
      void qc.invalidateQueries({ queryKey: procKeys.followups(doc.id) });
      void qc.invalidateQueries({ queryKey: docKeys.timeline('po', doc.id) });
      onChanged();
    } catch (e) {
      if (isApiError(e)) {
        const fe: Record<string, string> = {};
        for (const x of e.errors) if (x.path) fe[x.path] = x.message;
        setErrors(fe);
        setFormError(e.message);
      } else setFormError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const lines = [...doc.lines].sort((a, b) => a.lineNo - b.lineNo);
  const lineNo = (id: string | null) => (id ? lines.find(l => l.id === id)?.lineNo ?? null : null);

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]" data-testid="followup-panel">
      {canLog ? (
        <Card className="h-fit space-y-4 p-4" data-testid="followup-form">
          <div>
            <h3 className="font-semibold">{t('po.fu.logTitle')}</h3>
            <p className="text-sm text-fg-muted" data-testid="followup-expected" data-value={expected ?? ''}>{expected ? t('po.fu.expectedNow', { date: fmtShortDate(expected) }) : t('po.fu.noExpected')}</p>
          </div>
          {formError && <InlineAlert data-testid="followup-error">{formError}</InlineAlert>}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t('po.fu.mode')}</span>
            <Segmented<Mode> label={t('po.fu.mode')} value={d.mode} onChange={v => set('mode', v)} className="w-full overflow-x-auto" data-testid="followup-mode"
              options={(['call', 'email', 'whatsapp', 'visit', 'other'] as Mode[]).map(m => ({ value: m, label: t(`po.fu.mode.${m}` as 'po.fu.mode.call') }))} />
          </div>
          <FormField label={t('po.fu.person')}>
            <Input value={d.person} onChange={e => set('person', e.target.value)} maxLength={120} data-testid="followup-person" />
          </FormField>
          <FormField label={t('po.fu.line')} hint={t('po.fu.lineHint')}>
            <NativeSelect value={d.lineId} onChange={e => set('lineId', e.target.value)} data-testid="followup-line">
              <option value="">{t('po.fu.wholePo')}</option>
              {lines.map(l => <option key={l.id} value={l.id}>{`${l.lineNo}. ${lineItemLabel(l)}`}</option>)}
            </NativeSelect>
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label={t('po.fu.promised')} error={errors.promisedDate}>
              <Input type="date" value={d.promised} onChange={e => set('promised', e.target.value)} data-testid="followup-promised" />
            </FormField>
            <FormField label={t('po.fu.revised')} error={errors.revisedExpectedDate}>
              <Input type="date" value={d.revised} onChange={e => set('revised', e.target.value)} data-testid="followup-revised" />
            </FormField>
          </div>
          {d.revised && (
            <FormField label={t('po.fu.reason')} required error={errors.reason} hint={expected ? t('po.fu.changeHint', { from: fmtShortDate(expected), to: fmtShortDate(d.revised) }) : undefined}>
              <Input value={d.reason} onChange={e => set('reason', e.target.value)} maxLength={500} data-testid="followup-reason" />
            </FormField>
          )}
          <FormField label={t('po.fu.notes')} error={errors.notes}>
            <Textarea rows={3} value={d.notes} onChange={e => set('notes', e.target.value)} data-testid="followup-notes" />
          </FormField>
          <Button className="w-full" onClick={submit} loading={saving} data-testid="followup-submit">{t('po.fu.submit')}</Button>
        </Card>
      ) : (
        <p className="text-sm text-fg-muted" data-testid="followup-expected" data-value={expected ?? ''}>{expected ? t('po.fu.expectedNow', { date: fmtShortDate(expected) }) : t('po.fu.noExpected')}</p>
      )}

      <section aria-labelledby="fu-history-h" className="min-w-0">
        <h3 id="fu-history-h" className="mb-2 font-semibold">{t('po.fu.history')}</h3>
        {list.isLoading ? <Skeleton className="h-40 w-full" /> : list.isError ? (
          <InlineAlert>{isApiError(list.error) ? list.error.message : t('po.fu.failed')}</InlineAlert>
        ) : (list.data ?? []).length === 0 ? (
          <p className="rounded border border-dashed border-border px-3 py-8 text-center text-fg-muted" data-testid="followup-empty">{t('po.fu.empty')}</p>
        ) : (
          <ol className="relative space-y-3 border-l border-border pl-5" data-testid="followup-list">
            {[...list.data!].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(f => {
              const Icon = MODE_ICON[(f.contactMode as Mode) in MODE_ICON ? (f.contactMode as Mode) : 'other'];
              const ln = f.lineNo ?? lineNo(f.lineId);
              return (
                <li key={f.id} className="relative" data-testid="followup-row" data-id={f.id}>
                  <span className="absolute -left-[1.85rem] top-0.5 grid size-5 place-items-center rounded-full border border-border bg-surface text-fg-muted"><Icon className="size-3" aria-hidden /></span>
                  <p className="text-sm">
                    <span className="font-medium">{t(`po.fu.mode.${(f.contactMode as Mode) in MODE_ICON ? f.contactMode : 'other'}` as 'po.fu.mode.call')}</span>
                    {f.contactPerson && <span className="text-fg-muted"> {t('po.fu.with', { name: f.contactPerson })}</span>}
                    {ln !== null && <span className="text-fg-muted"> · {t('po.fu.lineN', { n: ln })}</span>}
                  </p>
                  {f.revisedExpectedDate && (
                    <p className="mt-1 inline-flex flex-wrap items-center gap-1.5 rounded bg-warning-soft px-2 py-1 text-sm text-warning" data-testid="followup-change">
                      <CalendarClock className="size-3.5" aria-hidden />
                      <span className="font-medium tabular-nums">{t('po.fu.change', { from: fmtShortDate(f.previousExpectedDate), to: fmtShortDate(f.revisedExpectedDate) })}</span>
                      {f.reason && <span>({f.reason})</span>}
                    </p>
                  )}
                  {f.promisedDate && <p className="mt-1 text-sm">{t('po.fu.promisedOn', { date: fmtShortDate(f.promisedDate) })}</p>}
                  {f.notes && <p className="mt-1 whitespace-pre-wrap text-sm">{f.notes}</p>}
                  <p className="mt-1 text-xs text-fg-subtle">{f.createdBy.name} · {fmtDateTime(f.createdAt)}</p>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

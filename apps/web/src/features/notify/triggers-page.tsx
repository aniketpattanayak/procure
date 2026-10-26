'use client';
import { TriggerRuleInput } from '@procure/schema';
import {
  Badge, Button, EmptyState, Input, Label, NativeSelect, Segmented, Sheet, SheetContent, Skeleton, SkeletonGroup, StatusBadge, Switch, toast,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Hand, Plus, Trash2, Zap } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { FormulaEditor } from '@/engines/formula-editor';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useSession } from '@/lib/session';
import { useDocTypes } from '@/features/documents/api';
import { combinedDefinition } from '@/features/workflows/model';
import { useFormDefinition, useRoles, workflowsApi } from '@/features/workflows/api';
import {
  notifyKeys, templatesApi, triggersApi, type MessageChannel, type TriggerBody, type TriggerEvent, type TriggerRuleRow,
} from './api';
import { addressError, describeRecipient, RecipientsBuilder } from './recipients';
import { ChannelTag, channelLabel } from './ui';

function useAllowedMessageChannels(): MessageChannel[] {
  const { features } = useSession();
  return (['email', 'whatsapp', 'inapp'] as MessageChannel[]).filter(c => c === 'inapp' || features.has(c));
}

/** /config/triggers: "when EVENT on DOC TYPE (and CONDITION) → send TEMPLATE to RECIPIENTS via CHANNEL". */
export function TriggersPage() {
  const p = usePermissions();
  const qc = useQueryClient();
  const canEdit = p.has('config.triggers:action.edit');
  const list = useQuery({ queryKey: notifyKeys.triggers, queryFn: triggersApi.list });
  const events = useQuery({ queryKey: notifyKeys.events, queryFn: triggersApi.events, staleTime: 5 * 60_000 });
  const templates = useQuery({ queryKey: notifyKeys.templatesAll, queryFn: () => templatesApi.list(), retry: false });
  const docTypes = useDocTypes();
  const roles = useRoles();
  const [editing, setEditing] = useState<TriggerRuleRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<TriggerRuleRow | null>(null);

  const eventLabel = useMemo(() => new Map((events.data ?? []).map(e => [e.type, e.label])), [events.data]);
  const typeName = useMemo(() => new Map((docTypes.data ?? []).map(d => [d.key, d.name])), [docTypes.data]);
  const tplName = useMemo(() => new Map((templates.data ?? []).map(x => [x.id, x.name])), [templates.data]);
  const roleName = useMemo(() => { const m = new Map((roles.data ?? []).map(r => [r.id, r.name])); return (id: string) => m.get(id); }, [roles.data]);
  const rows = [...(list.data ?? [])].sort((a, b) => (a.docTypeKey ?? '').localeCompare(b.docTypeKey ?? '') || a.name.localeCompare(b.name));

  async function toggle(r: TriggerRuleRow) {
    try {
      const { id: _id, version, ...rest } = r;
      await triggersApi.update(r.id, { ...rest, isActive: !r.isActive, version });
      void qc.invalidateQueries({ queryKey: notifyKeys.triggers });
      toast.success(r.isActive ? t('trigger.paused') : t('trigger.resumed'));
    } catch (e) {
      toast.error(t('trigger.saveFailed'), isApiError(e) ? e.message : undefined);
    }
  }

  return (
    <PageBody>
      <PageHeader title={t('trigger.title')} description={t('trigger.description')}
        actions={canEdit && <Button onClick={() => setEditing('new')} data-testid="trigger-new"><Plus aria-hidden />{t('trigger.new')}</Button>} />
      {list.isLoading ? (
        <SkeletonGroup className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20" />)}</SkeletonGroup>
      ) : list.error ? (
        <EmptyState title={isApiError(list.error) ? list.error.message : t('table.error')} action={<Button variant="secondary" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} />
      ) : !rows.length ? (
        <EmptyState icon={<BellRing />} title={t('trigger.empty')} description={t('trigger.emptyHint')}
          action={canEdit ? <Button onClick={() => setEditing('new')}>{t('trigger.new')}</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface" data-testid="trigger-list">
          {rows.map(r => (
            <li key={r.id} className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center ${r.isActive ? '' : 'bg-subtle/60'}`} data-testid={`trigger-row-${r.id}`} data-active={r.isActive} data-mode={r.mode}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="text-left font-medium hover:text-accent hover:underline" onClick={() => setEditing(r)} data-testid={`trigger-open-${r.id}`}>{r.name}</button>
                  {r.mode === 'manual'
                    ? <Badge tone="neutral" title={t('trigger.mode.manualHint')}><Hand className="size-3" aria-hidden />{t('trigger.mode.manual')}</Badge>
                    : <Badge tone="accent" title={t('trigger.mode.autoHint')}><Zap className="size-3" aria-hidden />{t('trigger.mode.auto')}</Badge>}
                  {!r.isActive && <StatusBadge>{t('trigger.inactive')}</StatusBadge>}
                </div>
                {/* The rule as a sentence: When <event> on <doc type> [if …] → <channel> <template> to <recipients> */}
                <p className="mt-1 text-sm text-fg-muted">
                  {t('trigger.sentence.when')} <strong className="font-medium text-fg">{eventLabel.get(r.eventType) ?? r.eventType}</strong>
                  {' '}{t('trigger.sentence.on')} <strong className="font-medium text-fg">{r.docTypeKey ? typeName.get(r.docTypeKey) ?? r.docTypeKey : t('trigger.anyDocType')}</strong>
                  {r.condition && <> {t('trigger.sentence.if')} <code className="rounded bg-subtle px-1 text-xs text-fg">{r.condition}</code></>}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-fg-muted">
                  <ChannelTag channel={r.channel} className="text-fg" />
                  <span>{tplName.get(r.templateId) ?? t('trigger.templateMissing')}</span>
                  <span aria-hidden>→</span>
                  <span>{r.recipients.map(x => describeRecipient(x, roleName)).join(', ')}</span>
                  {r.attachPdfTemplateId && <Badge tone="neutral">{t('trigger.withPdf', { name: tplName.get(r.attachPdfTemplateId) ?? 'PDF' })}</Badge>}
                </p>
              </div>
              {canEdit && (
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-sm text-fg-muted">
                    <Switch checked={r.isActive} onCheckedChange={() => void toggle(r)} aria-label={t('trigger.activeToggle')} data-testid={`trigger-toggle-${r.id}`} />
                    <span className="sr-only sm:not-sr-only">{r.isActive ? t('trigger.on') : t('trigger.off')}</span>
                  </label>
                  <Button size="icon-sm" variant="ghost" aria-label={t('trigger.delete')} onClick={() => setRemoving(r)} data-testid={`trigger-delete-${r.id}`}><Trash2 aria-hidden /></Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Sheet open={!!editing} onOpenChange={o => { if (!o) setEditing(null); }}>
        {editing && (
          <SheetContent side="right" title={editing === 'new' ? t('trigger.new') : t('trigger.editTitle', { name: editing.name })} closeLabel={t('common.close')}
            className="w-full max-w-none sm:w-[42rem] sm:max-w-[42rem]" data-testid="trigger-editor">
            <TriggerEditor row={editing === 'new' ? null : editing} events={events.data ?? []} canEdit={canEdit}
              onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: notifyKeys.triggers }); }} />
          </SheetContent>
        )}
      </Sheet>
      <ConfirmDialog open={!!removing} onOpenChange={o => !o && setRemoving(null)} testId="trigger-delete-dialog" tone="danger"
        title={t('trigger.deleteTitle', { name: removing?.name ?? '' })} description={t('trigger.deleteHint')} confirmLabel={t('trigger.delete')}
        onConfirm={async () => { await triggersApi.remove(removing!.id); toast.success(t('trigger.deleted')); void qc.invalidateQueries({ queryKey: notifyKeys.triggers }); }} />
    </PageBody>
  );
}

function Row({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-fg-muted">{hint}</p>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

function TriggerEditor({ row, events, canEdit, onSaved }: { row: TriggerRuleRow | null; events: TriggerEvent[]; canEdit: boolean; onSaved: () => void }) {
  const allowed = useAllowedMessageChannels();
  const [v, setV] = useState<TriggerBody>(() => row
    ? { name: row.name, eventType: row.eventType, docTypeKey: row.docTypeKey ?? null, condition: row.condition ?? '', channel: row.channel, templateId: row.templateId, recipients: row.recipients, attachPdfTemplateId: row.attachPdfTemplateId, mode: row.mode, isActive: row.isActive }
    : { name: '', eventType: '', docTypeKey: null, condition: '', channel: allowed[0] ?? 'inapp', templateId: '', recipients: [{ type: 'party' }], mode: 'manual', isActive: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rcptErrors, setRcptErrors] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof TriggerBody>(k: K, val: TriggerBody[K]) => setV(s => ({ ...s, [k]: val }));
  const ids = { name: useId(), event: useId(), doc: useId(), tpl: useId(), pdf: useId() };

  const docTypes = useDocTypes();
  const roles = useRoles();
  const docType = docTypes.data?.find(d => d.key === v.docTypeKey) ?? null;
  const event = events.find(e => e.type === v.eventType);
  const docScoped = event ? event.docScoped : true;
  const header = useFormDefinition(docType?.headerFormKey);
  const line = useFormDefinition(docType?.lineFormKey);
  // Conditions also see the event's pseudo fields (CONDITION_PSEUDO_FIELDS in the notify module).
  const definition = useMemo(() => {
    const d = combinedDefinition(header.data, line.data);
    const pseudo = [['doc_status', t('trigger.pseudo.docStatus')], ['status_to', t('trigger.pseudo.statusTo')]].map(([key, label]) => ({
      key, type: 'text', label, system: true, required: false, readOnly: true, hidden: true, unique: false, removed: false, width: 12,
    }));
    return { ...d, fields: [...d.fields, ...(pseudo as unknown as typeof d.fields)] };
  }, [header.data, line.data]);
  const wf = useQuery({ queryKey: ['wf', v.docTypeKey], queryFn: () => workflowsApi.get(v.docTypeKey!), enabled: !!v.docTypeKey, retry: false, staleTime: 60_000 });
  const stages = (wf.data?.published ?? wf.data?.draft)?.stages.map(s => ({ key: s.key, name: s.name })) ?? [];
  const templates = useQuery({ queryKey: notifyKeys.templatesAll, queryFn: () => templatesApi.list() });
  const forChannel = (templates.data ?? []).filter(x => x.channel === v.channel && x.isActive && (x.docTypeKey === null || x.docTypeKey === v.docTypeKey));
  const pdfs = (templates.data ?? []).filter(x => x.channel === 'pdf' && x.isActive && (x.docTypeKey === null || x.docTypeKey === v.docTypeKey));

  // Event not scoped to a document → no doc type, condition or document-only recipients.
  useEffect(() => {
    if (!docScoped) setV(s => ({ ...s, docTypeKey: null, condition: '', attachPdfTemplateId: undefined, recipients: s.recipients.filter(r => !['party', 'submitter', 'stage_actors', 'field'].includes(r.type)) }));
  }, [docScoped]);
  // Template must match channel and doc type.
  useEffect(() => {
    if (v.templateId && templates.data && !forChannel.some(x => x.id === v.templateId)) set('templateId', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.channel, v.docTypeKey, templates.data]);

  async function save() {
    const body: TriggerBody = {
      ...v,
      condition: v.condition?.trim() || undefined,
      attachPdfTemplateId: v.channel === 'inapp' ? undefined : v.attachPdfTemplateId || undefined,
    };
    const errs: Record<string, string> = {};
    const parsed = TriggerRuleInput.safeParse(body);
    if (!parsed.success) for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
    if (!v.eventType) errs.eventType = t('trigger.err.event');
    if (!v.templateId) errs.templateId = t('trigger.err.template');
    if (!v.recipients.length) errs.recipients = t('trigger.err.recipients');
    const rErr: Record<number, string> = {};
    v.recipients.forEach((r, i) => {
      if (r.type === 'role' && !r.roleId) rErr[i] = t('trigger.rcpt.chooseRole');
      if (r.type === 'users' && !r.userIds.length) rErr[i] = t('trigger.rcpt.pickUsers');
      if (r.type === 'stage_actors' && !r.stage) rErr[i] = t('trigger.rcpt.chooseStage');
      if (r.type === 'field' && !r.field) rErr[i] = t('trigger.rcpt.chooseField');
      if (r.type === 'fixed') { const e = addressError(v.channel, r.address); if (e) rErr[i] = e; }
    });
    setErrors(errs);
    setRcptErrors(rErr);
    if (Object.keys(errs).length || Object.keys(rErr).length) { setError(t('trigger.fixErrors')); return; }
    setSaving(true);
    setError(null);
    try {
      if (row) await triggersApi.update(row.id, { ...body, version: row.version });
      else await triggersApi.create(body);
      toast.success(t('trigger.saved'));
      onSaved();
    } catch (e) {
      if (isApiError(e)) {
        const fe: Record<string, string> = {};
        for (const x of e.errors) if (x.path) fe[x.path.split('.')[0]!] = x.message;
        setErrors(fe);
        setError(e.status === 409 && !e.code.startsWith('LIMIT') ? t('trigger.conflict') : e.message);
      } else setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const docEvents = events.filter(e => e.docScoped);
  const otherEvents = events.filter(e => !e.docScoped);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <Row label={t('trigger.name')} error={errors.name} htmlFor={ids.name}>
          <Input id={ids.name} value={v.name} onChange={e => set('name', e.target.value)} placeholder={t('trigger.namePlaceholder')} data-testid="trigger-name" readOnly={!canEdit} />
        </Row>

        <fieldset className="space-y-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-semibold">{t('trigger.section.when')}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Row label={t('trigger.event')} error={errors.eventType} htmlFor={ids.event}>
              <NativeSelect id={ids.event} value={v.eventType} onChange={e => set('eventType', e.target.value)} data-testid="trigger-event">
                <option value="">{t('trigger.chooseEvent')}</option>
                {!!docEvents.length && <optgroup label={t('trigger.events.doc')}>{docEvents.map(e => <option key={e.type} value={e.type}>{e.label}</option>)}</optgroup>}
                {!!otherEvents.length && <optgroup label={t('trigger.events.other')}>{otherEvents.map(e => <option key={e.type} value={e.type}>{e.label}</option>)}</optgroup>}
              </NativeSelect>
            </Row>
            <Row label={t('trigger.docType')} htmlFor={ids.doc} hint={docScoped ? undefined : t('trigger.docTypeNA')}>
              <NativeSelect id={ids.doc} value={v.docTypeKey ?? ''} onChange={e => set('docTypeKey', e.target.value || null)} disabled={!docScoped} data-testid="trigger-doctype">
                <option value="">{t('trigger.anyDocType')}</option>
                {(docTypes.data ?? []).map(d => <option key={d.key} value={d.key}>{d.name}</option>)}
              </NativeSelect>
            </Row>
          </div>
          {docScoped && (
            <Row label={t('trigger.condition')} hint={v.docTypeKey ? t('trigger.conditionHint') : t('trigger.conditionPickType')} error={errors.condition}>
              {v.docTypeKey ? (
                <FormulaEditor value={v.condition ?? ''} onChange={x => set('condition', x)} definition={definition} expected="boolean" testId="trigger-condition"
                  label={t('trigger.condition')} placeholder="total_amount > 100000" />
              ) : <Input disabled placeholder={t('trigger.conditionPickType')} />}
            </Row>
          )}
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-semibold">{t('trigger.section.send')}</legend>
          <div className="space-y-1.5">
            <span className="block text-sm font-medium">{t('trigger.channel')}</span>
            <Segmented label={t('trigger.channel')} size="md" value={v.channel} onChange={c => set('channel', c)} data-testid="trigger-channel"
              options={allowed.map(c => ({ value: c, label: channelLabel(c) }))} />
          </div>
          <Row label={t('trigger.template')} error={errors.templateId} htmlFor={ids.tpl}
            hint={<>{t('trigger.templateHint')} <Link href={`/config/templates/new?channel=${v.channel}${v.docTypeKey ? `&docType=${v.docTypeKey}` : ''}`} className="text-accent underline-offset-4 hover:underline">{t('trigger.newTemplate')}</Link></>}>
            <NativeSelect id={ids.tpl} value={v.templateId} onChange={e => set('templateId', e.target.value)} data-testid="trigger-template">
              <option value="">{templates.isLoading ? t('common.loading') : forChannel.length ? t('trigger.chooseTemplate') : t('trigger.noTemplates')}</option>
              {forChannel.map(x => <option key={x.id} value={x.id}>{x.name}{x.isDefault ? ` (${t('tpl.default')})` : ''}</option>)}
            </NativeSelect>
          </Row>
          {v.channel !== 'inapp' && docScoped && (
            <Row label={t('trigger.attachPdf')} htmlFor={ids.pdf} hint={t('trigger.attachPdfHint')}>
              <NativeSelect id={ids.pdf} value={v.attachPdfTemplateId ?? ''} onChange={e => set('attachPdfTemplateId', e.target.value || undefined)} data-testid="trigger-attach-pdf">
                <option value="">{t('trigger.noAttachment')}</option>
                {pdfs.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
              </NativeSelect>
            </Row>
          )}
        </fieldset>

        <fieldset className="space-y-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-semibold">{t('trigger.section.to')}</legend>
          <RecipientsBuilder value={v.recipients} onChange={r => set('recipients', r)} channel={v.channel} roles={roles.data ?? []} stages={stages}
            header={header.data ?? null} docScoped={docScoped} errors={rcptErrors} />
          {errors.recipients && <p className="text-sm text-danger">{errors.recipients}</p>}
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-semibold">{t('trigger.section.how')}</legend>
          <Segmented label={t('trigger.mode')} size="md" value={v.mode ?? 'auto'} onChange={m => set('mode', m)} data-testid="trigger-mode"
            options={[{ value: 'auto', label: t('trigger.mode.auto') }, { value: 'manual', label: t('trigger.mode.manual') }]} />
          <p className="text-xs text-fg-muted">{v.mode === 'manual' ? t('trigger.mode.manualHint') : t('trigger.mode.autoHint')}</p>
          <label className="flex items-center gap-2.5 text-sm">
            <Switch checked={v.isActive !== false} onCheckedChange={c => set('isActive', c)} data-testid="trigger-active" />
            {t('trigger.activeToggle')}
          </label>
        </fieldset>
      </div>
      {canEdit && (
        <div className="space-y-2 border-t border-border p-4">
          {error && <InlineAlert data-testid="trigger-error">{error}</InlineAlert>}
          <div className="flex justify-end gap-2">
            <Button onClick={() => void save()} loading={saving} data-testid="trigger-save">{t('trigger.save')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

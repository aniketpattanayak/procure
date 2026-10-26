'use client';
import { WebhookEndpointInput } from '@procure/schema';
import {
  Badge, Button, Checkbox, Dialog, DialogContent, EmptyState, FormField, Input, Sheet, SheetContent, Skeleton, SkeletonGroup, StatusBadge,
  Switch, UsageBar, toast,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Send, Trash2, Webhook } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { SecretReveal } from '@/components/secret-reveal';
import { t, tMaybe } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { useMe, usePermissions } from '@/lib/permissions';
import { notifyKeys, triggersApi, webhooksApi, type WebhookBody, type WebhookDeliveryRow, type WebhookEndpointRow } from '@/features/notify/api';

/** Domain events (DomainEventType) used when the events catalogue isn't readable. */
const FALLBACK_EVENTS = [
  'document.created', 'document.submitted', 'document.updated', 'document.cancelled', 'document.closed', 'document.status_changed',
  'workflow.stage_entered', 'workflow.decided', 'workflow.completed', 'workflow.sent_back', 'workflow.forwarded',
  'workflow.sla_reminder', 'workflow.sla_escalated', 'comment.created', 'comment.mentioned', 'limit.warning',
].map(type => ({ type, label: type, docScoped: !type.startsWith('limit') }));

/** /config/webhooks: outgoing webhook endpoints (feature api_access, limit webhook_endpoints). */
export function WebhooksPage() {
  const p = usePermissions();
  const me = useMe();
  const qc = useQueryClient();
  const canEdit = p.has('config.webhooks:action.edit');
  const list = useQuery({ queryKey: notifyKeys.webhooks, queryFn: webhooksApi.list });
  const [editing, setEditing] = useState<WebhookEndpointRow | 'new' | null>(null);
  const [created, setCreated] = useState<WebhookEndpointRow | null>(null);
  const [removing, setRemoving] = useState<WebhookEndpointRow | null>(null);
  const [logFor, setLogFor] = useState<WebhookEndpointRow | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const limit = me?.limits?.find(x => x.key === 'webhook_endpoints');
  const rows = list.data ?? [];
  const full = !!limit && limit.effective !== null && rows.length >= limit.effective;
  const refresh = () => void qc.invalidateQueries({ queryKey: notifyKeys.webhooks });

  async function test(w: WebhookEndpointRow) {
    setTesting(w.id);
    try {
      const d = await webhooksApi.test(w.id);
      if (d.status === 'delivered') toast.success(t('webhook.testOk', { code: d.responseCode ?? 200 }));
      else toast.error(t('webhook.testFailed', { code: d.responseCode ?? '—' }));
      void qc.invalidateQueries({ queryKey: notifyKeys.deliveries(w.id) });
    } catch (e) {
      toast.error(t('webhook.testFailed', { code: '—' }), isApiError(e) ? e.message : undefined);
    } finally {
      setTesting(null);
    }
  }

  return (
    <PageBody>
      <PageHeader title={t('webhook.title')} description={t('webhook.description')}
        actions={canEdit && <Button onClick={() => setEditing('new')} disabled={full} title={full ? t('webhook.limitFull') : undefined} data-testid="webhook-new"><Plus aria-hidden />{t('webhook.new')}</Button>} />
      {limit && (
        <div className="mb-4 max-w-sm" data-testid="webhook-limit" data-full={full}>
          <UsageBar used={rows.length} max={limit.effective} label={t('webhook.limitLabel')} />
        </div>
      )}
      {list.isLoading ? (
        <SkeletonGroup className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></SkeletonGroup>
      ) : list.error ? (
        <EmptyState title={isApiError(list.error) ? list.error.message : t('table.error')} action={<Button variant="secondary" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} />
      ) : !rows.length ? (
        <EmptyState icon={<Webhook />} title={t('webhook.empty')} description={t('webhook.emptyHint')} action={canEdit ? <Button onClick={() => setEditing('new')}>{t('webhook.new')}</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface" data-testid="webhook-list">
          {rows.map(w => (
            <li key={w.id} className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center" data-testid={`webhook-row-${w.id}`} data-active={w.isActive}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <code className="truncate text-sm font-medium">{w.url}</code>
                  {w.isActive ? <StatusBadge tone="success">{t('webhook.active')}</StatusBadge> : <StatusBadge>{t('webhook.paused')}</StatusBadge>}
                </p>
                {w.description && <p className="text-sm text-fg-muted">{w.description}</p>}
                <p className="mt-1 flex flex-wrap gap-1">{w.events.slice(0, 6).map(e => <Badge key={e} tone="neutral">{e === '*' ? t('webhook.allEventsShort') : e}</Badge>)}{w.events.length > 6 && <Badge tone="neutral">+{w.events.length - 6}</Badge>}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setLogFor(w)} data-testid={`webhook-log-${w.id}`}>{t('webhook.deliveries')}</Button>
                {canEdit && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => void test(w)} loading={testing === w.id} data-testid={`webhook-test-${w.id}`}><Send aria-hidden />{t('webhook.test')}</Button>
                    <Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setEditing(w)} data-testid={`webhook-edit-${w.id}`}><Pencil aria-hidden /></Button>
                    <Button size="icon-sm" variant="ghost" aria-label={t('webhook.delete')} onClick={() => setRemoving(w)} data-testid={`webhook-delete-${w.id}`}><Trash2 aria-hidden /></Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 max-w-3xl text-sm text-fg-muted" data-testid="webhook-signing-help">{t('webhook.signingHelp')}</p>

      {editing && <EndpointDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(w, isNew) => { setEditing(null); refresh(); if (isNew && w.secret) setCreated(w); }} />}

      <Dialog open={!!created} onOpenChange={o => { if (!o) setCreated(null); }}>
        {created && (
          <DialogContent title={t('webhook.createdTitle')} closeLabel={t('common.close')} data-testid="webhook-created"
            footer={<Button onClick={() => setCreated(null)} data-testid="webhook-created-done">{t('webhook.savedSecret')}</Button>}>
            <SecretReveal label={t('webhook.secret')} value={created.secret!} note={t('webhook.secretOnce')} testId="webhook-secret" />
          </DialogContent>
        )}
      </Dialog>

      <ConfirmDialog open={!!removing} onOpenChange={o => !o && setRemoving(null)} testId="webhook-delete-dialog" tone="danger"
        title={t('webhook.deleteTitle')} description={removing?.url} confirmLabel={t('webhook.delete')}
        onConfirm={async () => { await webhooksApi.remove(removing!.id); toast.success(t('webhook.deleted')); refresh(); }} />

      <Sheet open={!!logFor} onOpenChange={o => { if (!o) setLogFor(null); }}>
        {logFor && (
          <SheetContent side="right" title={t('webhook.deliveriesTitle')} closeLabel={t('common.close')} className="w-full max-w-none sm:w-[38rem] sm:max-w-[38rem]" data-testid="webhook-deliveries">
            <Deliveries endpoint={logFor} />
          </SheetContent>
        )}
      </Sheet>
    </PageBody>
  );
}

function Deliveries({ endpoint }: { endpoint: WebhookEndpointRow }) {
  const q = useQuery({ queryKey: notifyKeys.deliveries(endpoint.id), queryFn: () => webhooksApi.deliveries(endpoint.id), refetchInterval: 10_000 });
  const rows = [...(q.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const tone = (s: WebhookDeliveryRow['status']): 'success' | 'danger' | 'neutral' => (s === 'delivered' ? 'success' : s === 'failed' ? 'danger' : 'neutral');
  return (
    <div className="space-y-3 p-4">
      <code className="block truncate text-sm text-fg-muted">{endpoint.url}</code>
      {q.isLoading ? <Skeleton className="h-24" /> : !rows.length ? (
        <p className="text-sm text-fg-muted">{t('webhook.noDeliveries')}</p>
      ) : (
        <table className="w-full text-sm" data-testid="webhook-deliveries-table">
          <thead className="text-left text-fg-muted">
            <tr><th className="py-1.5 font-medium">{t('webhook.col.event')}</th><th className="py-1.5 font-medium">{t('webhook.col.status')}</th><th className="py-1.5 text-right font-medium">{t('webhook.col.code')}</th><th className="py-1.5 text-right font-medium">{t('webhook.col.when')}</th></tr>
          </thead>
          <tbody>
            {rows.map(d => (
              <tr key={d.id} className="border-t border-border" data-testid="webhook-delivery-row" data-status={d.status}>
                <td className="py-2"><code className="text-xs">{d.eventType}</code></td>
                <td className="py-2"><StatusBadge tone={tone(d.status)}>{t(`webhook.status.${d.status}`)}</StatusBadge>{d.attempts > 1 && <span className="ml-1.5 text-xs text-fg-subtle">{t('webhook.attemptsN', { n: d.attempts })}</span>}</td>
                <td className="py-2 text-right tabular-nums">{d.responseCode ?? '—'}</td>
                <td className="py-2 text-right text-fg-muted" title={fmtDateTime(d.createdAt)}>{fmtRelative(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EndpointDialog({ row, onClose, onSaved }: { row: WebhookEndpointRow | null; onClose: () => void; onSaved: (w: WebhookEndpointRow, isNew: boolean) => void }) {
  const events = useQuery({ queryKey: notifyKeys.events, queryFn: triggersApi.events, retry: false, staleTime: 5 * 60_000 });
  const catalogue = events.data?.length ? events.data : FALLBACK_EVENTS;
  const [v, setV] = useState<WebhookBody>(() => ({ url: row?.url ?? 'https://', description: row?.description ?? '', events: row?.events ?? [], isActive: row?.isActive ?? true }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const all = v.events.includes('*');
  const groups = useMemo(() => {
    const m = new Map<string, typeof catalogue>();
    for (const e of catalogue) { const g = e.type.split('.')[0]!; m.set(g, [...(m.get(g) ?? []), e]); }
    return [...m.entries()];
  }, [catalogue]);
  const toggle = (type: string, on: boolean) => setV(s => ({ ...s, events: on ? [...new Set([...s.events.filter(x => x !== '*'), type])] : s.events.filter(x => x !== type) }));

  async function save() {
    const body = { ...v, description: v.description?.trim() || undefined };
    const parsed = WebhookEndpointInput.safeParse(body);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.path[0] === 'events' ? t('webhook.err.events') : i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    setSaving(true);
    setError(null);
    try {
      const saved = row ? await webhooksApi.update(row.id, { ...body, version: row.version }) : await webhooksApi.create(body);
      toast.success(t('webhook.saved'));
      onSaved(saved, !row);
    } catch (e) {
      // Field errors show under their field; the banner only carries what no field explains.
      const fe: Record<string, string> = {};
      if (isApiError(e)) for (const x of e.errors) if (x.path) fe[x.path.split('.')[0]!] = x.message;
      setErrors(fe);
      setError(Object.keys(fe).length ? null : isApiError(e) ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent size="lg" title={row ? t('webhook.editTitle') : t('webhook.new')} closeLabel={t('common.close')} data-testid="webhook-dialog"
        footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={() => void save()} loading={saving} data-testid="webhook-save">{t('webhook.save')}</Button></>}>
        <div className="space-y-4">
          <FormField label={t('webhook.url')} error={errors.url} hint={t('webhook.urlHint')} required>
            <Input value={v.url} onChange={e => setV(s => ({ ...s, url: e.target.value }))} inputMode="url" className="font-mono text-sm" data-testid="webhook-url" />
          </FormField>
          <FormField label={t('webhook.descriptionLabel')} error={errors.description}>
            <Input value={v.description ?? ''} onChange={e => setV(s => ({ ...s, description: e.target.value }))} data-testid="webhook-description" />
          </FormField>
          <fieldset data-testid="webhook-events">
            <legend className="mb-1.5 text-sm font-medium">{t('webhook.events')}</legend>
            <label className="mb-2 flex items-center gap-2 text-sm">
              <Checkbox checked={all} onCheckedChange={c => setV(s => ({ ...s, events: c ? ['*'] : [] }))} data-testid="webhook-event-all" />
              {t('webhook.allEvents')}
            </label>
            {!all && (
              <div className="grid max-h-64 gap-3 overflow-y-auto rounded border border-border p-3 sm:grid-cols-2">
                {groups.map(([g, list]) => (
                  <div key={g}>
                    <p className="mb-1 text-xs font-semibold text-fg-muted">{tMaybe(`webhook.group.${g}`, g)}</p>
                    {list.map(e => (
                      <label key={e.type} className="flex items-center gap-2 py-0.5 text-sm">
                        <Checkbox checked={v.events.includes(e.type)} onCheckedChange={c => toggle(e.type, !!c)} data-testid={`webhook-event-${e.type}`} />
                        <span className="min-w-0 truncate">{e.label}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {errors.events && <p className="mt-1 text-sm text-danger">{errors.events}</p>}
          </fieldset>
          <label className="flex items-center gap-2.5 text-sm">
            <Switch checked={v.isActive !== false} onCheckedChange={c => setV(s => ({ ...s, isActive: c }))} data-testid="webhook-active" />{t('webhook.activeToggle')}
          </label>
          {error && <InlineAlert data-testid="webhook-error">{error}</InlineAlert>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

'use client';
import { WhatsAppTemplateInput } from '@procure/schema';
import {
  Badge, Button, Checkbox, Dialog, DialogContent, EmptyState, FormField, Input, NativeSelect, Skeleton, SkeletonGroup, StatusBadge, Switch, Textarea, toast,
  type BadgeTone,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { t, type MessageKey } from '@/i18n';
import { isApiError } from '@/lib/api';
import { notifyKeys, platformNotifyApi, type WhatsAppTemplateBody, type WhatsAppTemplateRow } from './api';
import { WhatsAppBubble } from '@/features/templates/previews';

const statusTone: Record<WhatsAppTemplateRow['metaStatus'], BadgeTone> = { approved: 'success', pending: 'warning', rejected: 'danger', paused: 'neutral' };

/** Highest {{n}} placeholders in a body, in order. */
function varIndexes(body: string): number[] {
  return [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
}

/** /platform/whatsapp-templates: the Meta-approved template catalogue tenants can be allowed to use. */
export function PlatformWaTemplatesPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: notifyKeys.waCatalogue, queryFn: platformNotifyApi.waTemplates });
  const [editing, setEditing] = useState<WhatsAppTemplateRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<WhatsAppTemplateRow | null>(null);
  const rows = [...(list.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <PageBody>
      <PageHeader title={t('waTpl.title')} description={t('waTpl.description')}
        actions={<Button onClick={() => setEditing('new')} data-testid="wa-tpl-new"><Plus aria-hidden />{t('waTpl.new')}</Button>} />
      {list.isLoading ? <SkeletonGroup className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></SkeletonGroup>
        : list.error ? <EmptyState title={isApiError(list.error) ? list.error.message : t('table.error')} action={<Button variant="secondary" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} />
          : !rows.length ? <EmptyState icon={<MessageCircle />} title={t('waTpl.empty')} description={t('waTpl.emptyHint')} />
            : (
              <ul className="grid gap-3 lg:grid-cols-2" data-testid="wa-tpl-list">
                {rows.map(r => (
                  <li key={r.id} className="flex flex-col rounded-lg border border-border bg-surface p-4" data-testid={`wa-tpl-row-${r.name}`} data-status={r.metaStatus}>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-semibold">{r.name}</code>
                      <span className="text-sm text-fg-muted">{r.language}</span>
                      <Badge tone="neutral">{t(`waTpl.category.${r.category}` as MessageKey)}</Badge>
                      <StatusBadge tone={statusTone[r.metaStatus]}>{t(`waTpl.status.${r.metaStatus}` as MessageKey)}</StatusBadge>
                      {!r.isActive && <StatusBadge>{t('waTpl.inactive')}</StatusBadge>}
                      <span className="ml-auto flex gap-1">
                        <Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setEditing(r)} data-testid={`wa-tpl-edit-${r.name}`}><Pencil aria-hidden /></Button>
                        <Button size="icon-sm" variant="ghost" aria-label={t('waTpl.delete')} onClick={() => setRemoving(r)} data-testid={`wa-tpl-delete-${r.name}`}><Trash2 aria-hidden /></Button>
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm">{r.body}</p>
                    {!!r.variables.length && (
                      <p className="mt-2 flex flex-wrap gap-1.5 text-xs text-fg-muted">
                        {r.variables.map(v => <span key={v.index} className="rounded border border-border px-1.5 py-0.5"><code className="text-warning">{`{{${v.index}}}`}</code> {v.label}</span>)}
                      </p>
                    )}
                    {r.headerKind !== 'none' && <p className="mt-1 text-xs text-fg-subtle">{t('waTpl.headerIs', { kind: t(`waTpl.header.${r.headerKind}` as MessageKey) })}</p>}
                  </li>
                ))}
              </ul>
            )}
      {editing && <WaTemplateDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: notifyKeys.waCatalogue }); }} />}
      <ConfirmDialog open={!!removing} onOpenChange={o => !o && setRemoving(null)} testId="wa-tpl-delete-dialog" tone="danger"
        title={t('waTpl.deleteTitle', { name: removing?.name ?? '' })} description={t('waTpl.deleteHint')} confirmLabel={t('waTpl.delete')}
        onConfirm={async () => { await platformNotifyApi.removeWaTemplate(removing!.id); toast.success(t('waTpl.deleted')); void qc.invalidateQueries({ queryKey: notifyKeys.waCatalogue }); }} />
    </PageBody>
  );
}

function WaTemplateDialog({ row, onClose, onSaved }: { row: WhatsAppTemplateRow | null; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<WhatsAppTemplateBody>(() => row
    ? { name: row.name, language: row.language, category: row.category, headerKind: row.headerKind, body: row.body, variables: row.variables, metaStatus: row.metaStatus, isActive: row.isActive }
    : { name: '', language: 'en', category: 'utility', headerKind: 'none', body: '', variables: [], metaStatus: 'pending', isActive: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idx = useMemo(() => varIndexes(v.body), [v.body]);
  // Keep one label row per {{n}} in the body.
  useEffect(() => {
    setV(s => ({ ...s, variables: idx.map(i => s.variables?.find(x => x.index === i) ?? { index: i, label: '' }) }));
  }, [idx]);
  const sampleBody = v.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => `[${v.variables?.find(x => x.index === Number(n))?.label || n}]`);

  async function save() {
    const parsed = WhatsAppTemplateInput.safeParse(v);
    if (!parsed.success) {
      const e: Record<string, string> = {};
      for (const i of parsed.error.issues) e[String(i.path[0])] ??= i.path[0] === 'name' ? t('waTpl.err.name') : i.message;
      setErrors(e);
      return;
    }
    setErrors({});
    setSaving(true);
    setError(null);
    try {
      if (row) await platformNotifyApi.updateWaTemplate(row.id, { ...v, version: row.version });
      else await platformNotifyApi.createWaTemplate(v);
      toast.success(t('waTpl.saved'));
      onSaved();
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent size="lg" title={row ? t('waTpl.editTitle', { name: row.name }) : t('waTpl.new')} closeLabel={t('common.close')} data-testid="wa-tpl-dialog"
        footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={() => void save()} loading={saving} data-testid="wa-tpl-save">{t('waTpl.save')}</Button></>}>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
              <FormField label={t('waTpl.name')} error={errors.name} hint={t('waTpl.nameHint')} required>
                <Input value={v.name} onChange={e => setV(s => ({ ...s, name: e.target.value }))} className="font-mono text-sm" readOnly={!!row} data-testid="wa-tpl-name" />
              </FormField>
              <FormField label={t('waTpl.language')} error={errors.language}>
                <Input value={v.language} onChange={e => setV(s => ({ ...s, language: e.target.value }))} data-testid="wa-tpl-language" />
              </FormField>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label={t('waTpl.categoryLabel')}>
                <NativeSelect value={v.category} onChange={e => setV(s => ({ ...s, category: e.target.value as WhatsAppTemplateBody['category'] }))} data-testid="wa-tpl-category">
                  {(['utility', 'marketing', 'authentication'] as const).map(c => <option key={c} value={c}>{t(`waTpl.category.${c}`)}</option>)}
                </NativeSelect>
              </FormField>
              <FormField label={t('waTpl.headerLabel')}>
                <NativeSelect value={v.headerKind} onChange={e => setV(s => ({ ...s, headerKind: e.target.value as WhatsAppTemplateBody['headerKind'] }))} data-testid="wa-tpl-header">
                  {(['none', 'text', 'document', 'image'] as const).map(c => <option key={c} value={c}>{t(`waTpl.header.${c}`)}</option>)}
                </NativeSelect>
              </FormField>
              <FormField label={t('waTpl.metaStatus')}>
                <NativeSelect value={v.metaStatus} onChange={e => setV(s => ({ ...s, metaStatus: e.target.value as WhatsAppTemplateBody['metaStatus'] }))} data-testid="wa-tpl-status">
                  {(['pending', 'approved', 'rejected', 'paused'] as const).map(c => <option key={c} value={c}>{t(`waTpl.status.${c}`)}</option>)}
                </NativeSelect>
              </FormField>
            </div>
            <FormField label={t('waTpl.body')} error={errors.body} hint={t('waTpl.bodyHint')} required>
              <Textarea rows={5} value={v.body} onChange={e => setV(s => ({ ...s, body: e.target.value }))} maxLength={1024} data-testid="wa-tpl-body" />
            </FormField>
            {!!idx.length && (
              <fieldset className="space-y-2" data-testid="wa-tpl-vars">
                <legend className="text-sm font-medium">{t('waTpl.variables')}</legend>
                {(v.variables ?? []).map(x => (
                  <label key={x.index} className="flex items-center gap-2 text-sm">
                    <code className="w-10 shrink-0 text-warning">{`{{${x.index}}}`}</code>
                    <Input value={x.label} onChange={e => setV(s => ({ ...s, variables: (s.variables ?? []).map(y => (y.index === x.index ? { ...y, label: e.target.value } : y)) }))}
                      placeholder={t('waTpl.varPlaceholder')} className="h-8" data-testid={`wa-tpl-var-${x.index}`} />
                  </label>
                ))}
              </fieldset>
            )}
            <label className="flex items-center gap-2.5 text-sm">
              <Switch checked={v.isActive !== false} onCheckedChange={c => setV(s => ({ ...s, isActive: c }))} data-testid="wa-tpl-active" />{t('waTpl.activeToggle')}
            </label>
            {error && <InlineAlert data-testid="wa-tpl-error">{error}</InlineAlert>}
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">{t('tpl.preview')}</p>
            <WhatsAppBubble body={sampleBody || '…'} headerKind={v.headerKind} templateName={`${v.name || 'template'} · ${v.language}`} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Tenant detail tab: which catalogue templates this tenant may use (`PUT /platform/tenants/:id/whatsapp-templates`). */
export function TenantWaTemplatesPanel({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const catalogue = useQuery({ queryKey: notifyKeys.waCatalogue, queryFn: platformNotifyApi.waTemplates });
  const allowed = useQuery({ queryKey: notifyKeys.tenantWa(tenantId), queryFn: () => platformNotifyApi.tenantWaTemplates(tenantId) });
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const current = sel ?? new Set(allowed.data ?? []);
  const dirty = !!sel && (sel.size !== (allowed.data ?? []).length || [...sel].some(x => !(allowed.data ?? []).includes(x)));
  const toggle = (id: string, on: boolean) => setSel(() => { const n = new Set(current); if (on) n.add(id); else n.delete(id); return n; });

  async function save() {
    setSaving(true);
    try {
      await platformNotifyApi.setTenantWaTemplates(tenantId, [...current]);
      toast.success(t('waTpl.allowSaved'));
      setSel(null);
      void qc.invalidateQueries({ queryKey: notifyKeys.tenantWa(tenantId) });
    } catch (e) {
      toast.error(t('waTpl.allowFailed'), isApiError(e) ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  if (catalogue.isLoading || allowed.isLoading) return <SkeletonGroup className="space-y-2 pt-4"><Skeleton className="h-12" /><Skeleton className="h-12" /></SkeletonGroup>;
  const rows = [...(catalogue.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="space-y-3 pt-4" data-testid="wa-tpl-tenant">
      <p className="text-sm text-fg-muted">{t('waTpl.allowHint')}</p>
      {!rows.length ? <p className="text-sm text-fg-muted">{t('waTpl.empty')}</p> : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {rows.map(r => {
            const usable = r.metaStatus === 'approved' && r.isActive;
            return (
              <li key={r.id}>
                <label className="flex cursor-pointer items-start gap-3 px-4 py-3" data-testid={`wa-tpl-allow-${r.name}`} data-allowed={current.has(r.id)}>
                  <Checkbox checked={current.has(r.id)} onCheckedChange={c => toggle(r.id, !!c)} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <code className="font-medium">{r.name}</code><span className="text-sm text-fg-muted">{r.language}</span>
                      <StatusBadge tone={statusTone[r.metaStatus]}>{t(`waTpl.status.${r.metaStatus}` as MessageKey)}</StatusBadge>
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-fg-muted">{r.body}</span>
                    {!usable && current.has(r.id) && <span className="text-xs text-warning">{t('waTpl.allowedNotUsable')}</span>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center justify-end gap-2">
        {dirty && <Button variant="ghost" onClick={() => setSel(null)}>{t('waTpl.discard')}</Button>}
        <Button onClick={() => void save()} loading={saving} disabled={!dirty} data-testid="wa-tpl-allow-save"><Save aria-hidden />{t('waTpl.allowSave')}</Button>
      </div>
    </div>
  );
}

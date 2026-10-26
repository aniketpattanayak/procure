'use client';
import {
  Badge, Button, Dialog, DialogContent, EmptyState, FormField, Input, NativeSelect, Segmented, Skeleton, SkeletonGroup, StatusBadge, Switch, toast,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Plug, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { t, type MessageKey } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import { platformApi } from '@/features/platform/api';
import { notifyKeys, platformNotifyApi, type ProviderBody, type ProviderRow } from './api';
import { ChannelTag } from './ui';

type Provider = ProviderRow['provider'];
const PROVIDERS: Record<'email' | 'whatsapp', Provider[]> = { email: ['ses', 'smtp', 'log'], whatsapp: ['meta', 'bsp', 'log'] };

/** Non-secret settings per provider (keys as the API's channel adapters read them). Unknown keys are kept on save. */
const FIELDS: Record<Provider, { key: string; type?: 'number' | 'switch'; placeholder?: string; required?: boolean }[]> = {
  ses: [{ key: 'fromAddress', placeholder: 'no-reply@example.com', required: true }, { key: 'fromName', placeholder: 'Procure' }, { key: 'region', placeholder: 'ap-south-1', required: true }, { key: 'replyTo' }, { key: 'configurationSet' }],
  smtp: [{ key: 'fromAddress', placeholder: 'no-reply@example.com', required: true }, { key: 'fromName', placeholder: 'Procure' }, { key: 'host', placeholder: 'smtp.example.com', required: true }, { key: 'port', type: 'number', placeholder: '587' }, { key: 'username' }, { key: 'replyTo' }, { key: 'secure', type: 'switch' }],
  meta: [{ key: 'phoneNumberId', required: true }, { key: 'apiVersion', placeholder: 'v21.0' }, { key: 'documentMode', placeholder: 'upload' }, { key: 'graphBase', placeholder: 'https://graph.facebook.com' }],
  bsp: [{ key: 'url', placeholder: 'https://api.bsp.example/messages', required: true }, { key: 'authHeader', placeholder: 'Authorization' }, { key: 'authScheme', placeholder: 'Bearer' }, { key: 'idPath', placeholder: 'id' }, { key: 'documentMode', placeholder: 'base64' }],
  log: [{ key: 'fromAddress', placeholder: 'no-reply@procure.local' }, { key: 'fromName', placeholder: 'Procure' }],
};
/** Write-only secret parts per provider; sent as one JSON object in `secret`. */
const SECRETS: Record<Provider, string[]> = {
  ses: ['accessKeyId', 'secretAccessKey'], smtp: ['password'], meta: ['accessToken', 'appSecret', 'verifyToken'], bsp: ['token'], log: [],
};
const SECRET_LABEL: Record<Provider, MessageKey | null> = {
  ses: 'provider.secret.ses', smtp: 'provider.secret.smtp', meta: 'provider.secret.meta', bsp: 'provider.secret.bsp', log: null,
};

/** /platform/providers: email and WhatsApp provider credentials, platform default plus per-tenant overrides. */
export function PlatformProvidersPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: notifyKeys.providers, queryFn: platformNotifyApi.providers });
  const tenants = useQuery({ queryKey: ['platform', 'tenants', 'all-min'], queryFn: () => platformApi.tenants({}), staleTime: 60_000 });
  const tenantName = useMemo(() => new Map((tenants.data?.data ?? []).map(x => [x.id, x.name])), [tenants.data]);
  const [editing, setEditing] = useState<ProviderRow | 'new' | null>(null);
  const [removing, setRemoving] = useState<ProviderRow | null>(null);
  const rows = [...(list.data ?? [])].sort((a, b) => Number(!!a.tenantId) - Number(!!b.tenantId) || a.channel.localeCompare(b.channel));
  const platformRows = rows.filter(r => !r.tenantId);
  const tenantRows = rows.filter(r => r.tenantId);

  const section = (title: string, hint: string, items: ProviderRow[], testId: string) => (
    <section className="mb-6" data-testid={testId}>
      <h2 className="font-semibold">{title}</h2>
      <p className="mb-2 text-sm text-fg-muted">{hint}</p>
      {!items.length ? <p className="rounded-lg border border-dashed border-border-strong px-4 py-4 text-sm text-fg-muted">{t('provider.none')}</p> : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {items.map(r => (
            <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center" data-testid={`provider-row-${r.id}`} data-provider={r.provider} data-channel={r.channel}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <ChannelTag channel={r.channel} className="font-medium" />
                  <Badge tone={r.provider === 'log' ? 'warning' : 'accent'}>{t(`provider.name.${r.provider}` as MessageKey)}</Badge>
                  {r.tenantId && <span className="text-sm">{r.tenantName ?? tenantName.get(r.tenantId) ?? r.tenantId.slice(0, 8)}</span>}
                  {!r.isActive && <StatusBadge>{t('provider.inactive')}</StatusBadge>}
                </p>
                <p className="mt-0.5 truncate text-sm text-fg-muted">
                  {Object.entries(r.config ?? {}).filter(([, v]) => v !== '' && v !== undefined && v !== null).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') || t('provider.noConfig')}
                </p>
              </div>
              <div className="flex items-center gap-2 text-sm">
                {SECRET_LABEL[r.provider] && (
                  <span className={r.hasSecret ? 'inline-flex items-center gap-1 text-success' : 'inline-flex items-center gap-1 text-warning'} data-testid={`provider-secret-state-${r.id}`}>
                    <KeyRound className="size-3.5" aria-hidden />{r.hasSecret ? t('provider.secretStored') : t('provider.secretMissing')}
                  </span>
                )}
                {r.updatedAt && <span className="text-fg-subtle" title={r.updatedAt}>{fmtRelative(r.updatedAt)}</span>}
                <Button size="icon-sm" variant="ghost" aria-label={t('common.edit')} onClick={() => setEditing(r)} data-testid={`provider-edit-${r.id}`}><Pencil aria-hidden /></Button>
                <Button size="icon-sm" variant="ghost" aria-label={t('provider.delete')} onClick={() => setRemoving(r)} data-testid={`provider-delete-${r.id}`}><Trash2 aria-hidden /></Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <PageBody>
      <PageHeader title={t('provider.title')} description={t('provider.description')}
        actions={<Button onClick={() => setEditing('new')} data-testid="provider-new"><Plus aria-hidden />{t('provider.new')}</Button>} />
      {list.isLoading ? <SkeletonGroup className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></SkeletonGroup>
        : list.error ? <EmptyState icon={<Plug />} title={isApiError(list.error) ? list.error.message : t('table.error')} action={<Button variant="secondary" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} />
          : (
            <>
              {section(t('provider.platformScope'), t('provider.platformScopeHint'), platformRows, 'provider-platform')}
              {section(t('provider.tenantScope'), t('provider.tenantScopeHint'), tenantRows, 'provider-tenants')}
            </>
          )}
      {editing && (
        <ProviderDialog row={editing === 'new' ? null : editing} tenants={(tenants.data?.data ?? []).map(x => ({ id: x.id, name: x.name, code: x.code }))}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: notifyKeys.providers }); }} />
      )}
      <ConfirmDialog open={!!removing} onOpenChange={o => !o && setRemoving(null)} testId="provider-delete-dialog" tone="danger"
        title={t('provider.deleteTitle')} description={t('provider.deleteHint')} confirmLabel={t('provider.delete')}
        onConfirm={async () => { await platformNotifyApi.removeProvider(removing!.id); toast.success(t('provider.deleted')); void qc.invalidateQueries({ queryKey: notifyKeys.providers }); }} />
    </PageBody>
  );
}

function ProviderDialog({ row, tenants, onClose, onSaved }: { row: ProviderRow | null; tenants: { id: string; name: string; code: string }[]; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<ProviderBody>(() => ({ tenantId: row?.tenantId ?? null, channel: row?.channel ?? 'email', provider: row?.provider ?? 'ses', config: { ...(row?.config ?? {}) }, isActive: row?.isActive ?? true }));
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [replaceSecret, setReplaceSecret] = useState(!row?.hasSecret);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const provider = v.provider as Provider;
  const cfg = (v.config ?? {}) as Record<string, unknown>;
  const setCfg = (k: string, val: unknown) => setV(s => ({ ...s, config: { ...(s.config ?? {}), [k]: val } }));

  async function save() {
    const req = FIELDS[provider].filter(f => f.required && (cfg[f.key] === undefined || cfg[f.key] === '')).map(f => f.key);
    setMissing(new Set(req));
    if (req.length) { setError(t('provider.err.required')); return; }
    // Keep every config key (including ones this form doesn't know), dropping only empty values.
    const config = Object.fromEntries(Object.entries(cfg).filter(([, x]) => x !== undefined && x !== ''));
    const parts = Object.fromEntries(Object.entries(secret).filter(([, x]) => x.trim() !== ''));
    const body: ProviderBody = { ...v, config, ...(SECRET_LABEL[provider] && replaceSecret && Object.keys(parts).length ? { secret: JSON.stringify(parts) } : {}) };
    setSaving(true);
    setError(null);
    try {
      if (row) await platformNotifyApi.updateProvider(row.id, { ...body, version: row.version });
      else await platformNotifyApi.createProvider(body);
      toast.success(t('provider.saved'));
      onSaved();
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent size="lg" title={row ? t('provider.editTitle') : t('provider.new')} closeLabel={t('common.close')} data-testid="provider-dialog"
        footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={() => void save()} loading={saving} data-testid="provider-save">{t('provider.save')}</Button></>}>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('provider.scope')}>
              <NativeSelect value={v.tenantId ?? ''} onChange={e => setV(s => ({ ...s, tenantId: e.target.value || null }))} disabled={!!row} data-testid="provider-scope">
                <option value="">{t('provider.scopePlatform')}</option>
                {tenants.map(x => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}
              </NativeSelect>
            </FormField>
            <div className="space-y-1.5">
              <span className="block text-sm font-medium">{t('provider.channel')}</span>
              <Segmented label={t('provider.channel')} size="md" value={v.channel} disabled={!!row} data-testid="provider-channel"
                onChange={c => setV(s => ({ ...s, channel: c, provider: PROVIDERS[c].includes(s.provider as Provider) ? s.provider : PROVIDERS[c][0]!, config: {} }))}
                options={[{ value: 'email', label: t('notify.channel.email') }, { value: 'whatsapp', label: t('notify.channel.whatsapp') }]} />
            </div>
          </div>
          <div className="space-y-1.5">
            <span className="block text-sm font-medium">{t('provider.provider')}</span>
            <Segmented label={t('provider.provider')} size="md" value={provider} data-testid="provider-provider"
              onChange={p => { setV(s => ({ ...s, provider: p, config: {} })); setReplaceSecret(true); }}
              options={PROVIDERS[v.channel].map(p => ({ value: p, label: t(`provider.name.${p}` as MessageKey) }))} />
            <p className="text-xs text-fg-muted">{t(`provider.hint.${provider}` as MessageKey)}</p>
          </div>
          {FIELDS[provider].length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2" data-testid="provider-config">
              {FIELDS[provider].map(f => f.type === 'switch' ? (
                <label key={f.key} className="flex items-center gap-2.5 self-end pb-2 text-sm">
                  <Switch checked={!!cfg[f.key]} onCheckedChange={c => setCfg(f.key, c)} data-testid={`provider-config-${f.key}`} />{t(`provider.field.${f.key}` as MessageKey)}
                </label>
              ) : (
                <FormField key={f.key} label={t(`provider.field.${f.key}` as MessageKey)} required={f.required} error={missing.has(f.key) ? t('provider.err.field') : undefined}>
                  <Input type={f.type === 'number' ? 'number' : 'text'} value={cfg[f.key] === undefined ? '' : String(cfg[f.key])} placeholder={f.placeholder}
                    onChange={e => setCfg(f.key, f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} data-testid={`provider-config-${f.key}`} />
                </FormField>
              ))}
            </div>
          )}
          {Object.keys(cfg).filter(k => !FIELDS[provider].some(f => f.key === k)).length > 0 && (
            <p className="text-xs text-fg-muted" data-testid="provider-config-extra">
              {t('provider.extraKeys', { keys: Object.keys(cfg).filter(k => !FIELDS[provider].some(f => f.key === k)).join(', ') })}
            </p>
          )}
          {SECRET_LABEL[provider] && (
            <div className="space-y-1.5 rounded-lg border border-border bg-subtle p-3" data-testid="provider-secret-block">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{t(SECRET_LABEL[provider]!)}</span>
                {row?.hasSecret && !replaceSecret && <Button size="sm" variant="ghost" onClick={() => setReplaceSecret(true)} data-testid="provider-secret-replace">{t('provider.replaceSecret')}</Button>}
              </div>
              {replaceSecret ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {SECRETS[provider].map(k => (
                    <label key={k} className="space-y-1 text-sm">
                      <span className="text-fg-muted">{t(`provider.secretPart.${k}` as MessageKey)}</span>
                      <Input type="password" autoComplete="new-password" value={secret[k] ?? ''} onChange={e => setSecret(s => ({ ...s, [k]: e.target.value }))}
                        placeholder={row?.hasSecret ? t('provider.secretKeep') : ''} data-testid={`provider-secret-${k}`} />
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-fg-muted" data-testid="provider-secret-stored">{t('provider.secretStoredLong')}</p>
              )}
              <p className="text-xs text-fg-muted">{t('provider.secretWriteOnly')}</p>
            </div>
          )}
          <label className="flex items-center gap-2.5 text-sm">
            <Switch checked={v.isActive !== false} onCheckedChange={c => setV(s => ({ ...s, isActive: c }))} data-testid="provider-active" />{t('provider.activeToggle')}
          </label>
          {error && <InlineAlert data-testid="provider-error">{error}</InlineAlert>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

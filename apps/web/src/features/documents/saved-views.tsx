'use client';
import type { SavedViewRow } from '@procure/schema';
import {
  Button, Checkbox, Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger, FormField, Input, toast,
} from '@procure/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Check, Star, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { docKeys, savedViewsApi } from './api';

export type SavedConfig = SavedViewRow['config'];

export function useSavedViews(scopeKey: string) {
  return useQuery({ queryKey: docKeys.savedViews(scopeKey), queryFn: () => savedViewsApi.list(scopeKey), staleTime: 60_000, retry: false });
}

/** Saved views menu: apply, save current (personal or shared, optionally default), delete own. */
export function SavedViewsMenu({ scopeKey, activeId, current, onApply }: {
  scopeKey: string;
  activeId: string | null;
  /** Current list state to store when saving. */
  current: () => SavedConfig;
  onApply: (v: SavedViewRow | null) => void;
}) {
  const qc = useQueryClient();
  const views = useSavedViews(scopeKey);
  const [saving, setSaving] = useState(false);
  const active = views.data?.find(v => v.id === activeId) ?? null;
  const remove = useMutation({
    mutationFn: (id: string) => savedViewsApi.remove(id),
    onSuccess: (_d, id) => { void qc.invalidateQueries({ queryKey: docKeys.savedViews(scopeKey) }); if (id === activeId) onApply(null); },
    onError: e => toast.error(t('docs.views.deleteFailed'), isApiError(e) ? e.message : undefined),
  });
  const mine = (views.data ?? []).filter(v => v.isMine);
  const shared = (views.data ?? []).filter(v => !v.isMine);

  const item = (v: SavedViewRow) => (
    <DropdownMenuItem key={v.id} onSelect={() => onApply(v)} data-testid={`saved-view-${v.id}`} className="gap-2">
      <span className="flex size-4 items-center justify-center">{v.id === activeId && <Check className="size-4 text-accent" aria-hidden />}</span>
      <span className="min-w-0 flex-1 truncate">{v.name}</span>
      {v.isDefault && <Star className="size-3.5 text-warning" aria-label={t('docs.views.default')} />}
      {v.shared && <Users className="size-3.5 text-fg-subtle" aria-label={t('docs.views.shared')} />}
      {v.isMine && (
        <button type="button" className="rounded p-0.5 text-fg-subtle hover:text-danger" onClick={e => { e.preventDefault(); e.stopPropagation(); remove.mutate(v.id); }} aria-label={t('docs.views.delete', { name: v.name })}>
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      )}
    </DropdownMenuItem>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" data-testid="saved-views" className="max-w-52">
            <Bookmark aria-hidden /><span className="truncate">{active ? active.name : t('docs.views.title')}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-72">
          <DropdownMenuItem onSelect={() => onApply(null)} className="gap-2" data-testid="saved-view-none">
            <span className="flex size-4 items-center justify-center">{!activeId && <Check className="size-4 text-accent" aria-hidden />}</span>
            {t('docs.views.standard')}
          </DropdownMenuItem>
          {mine.length > 0 && <><DropdownMenuSeparator /><DropdownMenuLabel>{t('docs.views.mine')}</DropdownMenuLabel>{mine.map(item)}</>}
          {shared.length > 0 && <><DropdownMenuSeparator /><DropdownMenuLabel>{t('docs.views.sharedWithMe')}</DropdownMenuLabel>{shared.map(item)}</>}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSaving(true)} data-testid="saved-view-save">{t('docs.views.saveCurrent')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {saving && <SaveViewDialog scopeKey={scopeKey} config={current()} onClose={() => setSaving(false)} onSaved={v => { setSaving(false); onApply(v); }} />}
    </>
  );
}

function SaveViewDialog({ scopeKey, config, onClose, onSaved }: { scopeKey: string; config: SavedConfig; onClose: () => void; onSaved: (v: SavedViewRow) => void }) {
  const qc = useQueryClient();
  const p = usePermissions();
  const canShare = p.isTenantAdmin || p.has('admin.roles:action.edit');
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [isDefault, setDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => savedViewsApi.create({ scopeKey, name: name.trim(), config, shared, sharedRoleIds: [], isDefault }),
    onSuccess: v => { void qc.invalidateQueries({ queryKey: docKeys.savedViews(scopeKey) }); toast.success(t('docs.views.saved')); onSaved(v); },
    onError: e => setError(isApiError(e) ? e.message : String(e)),
  });
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={t('docs.views.saveTitle')} description={t('docs.views.saveHint')} size="sm" data-testid="saved-view-dialog"
        footer={<>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form="save-view-form" loading={save.isPending} disabled={!name.trim()} data-testid="saved-view-submit">{t('docs.views.save')}</Button>
        </>}>
        <form id="save-view-form" className="space-y-4" onSubmit={e => { e.preventDefault(); if (name.trim()) save.mutate(); }}>
          <FormField label={t('docs.views.name')} required>
            <Input value={name} onChange={e => setName(e.target.value)} maxLength={80} autoFocus data-testid="saved-view-name" />
          </FormField>
          <label className="flex items-center gap-2.5"><Checkbox checked={isDefault} onCheckedChange={v => setDefault(!!v)} data-testid="saved-view-default" />{t('docs.views.makeDefault')}</label>
          {canShare && <label className="flex items-center gap-2.5"><Checkbox checked={shared} onCheckedChange={v => setShared(!!v)} data-testid="saved-view-shared" />{t('docs.views.shareAll')}</label>}
          {error && <InlineAlert>{error}</InlineAlert>}
        </form>
      </DialogContent>
    </Dialog>
  );
}

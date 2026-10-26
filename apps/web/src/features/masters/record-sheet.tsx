'use client';
import type { MasterSummary, RecordDeleteBlocked, RecordRow } from '@procure/schema';
import {
  Button, Dialog, DialogContent, FormField, Input, Sheet, SheetContent, Skeleton, SkeletonGroup, StatusBadge, toast,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Pencil, Power, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { perm, usePermissions } from '@/lib/permissions';
import { FormRenderer, type FormRendererHandle } from '@/engines/form-renderer/form-renderer';
import { useRenderableForm } from '@/engines/form-renderer/render-api';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { errorsFromProblem, type ErrorMap } from '@/engines/form-renderer/validation';
import { initialValues } from '@/engines/form-renderer/values';
import { todayIn } from '@/engines/form-renderer/formula';
import { mastersApi } from './api';

export function RecordSheet({ master, recordId, onClose, onChanged, onOpenRecord }: {
  master: MasterSummary; recordId: string | null; onClose: () => void; onChanged: () => void; onOpenRecord: (id: string) => void;
}) {
  const qc = useQueryClient();
  const p = usePermissions();
  const tab = perm.masterTab(master.key);
  const { currency, timeZone } = useTenantLocale();
  const isNew = recordId === null;
  const [mode, setMode] = useState<'view' | 'edit'>(isNew ? 'edit' : 'view');

  const rec = useQuery({ queryKey: ['master-record', master.key, recordId], queryFn: () => mastersApi.record(master.key, recordId!), enabled: !isNew });
  const current = useRenderableForm(master.formKey);
  const ownVersionId = rec.data?.formVersionId;
  const differs = !!ownVersionId && !!current.data && ownVersionId !== current.data.formVersionId;
  const own = useRenderableForm(master.formKey, ownVersionId, differs && mode === 'view');
  const form = mode === 'view' && differs ? own.data : current.data;

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<ErrorMap>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<null | 'delete' | 'deactivate'>(null);
  const [blocked, setBlocked] = useState<RecordDeleteBlocked['usedBy'] | null>(null);
  const ref = useRef<FormRendererHandle>(null);
  const [dirty, setDirty] = useState(false);

  // Seed the editor from the record (or defaults for a new one).
  useEffect(() => {
    if (isNew && current.data) {
      setValues(initialValues(current.data.definition.fields, todayIn(timeZone)));
      setCode(''); setName('');
    } else if (rec.data) {
      setValues(rec.data.data);
      setCode(rec.data.code); setName(rec.data.name);
    }
    setErrors({}); setBanner(null); setDirty(false);
  }, [isNew, rec.data, current.data, timeZone]);

  const autoCode = !!master.settings.codePattern;
  const codeLabel = master.settings.codeLabel || t('masters.code');
  const nameLabel = master.settings.nameLabel || t('masters.name');
  const r = rec.data;

  // Formulas may read the record's code/name even though they are row columns, not form fields.
  const formContext = useMemo(() => ({ code, name }), [code, name]);

  async function save() {
    setBanner(null);
    const clientErrors = ref.current?.validate() ?? {};
    const own: ErrorMap = {};
    if (!autoCode && !code.trim()) own.code = t('fr.err.required');
    if (!name.trim()) own.name = t('fr.err.required');
    if (Object.keys(clientErrors).length || Object.keys(own).length) {
      setErrors(own);
      setBanner(t('masters.fixErrors'));
      return;
    }
    setSaving(true);
    try {
      const data = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
      const body = { ...(autoCode && isNew ? {} : { code: code.trim() }), name: name.trim(), data };
      const saved = isNew ? await mastersApi.createRecord(master.key, body) : await mastersApi.updateRecord(master.key, r!.id, { ...body, version: r!.version });
      qc.setQueryData(['master-record', master.key, saved.id], saved);
      void qc.invalidateQueries({ queryKey: ['lookup'] });
      void qc.invalidateQueries({ queryKey: ['masters'] });
      onChanged();
      toast.success(isNew ? t('masters.created', { name: saved.name }) : t('masters.saved'));
      setDirty(false);
      if (isNew) onOpenRecord(saved.id);
      else setMode('view');
    } catch (e) {
      if (!isApiError(e)) { setBanner(String(e)); return; }
      const map = errorsFromProblem(e.errors);
      if (e.code === 'FIELD_READ_ONLY' && typeof e.meta.field === 'string') map[e.meta.field] = e.message;
      setErrors(map);
      const unmapped = e.errors.length === 0 || e.status === 409 || e.code === 'FIELD_READ_ONLY';
      setBanner(e.status === 409 ? t('masters.conflict') : unmapped ? e.message : t('masters.fixErrors'));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    if (!r) return;
    const next = r.isActive ? await mastersApi.deactivate(master.key, r.id) : await mastersApi.activate(master.key, r.id);
    qc.setQueryData(['master-record', master.key, r.id], next);
    void qc.invalidateQueries({ queryKey: ['lookup'] });
    onChanged();
    toast.success(next.isActive ? t('masters.activated') : t('masters.deactivated'));
  }

  async function remove(reason: string) {
    if (!r) return;
    try {
      await mastersApi.remove(master.key, r.id, reason);
      toast.success(t('masters.deleted', { name: r.name }));
      void qc.invalidateQueries({ queryKey: ['masters'] });
      onChanged();
      onClose();
    } catch (e) {
      if (isApiError(e) && e.code === 'RECORD_IN_USE') {
        const usedBy = (e.meta.usedBy as RecordDeleteBlocked['usedBy'] | undefined) ?? await mastersApi.usage(master.key, r.id).catch(() => []);
        setConfirm(null);
        setBlocked(usedBy);
        return;
      }
      throw e;
    }
  }

  const loading = (!isNew && rec.isLoading) || current.isLoading || (mode === 'view' && differs && own.isLoading);
  const title = isNew ? t('masters.new', { name: master.name }) : r ? `${r.code} · ${r.name}` : master.name;

  function close(o: boolean) {
    if (o) return;
    if (dirty && mode === 'edit' && !window.confirm(t('fb.leaveConfirm'))) return;
    onClose();
  }

  return (
    <Sheet open onOpenChange={close}>
      <SheetContent side="right" title={title} className="w-full max-w-none sm:w-[44rem] sm:max-w-[92vw]" closeLabel={t('common.close')} data-testid="record-sheet">
        {loading || !form ? (
          <SkeletonGroup className="space-y-4 p-5"><Skeleton className="h-6 w-48" /><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-32" /></SkeletonGroup>
        ) : (
          <div className="flex min-h-full flex-col">
            <div className="flex-1 space-y-5 p-5">
              {!isNew && r && (
                <div className="flex flex-wrap items-center gap-2">
                  {r.isActive ? <StatusBadge tone="success">{t('masters.active')}</StatusBadge> : <StatusBadge tone="neutral">{t('masters.inactive')}</StatusBadge>}
                  <span className="text-xs text-fg-subtle">{t('masters.updatedAt', { when: fmtDateTime(r.updatedAt) })}</span>
                  {mode === 'view' && (
                    <div className="ml-auto flex flex-wrap gap-1.5">
                      {p.can(tab, 'edit') && <Button size="sm" variant="secondary" onClick={() => setMode('edit')} data-testid="record-edit"><Pencil aria-hidden />{t('common.edit')}</Button>}
                      {p.can(tab, 'deactivate') && (
                        r.isActive
                          ? <Button size="sm" variant="ghost" onClick={() => setConfirm('deactivate')} data-testid="record-deactivate"><Power aria-hidden />{t('masters.deactivate')}</Button>
                          : <Button size="sm" variant="ghost" onClick={() => void toggleActive()} data-testid="record-activate"><Power aria-hidden />{t('masters.activate')}</Button>
                      )}
                      {p.can(tab, 'delete') && <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setConfirm('delete')} data-testid="record-delete"><Trash2 aria-hidden />{t('masters.delete')}</Button>}
                    </div>
                  )}
                </div>
              )}
              {differs && (
                <p className="flex items-start gap-2 rounded border border-border bg-subtle px-3 py-2 text-sm text-fg-muted" data-testid="record-version-notice">
                  <History className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {mode === 'view' ? t('masters.olderVersionView') : t('masters.olderVersionEdit')}
                </p>
              )}
              {banner && <InlineAlert data-testid="record-error">{banner}</InlineAlert>}

              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                {mode === 'view' ? (
                  <>
                    <div><p className="text-sm font-medium">{codeLabel}</p><p className="py-1.5 tabular-nums" data-testid="record-code-value">{r?.code}</p></div>
                    <div><p className="text-sm font-medium">{nameLabel}</p><p className="py-1.5" data-testid="record-name-value">{r?.name}</p></div>
                  </>
                ) : (
                  <>
                    <FormField label={codeLabel} required={!autoCode} error={errors.code} hint={autoCode && isNew ? t('masters.autoCode') : undefined}>
                      <Input value={autoCode && isNew ? '' : code} placeholder={autoCode && isNew ? t('masters.autoCodePlaceholder') : undefined} disabled={autoCode}
                        onChange={e => { setCode(e.target.value); setDirty(true); }} maxLength={60} data-testid="record-code" />
                    </FormField>
                    <FormField label={nameLabel} required error={errors.name}>
                      <Input value={name} onChange={e => { setName(e.target.value); setDirty(true); }} maxLength={200} data-testid="record-name" />
                    </FormField>
                  </>
                )}
              </div>

              <FormRenderer
                key={`${mode}-${form.formVersionId}`}
                ref={ref}
                form={form}
                value={values}
                onChange={v => { setValues(v); setDirty(true); }}
                mode={mode}
                errors={errors}
                refs={r?.refs}
                files={r?.files}
                currency={currency}
                timeZone={timeZone}
                context={formContext}
                idPrefix="rec"
              />
            </div>
            {mode === 'edit' && (
              <div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-border bg-surface px-5 py-3 sm:flex-row sm:justify-end">
                <Button variant="secondary" onClick={() => { if (isNew) onClose(); else { setMode('view'); setValues(r!.data); setCode(r!.code); setName(r!.name); setErrors({}); setBanner(null); setDirty(false); } }}>{t('common.cancel')}</Button>
                <Button onClick={() => void save()} loading={saving} data-testid="record-save">{isNew ? t('masters.create', { name: master.name }) : t('common.saveChanges')}</Button>
              </div>
            )}
          </div>
        )}

        {confirm === 'deactivate' && (
          <ConfirmDialog open onOpenChange={o => { if (!o) setConfirm(null); }} title={t('masters.confirmDeactivate', { name: r?.name ?? '' })} description={t('masters.confirmDeactivateBody')}
            confirmLabel={t('masters.deactivate')} tone="danger" onConfirm={toggleActive} testId="confirm-record-deactivate" />
        )}
        {confirm === 'delete' && (
          <ConfirmDialog open onOpenChange={o => { if (!o) setConfirm(null); }} title={t('masters.confirmDelete', { name: r?.name ?? '' })} description={t('masters.confirmDeleteBody')}
            confirmLabel={t('masters.delete')} tone="danger" requireReason reasonLabel={t('common.reason')} onConfirm={remove} testId="confirm-record-delete" />
        )}
        <Dialog open={!!blocked} onOpenChange={o => { if (!o) setBlocked(null); }}>
          <DialogContent title={t('masters.inUseTitle', { name: r?.name ?? '' })} description={t('masters.inUseBody')} size="sm" closeLabel={t('common.close')} data-testid="record-in-use"
            footer={
              <>
                <Button variant="secondary" onClick={() => setBlocked(null)}>{t('common.close')}</Button>
                {r?.isActive && p.can(tab, 'deactivate') && (
                  <Button onClick={async () => { await toggleActive(); setBlocked(null); }} data-testid="record-deactivate-instead">{t('masters.deactivateInstead')}</Button>
                )}
              </>
            }>
            <ul className="space-y-1.5">
              {(blocked ?? []).map((u, i) => (
                <li key={i} className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2 text-sm">
                  <span>{u.label}</span><span className="tabular-nums text-fg-muted">{(u.count === 1 ? t('masters.inUseOnce') : t('masters.inUseCount', { n: u.count }))}</span>
                </li>
              ))}
              {blocked && blocked.length === 0 && <li className="text-sm text-fg-muted">{t('masters.inUseUnknown')}</li>}
            </ul>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

export type { RecordRow };

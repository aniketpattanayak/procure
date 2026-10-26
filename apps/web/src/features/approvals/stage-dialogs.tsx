'use client';
import { Button, Dialog, DialogContent, FormField, NativeSelect, Textarea } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { Combobox, type ComboOption } from '@/engines/form-renderer/combobox';
import { docsApi } from '@/features/documents/api';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';

function useReasonSubmit(onConfirm: (reason: string) => Promise<unknown>, onClose: () => void) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go(extraCheck?: () => string | null) {
    const bad = extraCheck?.() ?? (reason.trim().length < 3 ? t('validation.reasonMin') : null);
    if (bad) { setError(bad); return; }
    setBusy(true); setError(null);
    try { await onConfirm(reason.trim()); onClose(); } catch (e) { setError(isApiError(e) ? e.message : String(e)); } finally { setBusy(false); }
  }
  return { reason, setReason, error, busy, go };
}

/** Send back to an earlier stage, or to the submitter (`_draft`, which cancels the run and reopens the draft). */
export function SendBackDialog({ targets, onClose, onConfirm }: {
  targets: { key: string; name: string }[];
  onClose: () => void;
  onConfirm: (toStage: string, reason: string) => Promise<unknown>;
}) {
  const options = [{ key: '_draft', name: t('approve.sendBack.toSubmitter') }, ...targets];
  const [to, setTo] = useState(options[options.length - 1]!.key);
  const r = useReasonSubmit(reason => onConfirm(to, reason), onClose);
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={t('approve.sendBack.title')} description={t('approve.sendBack.hint')} size="sm" data-testid="send-back-dialog"
        footer={<>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => void r.go()} loading={r.busy} data-testid="send-back-confirm">{t('approve.sendBack.confirm')}</Button>
        </>}>
        <div className="space-y-4">
          <FormField label={t('approve.sendBack.to')} required>
            <NativeSelect value={to} onChange={e => setTo(e.target.value)} data-testid="send-back-target">
              {options.map(o => <option key={o.key} value={o.key}>{o.name}</option>)}
            </NativeSelect>
          </FormField>
          {to === '_draft' && <p className="text-sm text-fg-muted">{t('approve.sendBack.draftNote')}</p>}
          <FormField label={t('common.reason')} required>
            <Textarea rows={3} value={r.reason} onChange={e => r.setReason(e.target.value)} maxLength={500} data-testid="send-back-reason" />
          </FormField>
          {r.error && <InlineAlert>{r.error}</InlineAlert>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Forward the stage to another user (they must be able to view the document at its location). */
export function ForwardDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (userId: string, reason: string) => Promise<unknown> }) {
  const [user, setUser] = useState<ComboOption | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q, 200);
  const users = useQuery({ queryKey: ['users-options', dq], queryFn: ({ signal }) => docsApi.userOptions(dq, signal), enabled: open, staleTime: 60_000 });
  const r = useReasonSubmit(reason => onConfirm(user!.value, reason), onClose);
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={t('approve.forward.title')} description={t('approve.forward.hint')} size="sm" data-testid="forward-dialog"
        footer={<>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => void r.go(() => (!user ? t('approve.forward.pickUser') : r.reason.trim().length < 3 ? t('validation.reasonMin') : null))} loading={r.busy} data-testid="forward-confirm">{t('approve.forward.confirm')}</Button>
        </>}>
        <div className="space-y-4">
          <FormField label={t('approve.forward.to')} required>
            <Combobox
              options={(users.data ?? []).map(u => ({ value: u.id, label: u.name, secondary: u.email }))}
              selected={user ? [user] : []}
              onSelect={setUser}
              onRemove={() => setUser(null)}
              onClear={() => setUser(null)}
              query={q}
              onQueryChange={setQ}
              onOpenChange={setOpen}
              loading={users.isFetching}
              placeholder={t('approve.forward.search')}
              aria-label={t('approve.forward.to')}
              testId="forward-user"
            />
          </FormField>
          <FormField label={t('common.reason')} required>
            <Textarea rows={3} value={r.reason} onChange={e => r.setReason(e.target.value)} maxLength={500} data-testid="forward-reason" />
          </FormField>
          {r.error && <InlineAlert>{r.error}</InlineAlert>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const SHORTCUTS: [string, Parameters<typeof t>[0]][] = [
  ['j / ↓', 'approve.keys.next'], ['k / ↑', 'approve.keys.prev'], ['a', 'approve.keys.approve'], ['h', 'approve.keys.hold'], ['r', 'approve.keys.reject'],
  ['s', 'approve.keys.skip'], ['x', 'approve.keys.select'], ['e', 'approve.keys.edit'], ['Enter', 'approve.keys.submit'], ['?', 'approve.keys.help'],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={t('approve.keys.title')} size="sm" data-testid="decision-help">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
          {SHORTCUTS.map(([k, label]) => (
            <div key={k} className="contents">
              <dt><kbd className="rounded border border-border-strong bg-subtle px-1.5 py-0.5 font-mono text-xs">{k}</kbd></dt>
              <dd className="text-fg-muted">{t(label)}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

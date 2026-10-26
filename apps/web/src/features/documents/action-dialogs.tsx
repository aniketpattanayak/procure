'use client';
import type { DocumentRow } from '@procure/schema';
import { Button, Checkbox, cn, Dialog, DialogContent, FormField, Textarea } from '@procure/ui';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { dec, fmtQty } from './decimal';
import { lineItemLabel, lineUom } from './lines-table';

/** Cancel the whole document or chosen lines (remaining qty), with a reason. */
export function CancelDialog({ doc, allowLines, allowWhole, onClose, onConfirm }: {
  doc: DocumentRow;
  allowLines: boolean;
  allowWhole: boolean;
  onClose: () => void;
  onConfirm: (body: { reason: string; lineIds?: string[] }) => Promise<unknown>;
}) {
  const cancellable = doc.lines.filter(l => !['cancelled', 'closed', 'rejected', 'approved'].includes(l.statusKey) || dec.gt0(l.qty.pendingApproval));
  const [mode, setMode] = useState<'whole' | 'lines'>(allowWhole ? 'whole' : 'lines');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reasonOk = reason.trim().length >= 3;
  const ok = reasonOk && (mode === 'whole' || picked.size > 0);

  async function go() {
    if (!ok) { setError(!reasonOk ? t('validation.reasonMin') : t('docs.cancel.pickLines')); return; }
    setBusy(true); setError(null);
    try {
      await onConfirm({ reason: reason.trim(), ...(mode === 'lines' ? { lineIds: [...picked] } : {}) });
      onClose();
    } catch (e) { setError(isApiError(e) ? e.message : String(e)); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={t('docs.cancel.title')} description={t('docs.cancel.hint')} data-testid="cancel-dialog"
        footer={<>
          <Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>
          <Button variant="danger" onClick={() => void go()} loading={busy} data-testid="cancel-confirm">{mode === 'whole' ? t('docs.cancel.whole') : t('docs.cancel.lines', { n: picked.size })}</Button>
        </>}>
        <div className="space-y-4">
          {allowWhole && allowLines && (
            <div role="radiogroup" aria-label={t('docs.cancel.what')} className="grid grid-cols-2 gap-2">
              {(['whole', 'lines'] as const).map(m => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} data-testid={`cancel-mode-${m}`}
                  className={cn('rounded border px-3 py-2 text-left text-sm', mode === m ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-border hover:bg-muted')}>
                  {m === 'whole' ? t('docs.cancel.modeWhole') : t('docs.cancel.modeLines')}
                </button>
              ))}
            </div>
          )}
          {mode === 'lines' && (
            <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded border border-border">
              {cancellable.map(l => (
                <li key={l.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-subtle">
                    <Checkbox checked={picked.has(l.id)} onCheckedChange={v => setPicked(s => { const n = new Set(s); if (v) n.add(l.id); else n.delete(l.id); return n; })} data-testid={`cancel-line-${l.lineNo}`} />
                    <span className="w-6 text-right text-sm text-fg-subtle tabular-nums">{l.lineNo}</span>
                    <span className="min-w-0 flex-1 truncate">{lineItemLabel(l)}</span>
                    <span className="text-sm text-fg-muted tabular-nums">{fmtQty(l.qty.pendingApproval)} {lineUom(l)}</span>
                  </label>
                </li>
              ))}
              {cancellable.length === 0 && <li className="px-3 py-4 text-center text-sm text-fg-muted">{t('docs.cancel.none')}</li>}
            </ul>
          )}
          <FormField label={t('common.reason')} required>
            <Textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} data-testid="cancel-reason" />
          </FormField>
          {error && <InlineAlert>{error}</InlineAlert>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

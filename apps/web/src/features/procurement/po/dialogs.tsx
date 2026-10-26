'use client';
import type { DocumentLineRow, DocumentRow } from '@procure/schema';
import { AmendInput } from '@procure/schema';
import { Button, Checkbox, Dialog, DialogContent, FormField, Segmented, Textarea } from '@procure/ui';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { dec, fmtQty } from '@/features/documents/decimal';
import { lineItemLabel, lineUom } from '@/features/documents/lines-table';
import { procApi } from '../api';

/** Ask for the amendment reason, snapshot the PO as a revision and open it for editing. */
export function AmendDialog({ doc, revNo, onClose, onDone }: { doc: DocumentRow; revNo: number; onClose: () => void; onDone: (d: DocumentRow) => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const p = AmendInput.safeParse({ reason });
    if (!p.success) { setFieldErr(t('validation.reasonMin')); return; }
    setFieldErr(null); setErr(null); setBusy(true);
    try { onDone(await procApi.amend(doc.id, p.data)); } catch (e) { setErr(isApiError(e) ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent data-testid="amend-dialog" title={t('po.amend.title', { number: doc.number ?? '' })} description={t('po.amend.hint', { n: revNo + 1 })}
        footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={go} loading={busy} data-testid="amend-confirm">{t('po.amend.confirm')}</Button></>}>
        <div className="space-y-3">
          {err && <InlineAlert data-testid="amend-error">{err}</InlineAlert>}
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
            <li>{t('po.amend.point1')}</li>
            <li>{t('po.amend.point2')}</li>
            <li>{t('po.amend.point3')}</li>
          </ul>
          <FormField label={t('po.amend.reason')} required error={fieldErr ?? undefined}>
            <Textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} data-testid="amend-reason" />
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Remaining qty a short-close would close: unreceived for POs, unordered for indents. */
export function closableQty(type: 'indent' | 'po', l: DocumentLineRow): string {
  return type === 'po' ? dec.max0(l.qty.pendingReceipt) : dec.max0(l.qty.pendingOrder);
}

export function ShortCloseDialog({ type, doc, onClose, onDone }: { type: 'indent' | 'po'; doc: DocumentRow; onClose: () => void; onDone: (d: DocumentRow) => void }) {
  const lines = [...doc.lines].sort((a, b) => a.lineNo - b.lineNo).filter(l => dec.gt0(closableQty(type, l)));
  const [mode, setMode] = useState<'whole' | 'lines'>('whole');
  const [ids, setIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (reason.trim().length < 3) { setErr(t('validation.reasonMin')); return; }
    if (mode === 'lines' && !ids.length) { setErr(t('po.sc.pickLines')); return; }
    setErr(null); setBusy(true);
    try { onDone(await procApi.shortClose(type, doc.id, { reason: reason.trim(), ...(mode === 'lines' ? { lineIds: ids } : {}) })); } catch (e) { setErr(isApiError(e) ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent data-testid="short-close-dialog" title={t('po.sc.title')} description={t(type === 'po' ? 'po.sc.hintPo' : 'po.sc.hintIndent')}
        footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button variant="danger" onClick={go} loading={busy} disabled={!lines.length} data-testid="short-close-confirm">{t('po.sc.confirm')}</Button></>}>
        <div className="space-y-3">
          {err && <InlineAlert data-testid="short-close-error">{err}</InlineAlert>}
          {lines.length === 0 ? <p className="text-sm text-fg-muted">{t('po.sc.nothing')}</p> : (
            <>
              <Segmented<'whole' | 'lines'> label={t('po.sc.scope')} value={mode} onChange={setMode} size="md" data-testid="short-close-mode"
                options={[{ value: 'whole', label: t('po.sc.whole') }, { value: 'lines', label: t('po.sc.someLines') }]} />
              <ul className="divide-y divide-border rounded border border-border">
                {lines.map(l => (
                  <li key={l.id} className="px-3 py-2">
                    <label className="flex items-center gap-2.5 text-sm">
                      {mode === 'lines' && <Checkbox checked={ids.includes(l.id)} onCheckedChange={c => setIds(x => (c ? [...x, l.id] : x.filter(i => i !== l.id)))} data-testid={`short-close-line-${l.lineNo}`} />}
                      <span className="text-fg-subtle tabular-nums">{l.lineNo}</span>
                      <span className="min-w-0 flex-1 truncate">{lineItemLabel(l)}</span>
                      <span className="tabular-nums text-fg-muted">{t('po.sc.closes', { qty: fmtQty(closableQty(type, l)), uom: lineUom(l) })}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <FormField label={t('po.sc.reason')} required>
            <Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} data-testid="short-close-reason" />
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

'use client';
import { Button, cn, Dialog, DialogContent, Input } from '@procure/ui';
import { useState } from 'react';
import { dec, fmtQty } from '@/features/documents/decimal';
import { t } from '@/i18n';

export type DecisionKind = 'approve' | 'hold' | 'reject';

/** One line of the overview: what will happen to it when the user confirms. */
export interface ConfirmRow { key: string; doc: string; item: string; uom: string; pending: string; qty: string }

const TONE: Record<DecisionKind, string> = { approve: 'text-success', hold: 'text-warning', reject: 'text-danger' };
const TITLE: Record<DecisionKind, 'approve.confirm.titleApprove' | 'approve.confirm.titleHold' | 'approve.confirm.titleReject'> = {
  approve: 'approve.confirm.titleApprove', hold: 'approve.confirm.titleHold', reject: 'approve.confirm.titleReject',
};

/** Overview popup shown before Approve / Hold / Reject is saved (approve screen and Approvals page). */
export function ConfirmDecisionDialog({ kind, rows, reason: initialReason, busy, onCancel, onConfirm }: {
  kind: DecisionKind; rows: ConfirmRow[]; reason: string; busy: boolean; onCancel: () => void; onConfirm: (reason?: string) => void;
}) {
  const needsReason = kind === 'hold' || kind === 'reject';
  const [reason, setReason] = useState(initialReason);
  const [reasonError, setReasonError] = useState('');

  // Totals per unit (MT, LTR …): mixing units in one number would be meaningless.
  const totals = new Map<string, string>();
  for (const r of rows) totals.set(r.uom, dec.add(totals.get(r.uom) ?? '0', r.qty));
  const docs = new Set(rows.map(r => r.doc)).size;
  const action = t(`approve.${kind}`);

  const handleConfirm = () => {
    if (needsReason && reason.trim().length < 3) {
      setReasonError(t('validation.reasonMin'));
      return;
    }
    onConfirm(needsReason ? reason.trim() : undefined);
  };

  return (
    <Dialog open onOpenChange={o => { if (!o && !busy) onCancel(); }}>
      <DialogContent size="lg" title={t(TITLE[kind])} description={t('approve.confirm.summary', { items: rows.length, docs })} data-testid="decision-confirm-dialog"
        footer={<>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-testid="decision-confirm-cancel">{t('common.cancel')}</Button>
          <Button variant={kind === 'reject' ? 'danger' : 'primary'} onClick={handleConfirm} loading={busy} data-testid="decision-confirm-ok">
            {t('approve.confirm.ok', { action, n: rows.length })}
          </Button>
        </>}>
        <div className="max-h-[55vh] overflow-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-subtle text-left text-xs text-fg-muted">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">{t('approve.confirm.doc')}</th>
                <th className="px-3 py-2 font-medium">{t('docs.col.item')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('approve.pendingHere')}</th>
                <th className={cn('px-3 py-2 text-right font-medium', TONE[kind])}>{action}</th>
                <th className="px-3 py-2 text-right font-medium">{t('approve.confirm.left')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r, i) => {
                const left = dec.sub(r.pending, r.qty);
                const extra = dec.cmp(left, '0') < 0;
                return (
                  <tr key={r.key} data-testid={`decision-confirm-row-${i + 1}`}>
                    <td className="px-3 py-2 tabular-nums text-fg-subtle">{i + 1}</td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">{r.doc}</td>
                    <td className="px-3 py-2">{r.item}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtQty(r.pending)} <span className="text-fg-subtle">{r.uom}</span></td>
                    <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', TONE[kind])}>{fmtQty(r.qty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-fg-muted">
                      {extra ? <span className="text-accent">{t('approve.confirm.extra', { qty: fmtQty(dec.sub(r.qty, r.pending)) })}</span> : fmtQty(left)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t border-border bg-subtle text-sm font-medium">
              <tr>
                <td className="px-3 py-2" colSpan={4}>{t('approve.confirm.total')}</td>
                <td className={cn('px-3 py-2 text-right tabular-nums', TONE[kind])} colSpan={2}>
                  {[...totals.entries()].map(([u, q]) => `${fmtQty(q)} ${u}`.trim()).join(' · ')}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {needsReason && (
          <div className="mt-3 space-y-1">
            <label className="block text-sm font-medium text-fg" htmlFor="confirm-reason">
              {t('common.reason')} <span className="text-danger">*</span>
            </label>
            <Input
              id="confirm-reason"
              value={reason}
              onChange={e => { setReason(e.target.value); if (reasonError) setReasonError(''); }}
              placeholder={t('approve.reasonPlaceholder')}
              aria-label={t('common.reason')}
              aria-required
              aria-invalid={!!reasonError || undefined}
              className={cn('w-full', reasonError && 'border-danger')}
              data-testid="decision-confirm-reason"
              autoFocus
            />
            {reasonError && <p className="text-xs text-danger">{reasonError}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

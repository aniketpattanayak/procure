'use client';
import { Button, cn, Dialog, DialogContent } from '@procure/ui';
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
export function ConfirmDecisionDialog({ kind, rows, reason, busy, onCancel, onConfirm }: {
  kind: DecisionKind; rows: ConfirmRow[]; reason: string; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  // Totals per unit (MT, LTR …): mixing units in one number would be meaningless.
  const totals = new Map<string, string>();
  for (const r of rows) totals.set(r.uom, dec.add(totals.get(r.uom) ?? '0', r.qty));
  const docs = new Set(rows.map(r => r.doc)).size;
  const action = t(`approve.${kind}`);
  return (
    <Dialog open onOpenChange={o => { if (!o && !busy) onCancel(); }}>
      <DialogContent size="lg" title={t(TITLE[kind])} description={t('approve.confirm.summary', { items: rows.length, docs })} data-testid="decision-confirm-dialog"
        footer={<>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-testid="decision-confirm-cancel">{t('common.cancel')}</Button>
          <Button variant={kind === 'reject' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} data-testid="decision-confirm-ok">
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
        {reason && <p className="mt-3 text-sm"><span className="text-fg-muted">{t('common.reason')}:</span> {reason}</p>}
      </DialogContent>
    </Dialog>
  );
}

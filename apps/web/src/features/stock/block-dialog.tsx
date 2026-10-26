'use client';
import type { StockBalanceRow } from '@procure/schema';
import { Button, Dialog, DialogContent, FormField, Input, Segmented, Textarea, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { t } from '@/i18n';
import { stockApi, stockError, stockKeys } from './api';

type Direction = 'block' | 'unblock';

/** Move quantity between available and quarantine (paired movements on the server). */
export function BlockDialog({ row, onClose, onDone }: { row: StockBalanceRow; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [direction, setDirection] = useState<Direction>(dec.gt0(row.available) ? 'block' : 'unblock');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);

  const max = direction === 'block' ? row.available : row.quarantine;
  const qtyErr = !isDecimal(qty) || !dec.gt0(qty) ? t('stock.err.qty') : dec.cmp(qty, max) > 0 ? t('stock.err.max', { qty: fmtQty(max) }) : null;
  const reasonErr = reason.trim().length < 3 ? t('stock.err.reason') : null;

  const save = async () => {
    setTouched(true);
    setError(null);
    if (qtyErr || reasonErr) return;
    setSaving(true);
    try {
      await stockApi.block({ itemId: row.item.id, nodeId: row.node.id, batchId: row.batch?.id, qty: dec.norm(qty), reason: reason.trim(), direction });
      void qc.invalidateQueries({ queryKey: stockKeys.all });
      toast.success(direction === 'block' ? t('stock.block.done') : t('stock.unblock.done'));
      onDone();
    } catch (e) {
      setError(stockError(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent
        title={t('stock.block.title')}
        description={`${row.item.name} · ${row.node.name}${row.batch ? ` · ${row.batch.batchNo}` : ''}`}
        closeLabel={t('common.close')}
        data-testid="stock-block-dialog"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button onClick={save} loading={saving} data-testid="stock-block-save">{direction === 'block' ? t('stock.block.action') : t('stock.unblock.action')}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Segmented<Direction> label={t('stock.block.direction')} value={direction} onChange={setDirection} size="md"
            options={[{ value: 'block', label: t('stock.block.toQuarantine') }, { value: 'unblock', label: t('stock.unblock.toAvailable') }]} data-testid="stock-block-direction" />
          <p className="text-sm text-fg-muted">{t('stock.block.balances', { available: fmtQty(row.available), quarantine: fmtQty(row.quarantine) })}</p>
          <FormField label={t('stock.qty')} required error={touched ? qtyErr ?? undefined : undefined} hint={t('stock.block.max', { qty: fmtQty(max) })}>
            <Input inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} data-testid="stock-block-qty" />
          </FormField>
          <FormField label={t('common.reason')} required error={touched ? reasonErr ?? undefined : undefined}>
            <Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} maxLength={500} data-testid="stock-block-reason" />
          </FormField>
          {error && <p role="alert" className="text-sm text-danger" data-testid="stock-block-error">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

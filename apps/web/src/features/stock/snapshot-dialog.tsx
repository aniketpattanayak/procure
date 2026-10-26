'use client';
import { Button, Dialog, DialogContent, FormField, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { docKeys } from '@/features/documents/api';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { stockApi } from './api';
import { CheckLabel, LocationSelect } from './components';

/** Freeze book quantities at a location into a draft stock count, then open the count sheet. */
export function SnapshotDialog({ defaultNode, onClose }: { defaultNode?: string; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [node, setNode] = useState(defaultNode ?? '');
  const [children, setChildren] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const start = async () => {
    setError(null);
    if (!node) { setError(t('stock.count.pickNode')); return; }
    setSaving(true);
    try {
      const doc = await stockApi.countSnapshot({ nodeId: node, includeChildren: children });
      void qc.invalidateQueries({ queryKey: docKeys.all('stock_count') });
      toast.success(t('stock.count.created', { n: doc.lines.length }));
      router.push(`/stock/count/${doc.id}`);
    } catch (e) {
      setError(isApiError(e) ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent
        title={t('stock.count.start')}
        description={t('stock.count.hint')}
        closeLabel={t('common.close')}
        data-testid="stock-snapshot-dialog"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button onClick={start} loading={saving} data-testid="stock-snapshot-create">{t('stock.count.create')}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label={t('stock.filter.location')} required error={error && !node ? error : undefined}>
            <LocationSelect value={node} onChange={setNode} label={t('stock.filter.location')} className="h-9 w-full" testId="stock-snapshot-node" required />
          </FormField>
          <CheckLabel checked={children} onChange={setChildren} label={t('stock.includeChildren')} testId="stock-snapshot-children" />
          {error && node && <p role="alert" className="text-sm text-danger" data-testid="stock-snapshot-error">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

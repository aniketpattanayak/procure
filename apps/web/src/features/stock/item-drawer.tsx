'use client';
import { Button, EmptyState, Sheet, SheetContent, Skeleton } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { History, PackageOpen } from 'lucide-react';
import Link from 'next/link';
import { InlineAlert } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { STOCK_PERM, stockApi, stockKeys } from './api';
import { Qty } from './components';

/** Item stock drawer: per-node available / quarantine / rejected, value, avg cost, open PO and pending issue. */
export function ItemStockDrawer({ itemId, itemName, onClose }: { itemId: string; itemName: string; onClose: () => void }) {
  const p = usePermissions();
  const { currency } = useTenantLocale();
  const q = useQuery({ queryKey: stockKeys.summary(itemId), queryFn: () => stockApi.summary(itemId), retry: false });
  const held = {
    available: p.has(STOCK_PERM.statusView('available')),
    quarantine: p.has(STOCK_PERM.statusView('quarantine')),
    rejected: p.has(STOCK_PERM.statusView('rejected')),
  };
  const money = (v: string | null) => (v === null ? '—' : fmtMoney(Number(v), currency));
  const s = q.data;
  const uom = s?.item.uom ?? null;
  return (
    <Sheet open onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent side="right" title={itemName} className="max-w-lg sm:w-[32rem]" closeLabel={t('common.close')} data-testid="stock-item-drawer">
        <div className="space-y-4 p-4">
          {q.isLoading ? (
            <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
          ) : q.isError ? (
            <InlineAlert>{isApiError(q.error) ? q.error.message : t('stock.loadFailed')}</InlineAlert>
          ) : !s ? null : (
            <>
              <p className="text-sm text-fg-muted">{s.item.code}{uom ? ` · ${uom}` : ''}</p>
              <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 text-sm sm:grid-cols-3" data-testid="stock-item-totals">
                {held.available && <Fact label={t('stock.status.available')} value={<Qty value={s.totals.available} uom={uom} testId="summary-available" className="font-semibold" />} />}
                {held.quarantine && <Fact label={t('stock.status.quarantine')} value={<Qty value={s.totals.quarantine} testId="summary-quarantine" />} />}
                {held.rejected && <Fact label={t('stock.status.rejected')} value={<Qty value={s.totals.rejected} testId="summary-rejected" />} />}
                <Fact label={t('stock.openPo')} value={<Qty value={s.totals.openPoQty} />} />
                <Fact label={t('stock.pendingIssue')} value={<Qty value={s.totals.pendingIssueQty} />} />
                {s.totals.value !== null && <Fact label={t('stock.col.value')} value={<span className="tabular-nums">{money(s.totals.value)}</span>} />}
              </dl>
              <h3 className="text-sm font-semibold">{t('stock.byLocation')}</h3>
              {s.nodes.length === 0 ? <EmptyState icon={<PackageOpen />} title={t('stock.itemNoStock')} /> : (
                <ul className="divide-y divide-border rounded-lg border border-border" data-testid="stock-item-nodes">
                  {s.nodes.map(n => (
                    <li key={n.node.id} className="space-y-1.5 px-3 py-2.5 text-sm" data-testid={`stock-item-node-${n.node.code}`}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate font-medium">{n.node.name} <span className="font-normal text-fg-subtle">{n.node.code}</span></p>
                        <Button asChild size="sm" variant="ghost"><Link href={`/stock/ledger?item=${itemId}&node=${n.node.id}&children=0`} aria-label={t('stock.ledger.forNode', { node: n.node.name })}><History aria-hidden />{t('stock.ledger.short')}</Link></Button>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-fg-muted sm:grid-cols-3">
                        {held.available && <span>{t('stock.status.available')}: <Qty value={n.available} className="text-fg" /></span>}
                        {held.quarantine && <span>{t('stock.status.quarantine')}: <Qty value={n.quarantine} className="text-fg" /></span>}
                        {held.rejected && <span>{t('stock.status.rejected')}: <Qty value={n.rejected} className="text-fg" /></span>}
                        <span>{t('stock.openPo')}: <Qty value={n.openPoQty} className="text-fg" /></span>
                        <span>{t('stock.pendingIssue')}: <Qty value={n.pendingIssueQty} className="text-fg" /></span>
                        {n.value !== null && <span>{t('stock.col.value')}: <span className="tabular-nums text-fg">{money(n.value)}</span></span>}
                        {n.avgCost !== null && <span>{t('stock.col.avgCost')}: <span className="tabular-nums text-fg">{money(n.avgCost)}</span></span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <Button asChild variant="secondary" className="w-full"><Link href={`/stock/ledger?item=${itemId}`} data-testid="stock-item-ledger"><History aria-hidden />{t('stock.ledger.allFor')}</Link></Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt className="text-xs text-fg-subtle">{label}</dt><dd className="mt-0.5">{value}</dd></div>;
}

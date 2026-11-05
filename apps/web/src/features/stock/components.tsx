'use client';
/** Small building blocks shared by the stock screens. */
import type { LocationNode } from '@procure/schema';
import { Checkbox, cn, Input, Label, NativeSelect } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useId } from 'react';
import { locationKeys, locationsApi } from '@/features/locations/api';
import { dec, fmtQty } from '@/features/documents/decimal';
import { t } from '@/i18n';
import { useMe, usePermissions } from '@/lib/permissions';
import { readStockFlow, STOCK_PERM, stockApi } from './api';

/** Locations within the caller's scope (flat, tree-ordered with depth). */
export function useScopedLocations() {
  return useQuery({ queryKey: locationKeys.mine, queryFn: () => locationsApi.tree({ scope: 'mine', view: 'active' }), staleTime: 5 * 60_000, retry: false });
}

export function useStockFlow() {
  return readStockFlow(useMe()?.settings as Record<string, unknown> | undefined);
}

const indent = (n: LocationNode) => `${'  '.repeat(Math.max(0, n.depth - 1))}${n.name}`;

/** Location dropdown (tree indented). `allLabel` adds an "all" option with value ''. */
export function LocationSelect({ value, onChange, allLabel, label, className, testId, required, id }: {
  value: string; onChange: (v: string) => void; allLabel?: string; label: string; className?: string; testId?: string; required?: boolean; id?: string;
}) {
  const locs = useScopedLocations();
  return (
    <NativeSelect id={id} aria-label={label} className={cn('h-8', className)} value={value} onChange={e => onChange(e.target.value)} data-testid={testId} required={required} disabled={locs.isLoading}>
      {allLabel !== undefined ? <option value="">{allLabel}</option> : <option value="" disabled>{t('stock.pickLocation')}</option>}
      {(locs.data ?? []).map(n => <option key={n.id} value={n.id}>{indent(n)}</option>)}
    </NativeSelect>
  );
}

export function SearchBox({ value, onChange, label, testId, className }: { value: string; onChange: (v: string) => void; label: string; testId?: string; className?: string }) {
  return (
    <div className={cn('relative w-full sm:w-60', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
      <Input type="search" value={value} onChange={e => onChange(e.target.value)} placeholder={label} aria-label={label} className="h-8 pl-8" data-testid={testId} />
    </div>
  );
}

export function CheckLabel({ checked, onChange, label, testId, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; testId?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={c => onChange(c === true)} data-testid={testId} disabled={disabled} />
      <Label htmlFor={id} className="text-sm font-normal">{label}</Label>
    </span>
  );
}

/** Qty with its unit, muted unit. */
export function Qty({ value, uom, className, testId }: { value: string | null | undefined; uom?: string | null; className?: string; testId?: string }) {
  return (
    <span className={cn('tabular-nums', className)} data-testid={testId} data-value={value ?? ''}>
      {fmtQty(value ?? '0')}{uom ? <span className="ml-1 text-xs text-fg-subtle">{uom}</span> : null}
    </span>
  );
}

/** Today's date as YYYY-MM-DD in local time. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Batch chooser for an outgoing line: lists the available stock per batch of the item at exactly `nodeId`
 * (`/stock/balances?byBatch`), "No batch" for unbatched stock. Falls back to a free-text input without stock view.
 * Picks a default once: unbatched when it covers `qty`, else the first batch (earliest expiry first) that does.
 */
export function BatchPicker({ itemId, nodeId, qty, value, onChange, label, testId }: {
  itemId: string; nodeId: string; qty: string; value: string | undefined; onChange: (v: string) => void; label: string; testId?: string;
}) {
  const p = usePermissions();
  const canView = p.has(STOCK_PERM.view);
  const q = useQuery({
    queryKey: ['stock', 'batches', itemId, nodeId],
    queryFn: () => stockApi.balances({ item: itemId, node: nodeId, includeChildren: false, byBatch: true, status: 'available' }, null, 200),
    enabled: canView, staleTime: 30_000, retry: false,
  });
  const rows = (q.data?.data ?? []).filter(r => r.node.id === nodeId && dec.gt0(r.available))
    .sort((a, b) => (a.batch?.expiryDate ?? '9999').localeCompare(b.batch?.expiryDate ?? '9999'));
  useEffect(() => {
    if (value !== undefined || !q.data) return;
    const loose = rows.find(r => !r.batch);
    const pick = loose && dec.cmp(loose.available, qty) >= 0 ? loose : rows.find(r => r.batch && dec.cmp(r.available, qty) >= 0) ?? loose ?? rows[0];
    onChange(pick?.batch?.batchNo ?? '');
  }, [q.data]); // only when the balances arrive
  if (!canView || q.isError) {
    return <Input className="h-8" value={value ?? ''} maxLength={60} placeholder={label} onChange={e => onChange(e.target.value)} aria-label={label} data-testid={testId} />;
  }
  return (
    <NativeSelect className="h-8" value={value ?? ''} onChange={e => onChange(e.target.value)} aria-label={label} disabled={q.isLoading} data-testid={testId}>
      {!rows.some(r => !r.batch) && <option value="">{t('stock.batch.none', { qty: '0' })}</option>}
      {rows.map(r => (
        <option key={r.batch?.id ?? 'none'} value={r.batch?.batchNo ?? ''}>
          {r.batch ? t('stock.batch.option', { batch: r.batch.batchNo, qty: fmtQty(r.available) }) : t('stock.batch.none', { qty: fmtQty(r.available) })}
        </option>
      ))}
    </NativeSelect>
  );
}

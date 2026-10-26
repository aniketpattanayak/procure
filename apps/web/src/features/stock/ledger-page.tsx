'use client';
import type { StockLedgerRow } from '@procure/schema';
import { Badge, Button, DataTable, EmptyState, Input, NativeSelect, type BadgeTone, type DataTableColumn } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, History } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { PageBody, PageHeader } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { useDocTypes } from '@/features/documents/api';
import { MasterPicker } from '@/features/procurement/components/master-picker';
import { t } from '@/i18n';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { STOCK_PERM, stockApi, stockKeys, type LedgerQuery } from './api';
import { CheckLabel, LocationSelect, Qty } from './components';
import { MOVEMENT_TYPES, movementLabel } from './labels';

const TONE: Partial<Record<string, BadgeTone>> = {
  receipt: 'success', opening: 'accent', return: 'success', transfer_in: 'accent', adjustment_in: 'success', count_in: 'success', unblock: 'success',
  issue: 'neutral', transfer_out: 'accent', adjustment_out: 'warning', count_out: 'warning', block: 'warning', reject: 'danger', rtv: 'danger', reversal: 'neutral',
};

/** Stock ledger: every movement with the running balance per item × node (from the API), drill-down to documents. */
export function LedgerPage() {
  const p = usePermissions();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { currency } = useTenantLocale();
  const docTypes = useDocTypes();
  const showValue = p.has(STOCK_PERM.value);

  const item = sp.get('item') ?? '';
  const node = sp.get('node') ?? '';
  const includeChildren = sp.get('children') !== '0';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const movementType = sp.get('type') ?? '';
  const document = sp.get('document') ?? '';

  const setParams = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [sp, router, pathname]);

  // Name for an item preselected through the URL (drill-down from the balances grid).
  const itemInfo = useQuery({ queryKey: stockKeys.summary(item), queryFn: () => stockApi.summary(item), enabled: !!item, retry: false, staleTime: 60_000 });
  const pickedItem = item ? { id: item, name: itemInfo.data?.item.name ?? t('common.loading'), code: itemInfo.data?.item.code } : null;

  const query: LedgerQuery = { item: item || undefined, node: node || undefined, includeChildren, from: from || undefined, to: to || undefined, movementType: movementType || undefined, document: document || undefined };
  const queryKey = JSON.stringify(query);
  const fetchPage = useCallback((cursor: string | null) => stockApi.ledger(query, cursor), [queryKey]);

  const typeName = useCallback((key: string) => docTypes.data?.find(d => d.key === key)?.name ?? key, [docTypes.data]);

  const columns = useMemo<DataTableColumn<StockLedgerRow>[]>(() => {
    const cols: DataTableColumn<StockLedgerRow>[] = [
      { id: 'at', label: t('stock.col.date'), header: t('stock.col.date'), width: 136, cell: ({ row: { original: r } }) => <span className="tabular-nums text-sm">{fmtDateTime(r.at)}</span> },
      {
        id: 'document', label: t('stock.col.document'), header: t('stock.col.document'), width: 190, alwaysVisible: true,
        cell: ({ row: { original: r } }) => r.document ? (
          <Link href={`/docs/${r.document.docTypeKey}/${r.document.id}${r.lineNo ? `#line-${r.lineNo}` : ''}`} onClick={e => e.stopPropagation()} className="min-w-0 truncate font-medium text-accent hover:underline" data-testid={`ledger-doc-${r.id}`}>
            {r.document.number ?? t('stock.draftDoc')}
            <span className="block truncate text-xs font-normal text-fg-subtle">{typeName(r.document.docTypeKey)}{r.lineNo ? ` · ${t('stock.lineN', { n: r.lineNo })}` : ''}</span>
          </Link>
        ) : <span className="text-fg-subtle">{r.reason ?? '—'}</span>,
      },
      { id: 'type', label: t('stock.col.movement'), header: t('stock.col.movement'), width: 130, cell: ({ row: { original: r } }) => <Badge tone={TONE[r.movementType] ?? 'neutral'} data-testid={`ledger-type-${r.id}`}>{movementLabel(r.movementType)}</Badge> },
      { id: 'item', label: t('stock.col.item'), header: t('stock.col.item'), width: 200, cell: ({ row: { original: r } }) => <span className="min-w-0 truncate">{r.item.name}<span className="block truncate text-xs text-fg-subtle">{r.item.code}</span></span> },
      { id: 'node', label: t('stock.col.location'), header: t('stock.col.location'), width: 140, cell: ({ row: { original: r } }) => <span className="truncate">{r.node.name}</span> },
      { id: 'batch', label: t('stock.col.batch'), header: t('stock.col.batch'), width: 110, defaultHidden: true, cell: ({ row: { original: r } }) => <span className="truncate">{r.batchNo ?? '—'}</span> },
      { id: 'in', label: t('stock.col.in'), header: t('stock.col.in'), width: 90, align: 'right', cell: ({ row: { original: r } }) => <Qty value={r.qtyIn} className={Number(r.qtyIn) ? 'text-success' : 'text-fg-subtle'} /> },
      { id: 'out', label: t('stock.col.out'), header: t('stock.col.out'), width: 90, align: 'right', cell: ({ row: { original: r } }) => <Qty value={r.qtyOut} className={Number(r.qtyOut) ? 'text-danger' : 'text-fg-subtle'} /> },
      { id: 'balance', label: t('stock.col.balance'), header: t('stock.col.balance'), width: 100, align: 'right', alwaysVisible: true, cell: ({ row: { original: r } }) => <Qty value={r.balanceAfter} className="font-semibold" testId={`ledger-balance-${r.id}`} /> },
      { id: 'status', label: t('stock.col.status'), header: t('stock.col.status'), width: 110, cell: ({ row: { original: r } }) => <span className="text-sm">{t(`stock.status.${r.status}`)}</span> },
    ];
    if (showValue) {
      cols.push(
        { id: 'unitCost', label: t('stock.col.unitCost'), header: t('stock.col.unitCost'), width: 100, align: 'right', defaultHidden: true, cell: ({ row: { original: r } }) => <span className="tabular-nums">{r.unitCost === null ? '—' : fmtMoney(Number(r.unitCost), currency)}</span> },
        { id: 'value', label: t('stock.col.value'), header: t('stock.col.value'), width: 120, align: 'right', cell: ({ row: { original: r } }) => <span className="tabular-nums">{r.value === null ? '—' : fmtMoney(Number(r.value), currency)}</span> },
      );
    }
    cols.push(
      { id: 'actor', label: t('stock.col.by'), header: t('stock.col.by'), width: 130, defaultHidden: true, cell: ({ row: { original: r } }) => <span className="truncate text-sm">{r.actor ?? '—'}</span> },
      { id: 'reason', label: t('common.reason'), header: t('common.reason'), width: 180, defaultHidden: true, cell: ({ row: { original: r } }) => <span className="truncate text-sm" title={r.reason ?? undefined}>{r.reason ?? '—'}</span> },
    );
    return cols;
  }, [showValue, currency, typeName]);

  const hasFilters = !!(item || node || from || to || movementType || document);
  return (
    <PageBody>
      <PageHeader
        back={<Link href="/stock" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('stock.title')}</Link>}
        title={t('stock.ledger.title')}
        description={t('stock.ledger.hint')}
      />
      <DataTable<StockLedgerRow>
        key={columns.length}
        data-testid="stock-ledger"
        columns={columns}
        fetchPage={fetchPage}
        queryKey={queryKey}
        getRowId={r => r.id}
        onRowClick={r => { if (r.document) router.push(`/docs/${r.document.docTypeKey}/${r.document.id}`); }}
        storageKey="stock:ledger"
        rowHeight={52}
        labels={{ caption: t('stock.ledger.title'), columns: t('table.columns'), loadMore: t('table.loadMore'), error: t('table.error'), retry: t('common.retry'), loading: t('common.loading') }}
        empty={<EmptyState icon={<History />} title={hasFilters ? t('stock.ledger.emptyFiltered') : t('stock.ledger.empty')}
          action={hasFilters ? <Button variant="secondary" onClick={() => router.replace(pathname)}>{t('docs.list.clearFilters')}</Button> : undefined} />}
        toolbar={
          <div className="flex w-full flex-wrap items-center gap-2" data-testid="ledger-filters">
            <div className="w-full sm:w-56"><MasterPicker masterKey="item" value={pickedItem} onChange={v => setParams({ item: v?.id ?? null })} ariaLabel={t('stock.filter.item')} placeholder={t('stock.filter.item')} compact testId="ledger-filter-item" /></div>
            <LocationSelect value={node} onChange={v => setParams({ node: v || null })} allLabel={t('topbar.allLocations')} label={t('stock.filter.location')} className="w-full sm:w-48" testId="ledger-filter-location" />
            <CheckLabel checked={includeChildren} onChange={v => setParams({ children: v ? null : '0' })} label={t('stock.includeChildren')} disabled={!node} />
            <NativeSelect aria-label={t('stock.col.movement')} className="h-8 w-full sm:w-40" value={movementType} onChange={e => setParams({ type: e.target.value || null })} data-testid="ledger-filter-type">
              <option value="">{t('stock.mv.all')}</option>
              {MOVEMENT_TYPES.map(m => <option key={m} value={m}>{movementLabel(m)}</option>)}
            </NativeSelect>
            <label className="flex items-center gap-1.5 text-sm text-fg-muted">{t('stock.from')}<Input type="date" className="h-8 w-36" value={from} onChange={e => setParams({ from: e.target.value || null })} data-testid="ledger-filter-from" /></label>
            <label className="flex items-center gap-1.5 text-sm text-fg-muted">{t('stock.to')}<Input type="date" className="h-8 w-36" value={to} onChange={e => setParams({ to: e.target.value || null })} data-testid="ledger-filter-to" /></label>
            {document && <Button size="sm" variant="ghost" onClick={() => setParams({ document: null })}>{t('stock.ledger.clearDoc')}</Button>}
          </div>
        }
      />
      <p className="mt-2 text-xs text-fg-subtle">{t('stock.ledger.balanceNote')}</p>
    </PageBody>
  );
}

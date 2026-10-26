'use client';
import type { StockBalanceRow, StockStatus } from '@procure/schema';
import { Badge, Button, DataTable, EmptyState, NativeSelect, Segmented, type DataTableColumn } from '@procure/ui';
import { ArrowLeftRight, ClipboardCheck, History, Lock, PackageOpen, Repeat, Upload } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { PageBody, PageHeader } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { MasterPicker, type PickedOption } from '@/features/procurement/components/master-picker';
import { t, type MessageKey } from '@/i18n';
import { fmtDate, fmtMoney } from '@/lib/format';
import { useCurrentLocationId } from '@/lib/location';
import { usePermissions } from '@/lib/permissions';
import { useTenantPrincipal } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { STOCK_PERM, STOCK_STATUSES, stockApi, type BalanceQuery } from './api';
import { BlockDialog } from './block-dialog';
import { CheckLabel, LocationSelect, Qty, SearchBox } from './components';
import { ItemStockDrawer } from './item-drawer';
import { SnapshotDialog } from './snapshot-dialog';

type StatusView = 'all' | StockStatus;
const EXPIRY_OPTIONS = [0, 30, 60, 90, 180];

/** Stock balances grid: item × node [× batch], virtualised with server cursor paging. */
export function StockBalancesPage() {
  const p = usePermissions();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const me = useTenantPrincipal();
  const switcher = useCurrentLocationId(me?.userId);
  const { currency } = useTenantLocale();

  const held = STOCK_STATUSES.filter(s => p.has(STOCK_PERM.statusView(s)));
  const showValue = p.has(STOCK_PERM.value);
  const canBlock = p.has(STOCK_PERM.block);

  // Filters live in the URL so a filtered grid can be shared / bookmarked.
  const node = sp.get('node') ?? switcher ?? '';
  const includeChildren = sp.get('children') !== '0';
  const status = (sp.get('status') as StatusView | null) ?? 'all';
  const byBatch = sp.get('batch') === '1';
  const belowMin = sp.get('below') === '1';
  const expiring = Number(sp.get('expiring') ?? 0) || 0;
  const [q, setQ] = useState(sp.get('q') ?? '');
  const dq = useDebounced(q, 300);
  const [item, setItem] = useState<PickedOption | null>(null);

  const setParams = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [sp, router, pathname]);

  const query: BalanceQuery = {
    node: node || undefined, includeChildren, item: item?.id, q: dq || undefined,
    status: status === 'all' ? undefined : status, byBatch: byBatch || expiring > 0, belowMin, expiringWithinDays: expiring || undefined,
  };
  const queryKey = JSON.stringify(query);
  const fetchPage = useCallback((cursor: string | null) => stockApi.balances(query, cursor), [queryKey]);

  const [drawer, setDrawer] = useState<StockBalanceRow | null>(null);
  const [block, setBlock] = useState<StockBalanceRow | null>(null);
  const [snapshot, setSnapshot] = useState(false);
  const [bump, setBump] = useState(0);

  const statusCols: { s: StockStatus; label: MessageKey; tone?: 'warning' | 'danger' }[] = [
    { s: 'available', label: 'stock.status.available' },
    { s: 'quarantine', label: 'stock.status.quarantine', tone: 'warning' },
    { s: 'rejected', label: 'stock.status.rejected', tone: 'danger' },
  ];

  const columns = useMemo<DataTableColumn<StockBalanceRow>[]>(() => {
    const cols: DataTableColumn<StockBalanceRow>[] = [
      {
        id: 'item', label: t('stock.col.item'), header: t('stock.col.item'), width: 240, alwaysVisible: true,
        cell: ({ row: { original: r } }) => (
          <span className="min-w-0">
            <span className="block truncate font-medium">{r.item.name}</span>
            <span className="block truncate text-xs text-fg-subtle">{r.item.code}</span>
          </span>
        ),
      },
      {
        id: 'node', label: t('stock.col.location'), header: t('stock.col.location'), width: 200,
        cell: ({ row: { original: r } }) => <span className="truncate" title={r.node.path.join(' / ')}>{r.node.name}<span className="block truncate text-xs text-fg-subtle">{r.node.path.slice(0, -1).join(' / ')}</span></span>,
      },
    ];
    if (byBatch || expiring > 0) {
      cols.push({
        id: 'batch', label: t('stock.col.batch'), header: t('stock.col.batch'), width: 150,
        cell: ({ row: { original: r } }) => r.batch ? (
          <span className="truncate">{r.batch.batchNo}{r.batch.expiryDate && <span className="block text-xs text-fg-subtle">{t('stock.expires', { date: fmtDate(r.batch.expiryDate) })}</span>}</span>
        ) : <span className="text-fg-subtle">—</span>,
      });
    }
    for (const c of statusCols) {
      if (!held.includes(c.s)) continue;
      cols.push({
        id: c.s, label: t(c.label), header: t(c.label), width: 110, align: 'right',
        cell: ({ row: { original: r } }) => <Qty value={r[c.s]} uom={c.s === 'available' ? r.item.uom : null} className={Number(r[c.s]) === 0 ? 'text-fg-subtle' : c.tone === 'warning' ? 'text-warning' : c.tone === 'danger' ? 'text-danger' : undefined} />,
      });
    }
    if (held.length > 1) cols.push({ id: 'total', label: t('stock.col.total'), header: t('stock.col.total'), width: 100, align: 'right', cell: ({ row: { original: r } }) => <Qty value={r.total} className="font-medium" /> });
    if (showValue) {
      cols.push(
        { id: 'avgCost', label: t('stock.col.avgCost'), header: t('stock.col.avgCost'), width: 110, align: 'right', defaultHidden: true, cell: ({ row: { original: r } }) => <span className="tabular-nums">{r.avgCost === null ? '—' : fmtMoney(Number(r.avgCost), currency)}</span> },
        { id: 'value', label: t('stock.col.value'), header: t('stock.col.value'), width: 130, align: 'right', cell: ({ row: { original: r } }) => <span className="tabular-nums">{r.value === null ? '—' : fmtMoney(Number(r.value), currency)}</span> },
      );
    }
    cols.push({
      id: 'reorder', label: t('stock.col.reorder'), header: t('stock.col.reorder'), width: 130,
      cell: ({ row: { original: r } }) => !r.reorder ? <span className="text-fg-subtle">—</span> : (
        <span className="flex items-center gap-1.5 tabular-nums">
          {t('stock.minQty', { qty: r.reorder.minQty })}
          {r.reorder.belowMin && <Badge tone="danger" data-testid="below-min">{t('stock.belowMin')}</Badge>}
        </span>
      ),
    });
    cols.push({
      id: 'actions', label: t('common.actions'), header: () => <span className="sr-only">{t('common.actions')}</span>, width: canBlock ? 128 : 56, alwaysVisible: true,
      cell: ({ row: { original: r } }) => (
        <span className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
          {canBlock && (
            <Button size="sm" variant="ghost" onClick={() => setBlock(r)} aria-label={t('stock.block.forItem', { item: r.item.name })} data-testid={`stock-block-${r.item.code}`}>
              <Lock aria-hidden />{t('stock.block.short')}
            </Button>
          )}
          <Button asChild size="sm" variant="ghost" aria-label={t('stock.ledger.forItem', { item: r.item.name })}>
            <Link href={`/stock/ledger?item=${r.item.id}&node=${r.node.id}&children=0`}><History aria-hidden /></Link>
          </Button>
        </span>
      ),
    });
    return cols;
  }, [byBatch, expiring, held.join(','), showValue, canBlock, currency]);

  const views: { value: StatusView; label: string }[] = [
    { value: 'all', label: t('stock.view.all') },
    ...statusCols.filter(c => held.includes(c.s)).map(c => ({ value: c.s as StatusView, label: t(c.label) })),
  ];

  const hasFilters = !!(node || item || dq || belowMin || expiring || status !== 'all');
  return (
    <PageBody>
      <PageHeader
        title={t('stock.title')}
        description={t('stock.hint')}
        actions={
          <>
            <Button asChild variant="secondary"><Link href="/stock/ledger" data-testid="stock-ledger-link"><History aria-hidden />{t('stock.ledger.title')}</Link></Button>
            {p.has(STOCK_PERM.reorder) && <Button asChild variant="secondary"><Link href="/stock/reorder" data-testid="stock-reorder-link"><Repeat aria-hidden />{t('stock.reorder.short')}</Link></Button>}
            {p.has(STOCK_PERM.opening) && <Button asChild variant="secondary"><Link href="/stock/opening" data-testid="stock-opening-link"><Upload aria-hidden />{t('stock.opening.short')}</Link></Button>}
            {p.has(STOCK_PERM.opening) && <Button asChild variant="secondary"><Link href="/stock/adjustment" data-testid="stock-adjustment-link"><ArrowLeftRight aria-hidden />Write-off / Adjust</Link></Button>}
            {p.has(STOCK_PERM.countAdd) && <Button variant="secondary" onClick={() => setSnapshot(true)} data-testid="stock-count-open"><ClipboardCheck aria-hidden />{t('stock.count.start')}</Button>}
          </>
        }
      />
      {held.length === 0 ? (
        <EmptyState icon={<Lock />} title={t('stock.noStatusViews')} description={t('stock.noStatusViewsHint')} />
      ) : (
        <DataTable<StockBalanceRow>
          key={`${columns.length}:${bump}`}
          data-testid="stock-balances"
          columns={columns}
          fetchPage={fetchPage}
          queryKey={`${queryKey}:${bump}`}
          getRowId={r => `${r.item.id}:${r.node.id}:${r.batch?.id ?? ''}`}
          onRowClick={r => setDrawer(r)}
          storageKey="stock:balances"
          rowHeight={52}
          labels={{ caption: t('stock.title'), columns: t('table.columns'), loadMore: t('table.loadMore'), error: t('table.error'), retry: t('common.retry'), loading: t('common.loading') }}
          empty={
            <EmptyState icon={<PackageOpen />} title={hasFilters ? t('stock.emptyFiltered') : t('stock.empty')} description={hasFilters ? t('stock.emptyFilteredHint') : t('stock.emptyHint')}
              action={hasFilters ? <Button variant="secondary" onClick={() => { setQ(''); setItem(null); router.replace(pathname); }}>{t('docs.list.clearFilters')}</Button> : undefined} />
          }
          toolbar={
            <div className="flex w-full flex-wrap items-center gap-2" data-testid="stock-filters">
              <SearchBox value={q} onChange={setQ} label={t('stock.search')} testId="stock-search" />
              <div className="w-full sm:w-52"><MasterPicker masterKey="item" value={item} onChange={setItem} ariaLabel={t('stock.filter.item')} placeholder={t('stock.filter.item')} compact testId="stock-filter-item" /></div>
              <LocationSelect value={node} onChange={v => setParams({ node: v || null })} allLabel={t('topbar.allLocations')} label={t('stock.filter.location')} className="w-full sm:w-48" testId="stock-filter-location" />
              <CheckLabel checked={includeChildren} onChange={v => setParams({ children: v ? null : '0' })} label={t('stock.includeChildren')} testId="stock-filter-children" disabled={!node} />
              <Segmented<StatusView> label={t('stock.view.label')} value={views.some(v => v.value === status) ? status : 'all'} onChange={v => setParams({ status: v === 'all' ? null : v })} options={views} data-testid="stock-status-view" />
              <CheckLabel checked={byBatch || expiring > 0} onChange={v => setParams({ batch: v ? '1' : null })} label={t('stock.byBatch')} testId="stock-filter-batch" disabled={expiring > 0} />
              <CheckLabel checked={belowMin} onChange={v => setParams({ below: v ? '1' : null })} label={t('stock.belowMinOnly')} testId="stock-filter-below" />
              <NativeSelect aria-label={t('stock.expiring')} className="h-8 w-full sm:w-44" value={String(expiring)} onChange={e => setParams({ expiring: e.target.value === '0' ? null : e.target.value })} data-testid="stock-filter-expiring">
                {EXPIRY_OPTIONS.map(d => <option key={d} value={d}>{d === 0 ? t('stock.expiringAny') : t('stock.expiringIn', { n: d })}</option>)}
              </NativeSelect>
            </div>
          }
        />
      )}
      <p className="mt-2 flex items-center gap-1.5 text-xs text-fg-subtle"><ArrowLeftRight className="size-3.5" aria-hidden />{t('stock.rowHint')}</p>

      {drawer && <ItemStockDrawer itemId={drawer.item.id} itemName={drawer.item.name} onClose={() => setDrawer(null)} />}
      {block && <BlockDialog row={block} onClose={() => setBlock(null)} onDone={() => { setBlock(null); setBump(b => b + 1); }} />}
      {snapshot && <SnapshotDialog defaultNode={node} onClose={() => setSnapshot(false)} />}
    </PageBody>
  );
}

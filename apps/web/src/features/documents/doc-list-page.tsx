'use client';
import type { DataField, DocListRow, DocTypeSummary, ItemListRow, SavedViewRow } from '@procure/schema';
import {
  Button, cn, DataTable, EmptyState, Input, NativeSelect, Segmented, Skeleton, type DataTableColumn,
} from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, Clock, FileStack, FileX2, Lock, Plus, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PageSkeleton } from '@/components/guards';
import { PageBody, PageHeader } from '@/components/page';
import { Combobox, type ComboOption } from '@/engines/form-renderer/combobox';
import { isDataField } from '@/engines/form-renderer/formula';
import { fetchOptions } from '@/engines/form-renderer/lookup-api';
import { useRenderableForm } from '@/engines/form-renderer/render-api';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { formatDecimal } from '@/engines/form-renderer/values';
import { locationKeys, locationsApi } from '@/features/locations/api';
import { t } from '@/i18n';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useCurrentLocationId } from '@/lib/location';
import { usePermissions } from '@/lib/permissions';
import { useTenantPrincipal } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { docKeys, docsApi, docTab, useDocType, type DocListFilters, type ListView } from './api';
import { lineColumns } from './form-model';
import { SavedViewsMenu, useSavedViews, type SavedConfig } from './saved-views';
import { DocStatusBadge, PendingPill, QtyCell } from './status';
import { docExtension, docListActions } from './extensions';
import './extensions-installed';

const NUMERIC = new Set(['number', 'decimal', 'currency', 'percentage']);
const SORTABLE = new Set(['number', 'doc_date', 'total_amount', 'created_at', 'submitted_at', 'required_by', 'line_no', 'required_date', 'status', 'item', 'qty']);
const FILTER_KEYS = ['view', 'status', 'q', 'location', 'from', 'to', 'item', 'sort'] as const;

export function DocListPage({ type }: { type: string }) {
  const { docType, isLoading } = useDocType(type);
  const p = usePermissions();
  if (isLoading || !p.ready) return <PageBody><PageSkeleton rows={8} /></PageBody>;
  if (!docType) return <PageBody><EmptyState icon={<FileX2 />} title={t('docs.typeNotFound')} action={<Button asChild variant="secondary"><Link href="/dashboard">{t('masters.goHome')}</Link></Button>} /></PageBody>;
  if (!p.can(docTab(type), 'view')) return <PageBody><EmptyState icon={<Lock />} title={t('guard.noAccess.title')} description={t('guard.noAccess.body')} /></PageBody>;
  return <DocList key={type} docType={docType} />;
}

function readFilters(sp: URLSearchParams): DocListFilters {
  const view = sp.get('view') === 'item' ? 'item' : 'document';
  const f: DocListFilters = { view };
  for (const k of FILTER_KEYS) if (k !== 'view') { const v = sp.get(k); if (v) (f as unknown as Record<string, string>)[k] = v; }
  return f;
}

function DocList({ docType }: { docType: DocTypeSummary }) {
  const type = docType.key;
  const tab = docTab(type);
  const p = usePermissions();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const me = useTenantPrincipal();
  const switcherLocation = useCurrentLocationId(me?.userId);
  const { currency } = useTenantLocale();
  const scopeKey = `doc.${type}`;

  const urlFilters = useMemo(() => readFilters(new URLSearchParams(sp.toString())), [sp]);
  const savedId = sp.get('sv');
  const itemWise = docType.settings.itemWiseView !== false && !!docType.lineFormKey;
  const filters: DocListFilters = useMemo(() => ({
    ...urlFilters,
    view: itemWise ? urlFilters.view : 'document',
    // The top-bar location is the default scope; `location=all` in the URL opts out.
    location: urlFilters.location ?? switcherLocation ?? undefined,
    savedView: savedId ?? undefined,
  }), [urlFilters, switcherLocation, itemWise, savedId]);

  const setParams = useCallback((patch: Record<string, string | null | undefined>, opts: { keepSaved?: boolean } = {}) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined || v === '') next.delete(k); else next.set(k, v); }
    if (!opts.keepSaved && !('sv' in patch)) next.delete('sv');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [sp, router, pathname]);

  // Default saved view: applied once when the URL carries no list state.
  const views = useSavedViews(scopeKey);
  const appliedDefault = useRef(false);
  const [columnsVersion, setColumnsVersion] = useState(0);
  const storageKey = `docs:${type}:${filters.view}`;

  const applyView = useCallback((v: SavedViewRow | null) => {
    const patch: Record<string, string | null> = Object.fromEntries(FILTER_KEYS.map(k => [k, null]));
    patch.sv = v?.id ?? null;
    if (v) {
      for (const [k, val] of Object.entries(v.config.filters ?? {})) if (typeof val === 'string' && (FILTER_KEYS as readonly string[]).includes(k)) patch[k] = val;
      if (v.config.sort) patch.sort = v.config.sort;
      if (v.config.columns?.length) {
        const view = (v.config.filters?.view as ListView | undefined) ?? 'document';
        try {
          window.localStorage.setItem(`dt:docs:${type}:${view}`, JSON.stringify({ __saved: v.config.columns }));
        } catch { /* storage blocked: columns stay as they are */ }
        setColumnsVersion(x => x + 1);
      }
    }
    setParams(patch, { keepSaved: true });
  }, [setParams, type]);

  useEffect(() => {
    if (appliedDefault.current || !views.data) return;
    appliedDefault.current = true;
    if ([...sp.keys()].length) return;
    const def = views.data.find(v => v.isDefault && v.isMine) ?? views.data.find(v => v.isDefault);
    if (def) applyView(def);
  }, [views.data, sp, applyView]);

  // ---------------------------------------------------------------- columns
  const headerForm = useRenderableForm(docType.headerFormKey);
  const lineForm = useRenderableForm(docType.lineFormKey, null, !!docType.lineFormKey);
  const headerCustom = useMemo(() => (headerForm.data?.definition.fields ?? []).filter((f): f is DataField => isDataField(f) && !f.system && !f.removed && !f.hidden && f.type !== 'grid'), [headerForm.data]);
  const lineCustom = useMemo(() => lineColumns(lineForm.data).filter(c => !c.system && !c.hidden), [lineForm.data]);

  const sortHeader = useCallback((id: string, label: string, align?: 'right') => {
    if (!SORTABLE.has(id)) return label;
    const cur = filters.sort;
    const dir = cur === id ? 'asc' : cur === `-${id}` ? 'desc' : null;
    const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
    return (
      <button type="button" onClick={() => setParams({ sort: dir === null ? id : dir === 'asc' ? `-${id}` : null })}
        className={cn('inline-flex items-center gap-1 rounded hover:text-fg focus-visible:outline-2 focus-visible:outline-ring', align === 'right' && 'flex-row-reverse', dir && 'text-fg')}
        aria-label={t('docs.list.sortBy', { col: label })} data-testid={`sort-${id}`}>
        {label}<Icon className={cn('size-3.5', !dir && 'opacity-40')} aria-hidden />
      </button>
    );
  }, [filters.sort, setParams]);

  // QA3-BUG-016: aria-sort belongs on the column header cell (role="columnheader"), not on the sort button.
  const withSort = useCallback(<T,>(cols: DataTableColumn<T>[]): DataTableColumn<T>[] => cols.map(c => {
    const cur = filters.sort;
    return cur === c.id ? { ...c, ariaSort: 'ascending' } : cur === `-${c.id}` ? { ...c, ariaSort: 'descending' } : c;
  }), [filters.sort]);

  const docColumns = useMemo<DataTableColumn<DocListRow>[]>(() => {
    const show = new Set(docType.settings.documentColumns);
    const col = (c: DataTableColumn<DocListRow>): DataTableColumn<DocListRow> => ({ ...c, defaultHidden: !show.has(c.id) && !c.alwaysVisible });
    const cols: DataTableColumn<DocListRow>[] = [
      col({ id: 'number', label: docType.settings.numberLabel || t('docs.col.number'), header: () => sortHeader('number', docType.settings.numberLabel || t('docs.col.number')), width: 190, alwaysVisible: true,
        cell: ({ row: { original: r } }) => (
          <Link href={`/docs/${type}/${r.id}`} onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1.5 font-medium text-fg hover:text-accent hover:underline" data-testid={`doc-row-${r.number ?? r.id}`}>
            {r.number ?? <span className="font-normal italic text-fg-subtle">{t('docs.draft')}</span>}
            {r.overdue && <Clock className="size-3.5 text-danger" aria-label={t('docs.overdue')} />}
          </Link>
        ) }),
      col({ id: 'doc_date', label: t('docs.col.date'), header: () => sortHeader('doc_date', t('docs.col.date')), width: 120, cell: ({ row }) => fmtDate(row.original.docDate) }),
      col({ id: 'location', label: t('docs.col.location'), header: t('docs.col.location'), width: 160, cell: ({ row }) => row.original.location?.name ?? '—' }),
      col({ id: 'status', label: t('docs.col.status'), header: () => sortHeader('status', t('docs.col.status')), width: 230, cell: ({ row }) => <DocStatusBadge statusKey={row.original.statusKey} label={row.original.statusLabel} docType={docType} /> }),
      col({ id: 'total_amount', label: t('docs.col.total'), header: () => sortHeader('total_amount', t('docs.col.total'), 'right'), width: 140, align: 'right',
        cell: ({ row }) => row.original.totalAmount ? formatDecimal(row.original.totalAmount, 2, { currency }) : '—' }),
      col({ id: 'line_count', label: t('docs.col.lines'), header: t('docs.col.lines'), width: 80, align: 'right', cell: ({ row }) => row.original.lineCount }),
      col({ id: 'created_by', label: t('docs.col.createdBy'), header: t('docs.col.createdBy'), width: 150, cell: ({ row }) => row.original.createdBy ?? '—' }),
      col({ id: 'created_at', label: t('docs.col.createdAt'), header: () => sortHeader('created_at', t('docs.col.createdAt')), width: 170, cell: ({ row }) => fmtDateTime(row.original.createdAt) }),
      col({ id: 'submitted_at', label: t('docs.col.submittedAt'), header: () => sortHeader('submitted_at', t('docs.col.submittedAt')), width: 170, cell: ({ row }) => fmtDateTime(row.original.submittedAt) }),
    ];
    for (const f of headerCustom) {
      if (cols.some(c => c.id === f.key)) continue;
      cols.push(col({ id: f.key, label: f.label, header: f.label, width: NUMERIC.has(f.type) ? 130 : 180, align: NUMERIC.has(f.type) ? 'right' : undefined, cell: ({ row }) => cellText(f, row.original.columns?.[f.key], currency) }));
    }
    return withSort(cols);
  }, [docType, headerCustom, currency, sortHeader, withSort, type]);

  const itemColumns = useMemo<DataTableColumn<ItemListRow>[]>(() => {
    // The quantity buckets are what the item-wise view is for: requested/approved/held/rejected show by default.
    const show = new Set([...docType.settings.itemColumns, 'qty', 'approved', 'held', 'rejected']);
    const col = (c: DataTableColumn<ItemListRow>): DataTableColumn<ItemListRow> => ({ ...c, defaultHidden: !show.has(c.id) && !c.alwaysVisible });
    const q = (id: string, label: string, bucket: keyof ItemListRow['qty'], tone?: 'success' | 'warning' | 'danger') =>
      col({ id, label, header: label, width: 96, align: 'right', cell: ({ row }) => <QtyCell value={row.original.qty[bucket]} tone={tone} testId={`qty-${bucket}-${row.original.number ?? row.original.documentId}-${row.original.lineNo}`} /> });
    const cols: DataTableColumn<ItemListRow>[] = [
      col({ id: 'number', label: docType.settings.numberLabel || t('docs.col.number'), header: () => sortHeader('number', docType.settings.numberLabel || t('docs.col.number')), width: 200, alwaysVisible: true,
        cell: ({ row: { original: r } }) => (
          <Link href={`/docs/${type}/${r.documentId}#line-${r.lineNo}`} onClick={e => e.stopPropagation()} className="font-medium hover:text-accent hover:underline" data-testid={`doc-row-${r.number ?? r.documentId}-${r.lineNo}`}>
            {r.number ?? <span className="font-normal italic text-fg-subtle">{t('docs.draft')}</span>}
          </Link>
        ) }),
      col({ id: 'line_no', label: t('docs.col.lineNo'), header: () => sortHeader('line_no', '#', 'right'), width: 56, align: 'right', cell: ({ row }) => <span className="text-fg-muted">{row.original.lineNo}</span> }),
      col({ id: 'item', label: t('docs.col.item'), header: () => sortHeader('item', t('docs.col.item')), width: 240, cell: ({ row }) => row.original.item ? <span className="truncate"><span className="text-fg-muted">{row.original.item.code}</span> {row.original.item.name}</span> : '—' }),
      col({ id: 'uom', label: t('docs.col.uom'), header: t('docs.col.uom'), width: 70, cell: ({ row }) => row.original.uom ?? '—' }),
      { ...q('qty', t('docs.qty.requested'), 'requested'), header: () => sortHeader('qty', t('docs.qty.requested'), 'right') },
      q('approved', t('docs.qty.approved'), 'approved', 'success'),
      q('held', t('docs.qty.held'), 'held', 'warning'),
      q('rejected', t('docs.qty.rejected'), 'rejected', 'danger'),
      q('cancelled', t('docs.qty.cancelled'), 'cancelled'),
      col({ id: 'pending_approval', label: t('docs.qty.pending'), header: t('docs.qty.pending'), width: 104, align: 'right',
        cell: ({ row }) => <PendingPill value={row.original.qty.pendingApproval} testId={`qty-pending-${row.original.number ?? row.original.documentId}-${row.original.lineNo}`} /> }),
      col({ id: 'status', label: t('docs.col.status'), header: t('docs.col.status'), width: 190, cell: ({ row }) => <DocStatusBadge statusKey={row.original.statusKey} label={row.original.statusLabel} docType={docType} /> }),
      col({ id: 'location', label: t('docs.col.location'), header: t('docs.col.location'), width: 150, cell: ({ row }) => row.original.location?.name ?? '—' }),
      col({ id: 'required_date', label: t('docs.col.requiredDate'), header: () => sortHeader('required_date', t('docs.col.requiredDate')), width: 130, cell: ({ row }) => fmtDate(row.original.requiredDate) }),
    ];
    for (const x of docExtension(type).itemColumns(docType)) {
      cols.push({ id: x.id, label: x.label, header: x.label, width: x.width ?? 110, align: x.align, defaultHidden: !x.defaultVisible && !show.has(x.id), cell: ({ row }) => x.cell(row.original) });
    }
    for (const c of lineCustom) {
      if (cols.some(x => x.id === c.key)) continue;
      cols.push(col({ id: c.key, label: c.label, header: c.label, width: NUMERIC.has(c.type) ? 120 : 170, align: NUMERIC.has(c.type) ? 'right' : undefined, cell: ({ row }) => cellText(c, row.original.columns?.[c.key], currency) }));
    }
    return withSort(cols);
  }, [docType, lineCustom, currency, sortHeader, withSort, type]);

  // Saved-view columns are written as { __saved: [...] }; translate to a visibility map before the table mounts.
  const allIds = (filters.view === 'item' ? itemColumns : docColumns).map(c => c.id);
  materializeSavedColumns(`dt:${storageKey}`, allIds);

  // ---------------------------------------------------------------- data
  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const page = await docsApi.list(type, filters, cursor, 50);
      return page as { data: never[]; nextCursor: string | null };
    },
    [type, filters],
  );
  const counts = useQuery({ queryKey: docKeys.counts(type, filters), queryFn: () => docsApi.counts(type, filters), staleTime: 15_000 });
  const permittedCounts = (counts.data ?? []).filter(c => p.has(`${tab}:view.${c.statusKey}`) || !p.fromServer);
  const totalCount = permittedCounts.reduce((s, c) => s + c.count, 0);

  const currentConfig = useCallback((): SavedConfig => {
    let columns: string[] | undefined;
    try {
      const vis = JSON.parse(window.localStorage.getItem(`dt:${storageKey}`) ?? 'null') as Record<string, boolean> | null;
      const all = (filters.view === 'item' ? itemColumns : docColumns);
      columns = all.filter(c => (vis && c.id in vis ? vis[c.id] : !c.defaultHidden)).map(c => c.id);
    } catch { columns = undefined; }
    const f: Record<string, string> = {};
    for (const k of FILTER_KEYS) { const v = urlFilters[k as keyof DocListFilters]; if (v && k !== 'sort') f[k] = String(v); }
    return { filters: f, sort: urlFilters.sort, columns };
  }, [storageKey, filters.view, itemColumns, docColumns, urlFilters]);

  const canAdd = p.can(tab, 'add');
  const queryKey = JSON.stringify(filters);
  const hasFilters = !!(urlFilters.q || urlFilters.from || urlFilters.to || urlFilters.item || urlFilters.status || urlFilters.location);

  const labels = { caption: docType.pluralName, columns: t('table.columns'), loadMore: t('table.loadMore'), error: t('table.error'), retry: t('common.retry'), loading: t('common.loading') };
  const empty = (
    <EmptyState
      icon={<FileStack />}
      title={hasFilters ? t('docs.list.emptyFiltered') : t('docs.list.empty', { name: docType.pluralName.toLowerCase() })}
      description={hasFilters ? t('docs.list.emptyFilteredHint') : canAdd ? t('docs.list.emptyHint', { name: docType.name.toLowerCase() }) : undefined}
      action={hasFilters
        ? <Button variant="secondary" onClick={() => applyView(null)}>{t('docs.list.clearFilters')}</Button>
        : canAdd && <Button asChild variant="secondary"><Link href={`/docs/${type}/new`}><Plus aria-hidden />{t('docs.list.new', { name: docType.name })}</Link></Button>}
    />
  );

  return (
    <PageBody>
      <PageHeader
        title={docType.pluralName}
        description={docType.description ?? undefined}
        actions={
          <>
            {itemWise && (
              <Segmented<ListView> label={t('docs.list.viewLabel')} value={filters.view} onChange={v => setParams({ view: v === 'document' ? null : v, sort: null })} size="md" data-testid="doc-view"
                options={[{ value: 'document', label: t('docs.list.documentWise') }, { value: 'item', label: t('docs.list.itemWise') }]} />
            )}
            {docListActions(docType)}
            {canAdd && <Button asChild><Link href={`/docs/${type}/new`} data-testid="doc-new"><Plus aria-hidden />{t('docs.list.new', { name: docType.name })}</Link></Button>}
          </>
        }
      />

      <div role="group" aria-label={t('docs.list.statusFilter')} className="mb-3 flex gap-1.5 overflow-x-auto pb-1" data-testid="doc-status-chips">
        {counts.isLoading ? (
          [0, 1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-28 rounded-full" />)
        ) : (
          <>
            <StatusChip label={t('docs.list.allStatuses')} count={totalCount} on={!filters.status} onClick={() => setParams({ status: null })} testId="doc-status-all" />
            {permittedCounts.map(c => (
              <StatusChip key={c.statusKey} label={c.label} count={c.count} on={filters.status === c.statusKey} onClick={() => setParams({ status: filters.status === c.statusKey ? null : c.statusKey })} testId={`doc-status-${c.statusKey}`} />
            ))}
          </>
        )}
      </div>

      {headerForm.isLoading || lineForm.isLoading ? <PageSkeleton rows={8} /> : (
      <DataTable<DocListRow | ItemListRow>
        key={`${filters.view}:${columnsVersion}`}
        data-testid="doc-list"
        columns={(filters.view === 'item' ? itemColumns : docColumns) as DataTableColumn<DocListRow | ItemListRow>[]}
        fetchPage={fetchPage}
        queryKey={queryKey}
        getRowId={r => ('lineId' in r ? r.lineId : r.id)}
        onRowClick={r => router.push('lineId' in r ? `/docs/${type}/${r.documentId}#line-${r.lineNo}` : `/docs/${type}/${r.id}`)}
        storageKey={storageKey}
        rowHeight={filters.view === 'item' ? 44 : 48}
        labels={labels}
        empty={empty}
        toolbar={
          <ListFilters
            filters={filters}
            urlFilters={urlFilters}
            setParams={setParams}
            itemFilter={!!docType.lineFormKey}
            savedViews={<SavedViewsMenu scopeKey={scopeKey} activeId={savedId} current={currentConfig} onApply={applyView} />}
          />
        }
      />
      )}
    </PageBody>
  );
}

/** Currency-typed fields format with their own (else the tenant's) currency, e.g. ₹24,392.00; others as display(). */
function cellText(f: { type: string }, v: unknown, currency: string): string {
  if (f.type === 'currency' && (typeof v === 'string' || typeof v === 'number') && v !== '' && Number.isFinite(Number(v))) {
    const c = f as { precision?: number; currency?: string };
    return formatDecimal(v, c.precision ?? 2, { currency: c.currency ?? currency });
  }
  return display(v);
}

function display(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? t('docs.yes') : t('docs.no');
  return String(v);
}

/** Turn a saved view's column list into DataTable's visibility map (before DataTable reads it on mount). */
function materializeSavedColumns(key: string, all: string[]) {
  if (typeof window === 'undefined') return;
  try {
    const raw = JSON.parse(window.localStorage.getItem(key) ?? 'null') as { __saved?: string[] } | null;
    if (!raw?.__saved) return;
    const keep = new Set(raw.__saved);
    window.localStorage.setItem(key, JSON.stringify(Object.fromEntries(all.map(id => [id, keep.has(id)]))));
  } catch { /* ignore */ }
}

function StatusChip({ label, count, on, onClick, testId }: { label: string; count: number; on: boolean; onClick: () => void; testId: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} data-testid={testId} data-count={count}
      className={cn('inline-flex h-8 shrink-0 items-center gap-2 rounded-full border pl-3 pr-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:bg-muted hover:text-fg')}>
      {label}
      <span className={cn('min-w-6 rounded-full px-1.5 text-center text-xs tabular-nums', on ? 'bg-accent text-accent-fg' : 'bg-muted text-fg-muted')}>{count}</span>
    </button>
  );
}

function ListFilters({ filters, urlFilters, setParams, itemFilter, savedViews }: {
  filters: DocListFilters;
  urlFilters: DocListFilters;
  setParams: (patch: Record<string, string | null | undefined>) => void;
  itemFilter: boolean;
  savedViews: ReactNode;
}) {
  const [q, setQ] = useState(urlFilters.q ?? '');
  const dq = useDebounced(q, 300);
  useEffect(() => { if ((urlFilters.q ?? '') !== dq) setParams({ q: dq || null }); }, [dq]);
  useEffect(() => { setQ(urlFilters.q ?? ''); }, [urlFilters.q]);

  const locations = useQuery({ queryKey: locationKeys.mine, queryFn: () => locationsApi.tree({ scope: 'mine', view: 'active' }), staleTime: 5 * 60_000, retry: false });

  const [itemQ, setItemQ] = useState('');
  const dItemQ = useDebounced(itemQ, 250);
  const [itemOpen, setItemOpen] = useState(false);
  const items = useQuery({
    queryKey: ['item-options', dItemQ],
    queryFn: ({ signal }) => fetchOptions({ kind: 'master', masterKey: 'item' }, { q: dItemQ, limit: 20, signal }),
    enabled: itemFilter && itemOpen,
    staleTime: 60_000,
  });
  const [itemLabel, setItemLabel] = useState<ComboOption | null>(null);
  const itemOptions: ComboOption[] = (items.data ?? []).map(o => ({ value: o.id, label: o.name, secondary: o.code }));
  const selectedItem = urlFilters.item ? [itemLabel?.value === urlFilters.item ? itemLabel : { value: urlFilters.item, label: t('docs.filter.itemSelected') }] : [];

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-56">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('docs.filter.search')} aria-label={t('docs.filter.searchLabel')} className="h-8 pl-8" data-testid="doc-search" />
      </div>
      <NativeSelect aria-label={t('docs.filter.location')} className="h-8 w-full sm:w-48" value={filters.location ?? 'all'} onChange={e => setParams({ location: e.target.value })} data-testid="doc-filter-location">
        <option value="all">{t('topbar.allLocations')}</option>
        {(locations.data ?? []).map(n => <option key={n.id} value={n.id}>{`${'  '.repeat(Math.max(0, n.depth - 1))}${n.name}`}</option>)}
      </NativeSelect>
      <div className="flex w-full items-center gap-1 sm:w-auto">
        <Input type="date" value={urlFilters.from ?? ''} onChange={e => setParams({ from: e.target.value || null })} aria-label={t('docs.filter.from')} className="h-8 min-w-0 flex-1 sm:w-[9.5rem] sm:flex-none" data-testid="doc-filter-from" />
        <span className="text-fg-subtle" aria-hidden>–</span>
        <Input type="date" value={urlFilters.to ?? ''} onChange={e => setParams({ to: e.target.value || null })} aria-label={t('docs.filter.to')} className="h-8 min-w-0 flex-1 sm:w-[9.5rem] sm:flex-none" data-testid="doc-filter-to" />
      </div>
      {itemFilter && (
        <div className="w-full sm:w-52">
          <Combobox
            options={itemOptions}
            selected={selectedItem}
            onSelect={o => { setItemLabel(o); setParams({ item: o.value }); }}
            onRemove={() => setParams({ item: null })}
            onClear={() => setParams({ item: null })}
            query={itemQ}
            onQueryChange={setItemQ}
            onOpenChange={setItemOpen}
            loading={items.isFetching}
            placeholder={t('docs.filter.item')}
            aria-label={t('docs.filter.item')}
            compact
            testId="doc-filter-item"
          />
        </div>
      )}
      {(urlFilters.from || urlFilters.to || urlFilters.item || urlFilters.q) && (
        <Button variant="ghost" size="sm" onClick={() => setParams({ q: null, from: null, to: null, item: null })} data-testid="doc-filter-clear"><X aria-hidden />{t('docs.list.clearFilters')}</Button>
      )}
      <div className="ml-auto">{savedViews}</div>
    </div>
  );
}

'use client';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Columns3 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { EmptyState } from './empty-state';
import { Skeleton } from './skeleton';

export interface DataPage<T> { data: T[]; nextCursor: string | null }

export type DataTableColumn<T> = ColumnDef<T, unknown> & {
  id: string;
  /** Text for the column chooser; defaults to the string header. */
  label?: string;
  /** Fixed/min width in px (rows are CSS grid so header and body align). */
  width?: number;
  /** Hidden by default; user can show via the column chooser. */
  defaultHidden?: boolean;
  /** Cannot be hidden. */
  alwaysVisible?: boolean;
  align?: 'left' | 'right';
  /** Sort state of a sortable column, rendered as `aria-sort` on its column header (not on a control inside it). */
  ariaSort?: 'ascending' | 'descending' | 'none';
};

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  /** Server-side cursor pagination. Called with null for the first page. */
  fetchPage: (cursor: string | null) => Promise<DataPage<T>>;
  /** Change this to reset and refetch (e.g. search text, filter, mutation counter). */
  queryKey: string;
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowHeight?: number;
  /** Max visible height of the scroll area; rows virtualise inside it. */
  height?: string;
  empty?: ReactNode;
  toolbar?: ReactNode;
  /** Persist column visibility under this key (localStorage). */
  storageKey?: string;
  labels?: Partial<{ columns: string; loading: string; loadMore: string; error: string; retry: string; empty: string; caption: string }>;
  className?: string;
  'data-testid'?: string;
}

const defaultLabels = {
  columns: 'Columns', loading: 'Loading', loadMore: 'Load more', error: 'Could not load data.', retry: 'Try again', empty: 'Nothing here yet', caption: 'Table',
};

function readVisibility(key: string | undefined): VisibilityState | null {
  if (!key || typeof window === 'undefined') return null;
  try { return JSON.parse(window.localStorage.getItem(`dt:${key}`) ?? 'null') as VisibilityState | null; } catch { return null; }
}

/**
 * Virtualised data table with server-side cursor pagination.
 * Header is sticky, rows render in a CSS grid (so the header stays aligned while virtualised),
 * pages load automatically as you scroll near the end and via an explicit "Load more" button.
 */
export function DataTable<T>({
  columns, fetchPage, queryKey, getRowId, onRowClick, rowHeight = 48, height = 'calc(100dvh - 15rem)', empty, toolbar, storageKey, labels: labelsIn, className, ...rest
}: DataTableProps<T>) {
  const labels = { ...defaultLabels, ...labelsIn };
  const [rows, setRows] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('loading');
  const [initial, setInitial] = useState(true);
  const reqId = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const [visibility, setVisibility] = useState<VisibilityState>(() => {
    const stored = readVisibility(storageKey);
    if (stored) return stored;
    return Object.fromEntries(columns.filter(c => c.defaultHidden).map(c => [c.id, false]));
  });
  useEffect(() => {
    if (!storageKey) return;
    try { window.localStorage.setItem(`dt:${storageKey}`, JSON.stringify(visibility)); } catch { /* storage unavailable */ }
  }, [visibility, storageKey]);

  const load = useCallback(async (from: string | null, reset: boolean) => {
    const id = ++reqId.current;
    setStatus('loading');
    try {
      const page = await fetchRef.current(from);
      if (id !== reqId.current) return;
      setRows(prev => (reset ? page.data : [...prev, ...page.data]));
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
      setStatus('idle');
    } catch {
      if (id !== reqId.current) return;
      setStatus('error');
    } finally {
      if (id === reqId.current) setInitial(false);
    }
  }, []);

  useEffect(() => {
    setInitial(true);
    setRows([]);
    setCursor(null);
    setHasMore(true);
    void load(null, true);
  }, [queryKey, load]);

  const loadMore = useCallback(() => {
    if (status === 'loading' || !hasMore) return;
    void load(cursor, false);
  }, [status, hasMore, cursor, load]);

  const table = useReactTable({
    data: rows,
    columns,
    getRowId: r => getRowId(r),
    getCoreRowModel: getCoreRowModel(),
    state: { columnVisibility: visibility },
    onColumnVisibilityChange: setVisibility,
  });

  const visibleCols = table.getVisibleLeafColumns();
  const template = useMemo(
    () => visibleCols.map(c => {
      const w = (c.columnDef as DataTableColumn<T>).width;
      return w ? `minmax(${w}px, ${w >= 200 ? '2fr' : '1fr'})` : 'minmax(140px, 1fr)';
    }).join(' '),
    [visibleCols],
  );
  const minWidth = visibleCols.reduce((s, c) => s + ((c.columnDef as DataTableColumn<T>).width ?? 140), 0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });
  const vItems = virtualizer.getVirtualItems();

  // Infinite scroll: fetch next page when the last rendered row is near the end.
  const last = vItems[vItems.length - 1];
  useEffect(() => {
    if (last && last.index >= tableRows.length - 5 && hasMore && status === 'idle') loadMore();
  }, [last, tableRows.length, hasMore, status, loadMore]);

  const showSkeleton = initial && status === 'loading';
  const isEmpty = !initial && status !== 'error' && rows.length === 0;

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-surface', className)} data-testid={rest['data-testid']}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" data-testid="datatable-columns"><Columns3 aria-hidden />{labels.columns}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{labels.columns}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {table.getAllLeafColumns().map(col => {
              const def = col.columnDef as DataTableColumn<T>;
              if (def.alwaysVisible) return null;
              return (
                <DropdownMenuCheckboxItem key={col.id} checked={col.getIsVisible()} onCheckedChange={v => col.toggleVisibility(!!v)} onSelect={e => e.preventDefault()}>
                  {def.label ?? (typeof def.header === 'string' ? def.header : col.id)}
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div ref={scrollRef} tabIndex={0} className="relative overflow-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" style={{ maxHeight: height }}>{/* A11Y8-003: keyboard-scrollable */}
        <div role="table" aria-label={labels.caption} aria-rowcount={hasMore ? -1 : rows.length + 1} aria-busy={status === 'loading'} style={{ minWidth }}>
          <div role="rowgroup" className="sticky top-0 z-10 border-b border-border bg-subtle">
            {table.getHeaderGroups().map(hg => (
              <div role="row" key={hg.id} className="grid" style={{ gridTemplateColumns: template }}>
                {hg.headers.map(h => (
                  <div role="columnheader" key={h.id} aria-sort={(h.column.columnDef as DataTableColumn<T>).ariaSort} className={cn('flex h-9 items-center px-3 text-sm font-medium text-fg-muted', (h.column.columnDef as DataTableColumn<T>).align === 'right' && 'justify-end')}>
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {showSkeleton ? (
            <div role="rowgroup" aria-label={labels.loading}>
              {Array.from({ length: 8 }, (_, i) => (
                <div role="row" key={i} className="grid items-center border-b border-border" style={{ gridTemplateColumns: template, height: rowHeight }}>
                  {visibleCols.map((c, j) => (
                    <div role="cell" key={c.id} className="px-3"><Skeleton className={cn('h-4', j === 0 ? 'w-3/4' : 'w-1/2')} /></div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {vItems.map(vi => {
                const row = tableRows[vi.index]!;
                const clickable = !!onRowClick;
                return (
                  <div
                    role="row"
                    key={row.id}
                    data-index={vi.index}
                    aria-rowindex={vi.index + 2}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => onRowClick(row.original) : undefined}
                    onKeyDown={clickable ? e => { if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row.original); } : undefined}
                    className={cn('absolute inset-x-0 grid items-center border-b border-border', clickable && 'cursor-pointer hover:bg-subtle focus-visible:bg-accent-soft focus-visible:outline-none')}
                    style={{ gridTemplateColumns: template, height: rowHeight, transform: `translateY(${vi.start}px)` }}
                  >
                    {row.getVisibleCells().map(cell => (
                      <div role="cell" key={cell.id} className={cn('min-w-0 truncate px-3', (cell.column.columnDef as DataTableColumn<T>).align === 'right' && 'text-right tabular')}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {isEmpty && (empty ?? <EmptyState title={labels.empty} />)}
        {status === 'error' && (
          <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-fg-muted">{labels.error}</p>
            <Button variant="secondary" size="sm" onClick={() => void load(rows.length ? cursor : null, rows.length === 0)}>{labels.retry}</Button>
          </div>
        )}
        {!initial && status === 'loading' && rows.length > 0 && (
          <div className="flex items-center gap-2 border-t border-border px-3" style={{ height: rowHeight }} aria-hidden>
            <Skeleton className="h-4 w-1/3" />
          </div>
        )}
      </div>

      {hasMore && !initial && status === 'idle' && rows.length > 0 && (
        <div className="flex justify-center border-t border-border py-2">
          <Button variant="ghost" size="sm" onClick={loadMore}>{labels.loadMore}</Button>
        </div>
      )}
    </div>
  );
}

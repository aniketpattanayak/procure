'use client';
import { cn, EmptyState, Skeleton, useVirtualizer } from '@procure/ui';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { ChevronDown, ChevronRight, Table2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { t } from '@/i18n';
import { effectiveFormat, formatValue, isNumericType, toNumber } from './format';
import type { ReportDefinition, ReportResult } from './types';

type Col = ReportResult['columns'][number] & { fmt: ReturnType<typeof effectiveFormat>; numeric: boolean; width: number };

type Item =
  | { kind: 'group'; id: string; label: string; count: number; totals: unknown[]; open: boolean }
  | { kind: 'row'; id: string; cells: unknown[]; link: string | null; inGroup: boolean };

const ROW_H = 40;

function defaultWidth(c: ReportResult['columns'][number]) {
  if (c.type === 'date') return 120;
  if (c.type === 'datetime') return 170;
  if (isNumericType(c.type, c.aggregate)) return 140;
  if (c.type === 'boolean') return 96;
  return 200;
}

/** Subtotal of one column over rows, when it can be derived exactly (sum/count/min/max). */
function subtotal(rows: unknown[][], i: number, aggregate: string): unknown {
  const nums = rows.map(r => toNumber(r[i])).filter((n): n is number => n !== null);
  if (!nums.length) return null;
  if (aggregate === 'sum' || aggregate === 'count') return nums.reduce((a, b) => a + b, 0);
  if (aggregate === 'min') return Math.min(...nums);
  if (aggregate === 'max') return Math.max(...nums);
  return null;
}

/**
 * Report results: virtualised rows, grouped by the first group-by field when there are two or more (collapsible
 * header rows with subtotals), a sticky totals row, and drill-down links to documents.
 */
export function ResultsTable({ result, def, loading, height = 'min(calc(100dvh - 22rem), 640px)', className, caption, dim }: {
  result: ReportResult | undefined; def: Pick<ReportDefinition, 'columns' | 'groupBy'>; loading?: boolean; height?: string; className?: string; caption: string; dim?: boolean;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const cols: Col[] = useMemo(() => (result?.columns ?? []).map((c, i) => {
    const d = def.columns.find(x => x.field === c.field) ?? def.columns[i];
    return { ...c, fmt: effectiveFormat(d?.format, c.type, c.aggregate), numeric: isNumericType(c.type, c.aggregate), width: d?.width ?? defaultWidth(c) };
  }), [result?.columns, def.columns]);

  const groupField = (def.groupBy ?? []).length >= 2 ? def.groupBy![0] : undefined;
  const gi = groupField ? cols.findIndex(c => c.field === groupField) : -1;

  const items: Item[] = useMemo(() => {
    if (!result) return [];
    const links = result.links ?? [];
    if (gi < 0) return result.rows.map((cells, i) => ({ kind: 'row', id: `r${i}`, cells, link: links[i] ?? null, inGroup: false }));
    const order: string[] = [];
    const buckets = new Map<string, { raw: unknown; rows: { cells: unknown[]; i: number }[] }>();
    result.rows.forEach((cells, i) => {
      const k = JSON.stringify(cells[gi] ?? null);
      if (!buckets.has(k)) { buckets.set(k, { raw: cells[gi], rows: [] }); order.push(k); }
      buckets.get(k)!.rows.push({ cells, i });
    });
    const out: Item[] = [];
    for (const k of order) {
      const b = buckets.get(k)!;
      const server = result.groups?.find(g => JSON.stringify(g.key?.[0] ?? null) === k);
      const totals = cols.map((c, ci) => (ci === gi ? null : server?.totals?.[ci] ?? (c.aggregate !== 'none' ? subtotal(b.rows.map(r => r.cells), ci, c.aggregate) : null)));
      const open = !closed.has(k);
      out.push({ kind: 'group', id: k, label: formatValue(b.raw, cols[gi]!.fmt), count: server?.rowCount ?? b.rows.length, totals, open });
      if (open) for (const r of b.rows) out.push({ kind: 'row', id: `r${r.i}`, cells: r.cells, link: links[r.i] ?? null, inGroup: true });
    }
    return out;
  }, [result, gi, cols, closed]);

  // Display columns: the grouped column is shown in its header rows only.
  const shown = useMemo(() => cols.map((c, ci) => ({ c, ci })).filter(x => x.ci !== gi), [cols, gi]);
  const columns = useMemo<ColumnDef<Item>[]>(() => shown.map(({ c, ci }, di) => ({
    id: `${c.field}:${ci}`,
    header: c.label,
    cell: ({ row }) => {
      const it = row.original;
      if (it.kind === 'group') {
        if (di === 0) {
          return (
            <span className="flex min-w-0 items-center gap-1.5 font-semibold">
              {it.open ? <ChevronDown className="size-4 shrink-0 text-fg-subtle" aria-hidden /> : <ChevronRight className="size-4 shrink-0 text-fg-subtle" aria-hidden />}
              <span className="truncate">{`${cols[gi]!.label}: ${it.label}`}</span>
              <span className="shrink-0 text-sm font-normal text-fg-subtle">({it.count})</span>
            </span>
          );
        }
        return <span className="font-semibold">{it.totals[ci] == null ? '' : formatValue(it.totals[ci], c.fmt)}</span>;
      }
      const text = formatValue(it.cells[ci], c.fmt);
      if (di === 0 && it.link) return <Link href={it.link} className="text-accent hover:underline" data-testid="report-drill">{text}</Link>;
      return text;
    },
  })), [shown, cols, gi]);

  const table = useReactTable({ data: items, columns, getCoreRowModel: getCoreRowModel(), getRowId: r => r.id });
  const tableRows = table.getRowModel().rows;
  const template = shown.map(({ c }) => `minmax(${Math.min(c.width, 160)}px, ${c.numeric ? '0.8fr' : '1fr'})`).join(' ');
  const minWidth = shown.reduce((a, { c }) => a + Math.min(c.width, 160), 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: tableRows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 10 });

  if (loading && !result) {
    return (
      <div className={cn('space-y-2 rounded-lg border border-border bg-surface p-4', className)} aria-busy="true" aria-label={t('common.loading')}>
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-6" />)}
      </div>
    );
  }
  if (!result) return null;
  if (result.rows.length === 0) {
    return <div className={cn('rounded-lg border border-border bg-surface', className)}><EmptyState icon={<Table2 />} title={t('report.empty.title')} description={t('report.empty.body')} /></div>;
  }

  const toggle = (k: string) => setClosed(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-surface transition-opacity', dim && 'opacity-60', className)} data-testid="report-table">
      <div ref={scrollRef} tabIndex={0} className="relative overflow-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" style={{ maxHeight: height }}>{/* A11Y8-003 */}
        <div role="table" aria-label={caption} aria-rowcount={items.length + 1 + (result.totals ? 1 : 0)} style={{ minWidth }}>
          <div role="rowgroup" className="sticky top-0 z-10 border-b border-border bg-subtle">
            {table.getHeaderGroups().map(hg => (
              <div role="row" key={hg.id} className="grid" style={{ gridTemplateColumns: template }}>
                {hg.headers.map((h, ci) => (
                  <div role="columnheader" key={h.id} className={cn('flex h-9 items-center px-3 text-sm font-medium text-fg-muted', shown[ci]?.c.numeric && 'justify-end text-right')}>
                    <span className="truncate">{flexRender(h.column.columnDef.header, h.getContext())}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map(vi => {
              const row = tableRows[vi.index]!;
              const it = row.original;
              const isGroup = it.kind === 'group';
              return (
                <div
                  role="row"
                  key={row.id}
                  aria-rowindex={vi.index + 2}
                  aria-expanded={isGroup ? it.open : undefined}
                  tabIndex={isGroup ? 0 : undefined}
                  onClick={isGroup ? () => toggle(it.id) : undefined}
                  onKeyDown={isGroup ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(it.id); } } : undefined}
                  data-testid={isGroup ? 'report-group-row' : 'report-row'}
                  className={cn('absolute inset-x-0 grid items-center border-b border-border',
                    isGroup ? 'cursor-pointer bg-subtle/60 hover:bg-muted focus-visible:bg-accent-soft focus-visible:outline-none' : 'hover:bg-subtle/60')}
                  style={{ gridTemplateColumns: template, height: ROW_H, transform: `translateY(${vi.start}px)` }}
                >
                  {row.getVisibleCells().map((cell, ci) => (
                    <div role={isGroup && ci === 0 ? 'rowheader' : 'cell'} key={cell.id}
                      className={cn('min-w-0 truncate px-3', shown[ci]?.c.numeric && 'text-right tabular-nums', !isGroup && it.kind === 'row' && it.inGroup && ci === 0 && 'pl-8')}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {result.totals && (
            <div role="rowgroup" className="sticky bottom-0 z-10 border-t-2 border-border-strong bg-subtle">
              <div role="row" className="grid items-center" style={{ gridTemplateColumns: template, height: ROW_H }} data-testid="report-totals">
                {shown.map(({ c, ci }, di) => (
                  <div role={di === 0 ? 'rowheader' : 'cell'} key={ci} className={cn('min-w-0 truncate px-3 font-semibold', c.numeric && 'text-right tabular-nums')}>
                    {di === 0 && (result.totals![ci] == null || !c.numeric) ? t('report.totals') : result.totals![ci] == null ? '' : formatValue(result.totals![ci], c.fmt)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {result.truncated && (
        <p className="border-t border-border bg-warning-soft px-3 py-2 text-sm text-warning" role="status" data-testid="report-truncated">{t('report.truncated', { n: result.rows.length })}</p>
      )}
    </div>
  );
}

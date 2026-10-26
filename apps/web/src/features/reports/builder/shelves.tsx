'use client';
import { useDroppable } from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@procure/ui';
import { ArrowDown, ArrowUp, Columns3, Filter, GripVertical, Rows3, SlidersHorizontal, X } from 'lucide-react';
import { t } from '@/i18n';
import type { CatalogueField, ReportDefinition } from '../types';
import { LIMITS, type Selection, type Shelf } from './model';

const shelfIcon = { columns: Columns3, groupBy: Rows3, filters: Filter, sort: SlidersHorizontal } as const;
const AGG_SHORT: Record<string, string> = { sum: 'Σ', avg: 'avg', min: 'min', max: 'max', count: '#', count_distinct: '#≠' };

export interface Chip { id: string; label: string; hint?: string; dir?: 'asc' | 'desc'; issue?: boolean; param?: boolean }

function SortableChip({ chip, shelf, index, selected, onSelect, onRemove, onToggleDir }: {
  chip: Chip; shelf: Shelf; index: number; selected: boolean; onSelect: () => void; onRemove: () => void; onToggleDir?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: chip.id, data: { kind: 'chip', shelf, index } });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex max-w-full items-center rounded border bg-surface text-sm shadow-sm',
        selected ? 'border-accent ring-1 ring-accent' : chip.issue ? 'border-danger/60' : 'border-border-strong', isDragging && 'z-10 opacity-60')}
      data-testid={`builder-chip-${shelf}-${index}`}
      data-selected={selected}
    >
      <button type="button" {...attributes} {...listeners} className="cursor-grab px-1 py-1.5 text-fg-subtle hover:text-fg active:cursor-grabbing" aria-label={t('builder.reorder', { field: chip.label })}>
        <GripVertical className="size-3.5" aria-hidden />
      </button>
      <button type="button" onClick={onSelect} className="flex min-w-0 items-center gap-1.5 py-1 pr-1 text-left" aria-pressed={selected}>
        <span className="truncate">{chip.label}</span>
        {chip.hint && <span className="shrink-0 rounded bg-subtle px-1 text-xs text-fg-muted">{chip.hint}</span>}
        {chip.param && <span className="shrink-0 rounded bg-accent-soft px-1 text-xs text-accent">{t('builder.paramBadge')}</span>}
      </button>
      {onToggleDir && (
        <button type="button" onClick={onToggleDir} className="rounded p-1 text-fg-muted hover:bg-muted hover:text-fg" aria-label={chip.dir === 'desc' ? t('builder.sortDesc') : t('builder.sortAsc')} data-testid={`builder-chip-${shelf}-${index}-dir`}>
          {chip.dir === 'desc' ? <ArrowDown className="size-3.5" aria-hidden /> : <ArrowUp className="size-3.5" aria-hidden />}
        </button>
      )}
      <button type="button" onClick={onRemove} className="mr-0.5 rounded p-1 text-fg-subtle hover:bg-muted hover:text-fg" aria-label={t('builder.removeChip', { field: chip.label })} data-testid={`builder-chip-${shelf}-${index}-remove`}>
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
}

function ShelfRow({ shelf, chips, selection, onSelect, onRemove, onToggleDir }: {
  shelf: Shelf; chips: Chip[]; selection: Selection; onSelect: (i: number) => void; onRemove: (i: number) => void; onToggleDir?: (i: number) => void;
}) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `shelf:${shelf}`, data: { kind: 'shelf', shelf } });
  const dragging = active?.data.current?.kind === 'field';
  const Icon = shelfIcon[shelf];
  return (
    <div className="grid gap-1.5 sm:grid-cols-[8.5rem_1fr] sm:items-start" data-testid={`builder-shelf-${shelf}`}>
      <div className="flex items-center gap-1.5 pt-1.5 text-sm font-medium text-fg-muted">
        <Icon className="size-4" aria-hidden />{t(`builder.shelf.${shelf}` as 'builder.shelf.columns')}
        <span className="ml-auto text-xs font-normal text-fg-subtle tabular-nums sm:hidden">{chips.length}/{LIMITS[shelf]}</span>
      </div>
      <SortableContext items={chips.map(c => c.id)} strategy={horizontalListSortingStrategy}>
        <ul
          ref={setNodeRef}
          className={cn('flex min-h-10 flex-wrap items-center gap-1.5 rounded border border-dashed p-1.5 transition-colors',
            isOver ? 'border-accent bg-accent-soft' : dragging ? 'border-accent/50 bg-subtle' : 'border-border bg-subtle/50')}
          aria-label={t(`builder.shelf.${shelf}` as 'builder.shelf.columns')}
        >
          {chips.length === 0 && <li className="px-1.5 text-sm text-fg-subtle">{t(`builder.shelfEmpty.${shelf}` as 'builder.shelfEmpty.columns')}</li>}
          {chips.map((c, i) => (
            <SortableChip key={c.id} chip={c} shelf={shelf} index={i}
              selected={!!selection && 'shelf' in selection && selection.shelf === shelf && selection.index === i}
              onSelect={() => onSelect(i)} onRemove={() => onRemove(i)} onToggleDir={onToggleDir ? () => onToggleDir(i) : undefined} />
          ))}
        </ul>
      </SortableContext>
    </div>
  );
}

/** Columns / Group by / Filters / Sort shelves. Chips reorder by drag (or keyboard via dnd-kit). */
export function Shelves({ def, fields, selection, onSelect, onRemove, onToggleDir, issueAt }: {
  def: ReportDefinition; fields: Map<string, CatalogueField>; selection: Selection;
  onSelect: (s: Shelf, i: number) => void; onRemove: (s: Shelf, i: number) => void; onToggleDir: (i: number) => void; issueAt: (s: Shelf, i: number) => boolean;
}) {
  const label = (id: string) => fields.get(id)?.label ?? id;
  const chips: Record<Shelf, Chip[]> = {
    columns: def.columns.map((c, i) => ({ id: `columns:${i}:${c.field}`, label: c.label || label(c.field), hint: c.aggregate !== 'none' ? AGG_SHORT[c.aggregate] : undefined, issue: issueAt('columns', i) })),
    groupBy: def.groupBy.map((g, i) => ({ id: `groupBy:${i}:${g}`, label: label(g), issue: issueAt('groupBy', i) })),
    filters: def.filters.map((f, i) => ({ id: `filters:${i}:${f.field}`, label: label(f.field), hint: t(`builder.op.${f.op}` as 'builder.op.eq'), param: !!f.param, issue: issueAt('filters', i) })),
    sort: def.sort.map((s, i) => ({ id: `sort:${i}:${s.field}`, label: label(s.field), dir: s.dir })),
  };
  return (
    <div className="space-y-2.5">
      {(['columns', 'groupBy', 'filters', 'sort'] as const).map(s => (
        <ShelfRow key={s} shelf={s} chips={chips[s]} selection={selection} onSelect={i => onSelect(s, i)} onRemove={i => onRemove(s, i)} onToggleDir={s === 'sort' ? onToggleDir : undefined} />
      ))}
    </div>
  );
}

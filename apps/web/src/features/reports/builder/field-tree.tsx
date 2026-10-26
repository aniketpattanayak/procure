'use client';
import { useDraggable } from '@dnd-kit/core';
import { cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input, NativeSelect, Skeleton } from '@procure/ui';
import { Calendar, CalendarClock, ChevronDown, ChevronRight, CircleDot, Coins, Hash, Plus, Search, Tag, ToggleLeft, Type } from 'lucide-react';
import { useMemo, useState } from 'react';
import { t } from '@/i18n';
import type { CatalogueField, FieldType, SourceCatalogue } from '../types';
import { groupFields, LIMITS, type Shelf, SOURCE_KINDS, sourceId } from './model';

export const typeIcon: Record<FieldType, typeof Type> = {
  text: Type, number: Hash, currency: Coins, date: Calendar, datetime: CalendarClock, boolean: ToggleLeft, status: CircleDot, lookup: Tag,
};

export function SourcePicker({ sources, value, onChange, loading }: { sources: SourceCatalogue[]; value: string; onChange: (id: string) => void; loading?: boolean }) {
  if (loading) return <Skeleton className="h-9" />;
  return (
    <div className="space-y-1">
      <label htmlFor="builder-source" className="text-sm font-medium text-fg-muted">{t('builder.source')}</label>
      <NativeSelect id="builder-source" value={value} onChange={e => onChange(e.target.value)} data-testid="builder-source" className="w-full">
        <option value="" disabled>{t('builder.sourcePick')}</option>
        {SOURCE_KINDS.map(kind => {
          const list = sources.filter(s => s.source.kind === kind);
          if (!list.length) return null;
          return (
            <optgroup key={kind} label={t(`builder.sourceKind.${kind}` as 'builder.sourceKind.doc')}>
              {list.map(s => <option key={sourceId(s.source)} value={sourceId(s.source)}>{s.label}</option>)}
            </optgroup>
          );
        })}
      </NativeSelect>
    </div>
  );
}

function FieldItem({ f, onAdd, counts }: { f: CatalogueField; onAdd: (shelf: Shelf, f: CatalogueField) => void; counts: Record<Shelf, number> }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `field:${f.id}`, data: { kind: 'field', field: f } });
  const Icon = typeIcon[f.type] ?? Type;
  const can: Record<Shelf, boolean> = { columns: true, groupBy: f.groupable, filters: f.filterable, sort: true };
  return (
    <li className={cn('group flex items-center rounded hover:bg-muted', isDragging && 'opacity-40')} data-testid={`builder-field-${f.id}`}>
      <button
        ref={setNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-roledescription={t('builder.draggableField')}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-2 px-2 py-1.5 text-left active:cursor-grabbing"
        title={f.id}
      >
        <Icon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
        <span className="truncate">{f.label}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="mr-1 grid size-7 shrink-0 place-items-center rounded text-fg-subtle opacity-70 hover:bg-surface hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t('builder.addField', { field: f.label })} data-testid={`builder-add-${f.id}`}>
            <Plus className="size-3.5" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{f.label}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {(['columns', 'groupBy', 'filters', 'sort'] as const).map(s => (
            <DropdownMenuItem key={s} disabled={!can[s] || counts[s] >= LIMITS[s]} onSelect={() => onAdd(s, f)} data-testid={`builder-add-${f.id}-${s}`}>
              {t(`builder.addTo.${s}` as 'builder.addTo.columns')}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Field catalogue grouped by path (Item › Category), with search; fields drag onto shelves or use the + menu. */
export function FieldTree({ catalogue, onAdd, counts }: { catalogue: SourceCatalogue | undefined; onAdd: (shelf: Shelf, f: CatalogueField) => void; counts: Record<Shelf, number> }) {
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupFields(catalogue?.fields ?? [], q), [catalogue, q]);
  if (!catalogue) return <p className="px-1 py-6 text-center text-sm text-fg-muted">{t('builder.pickSourceFirst')}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t('builder.searchFields')} aria-label={t('builder.searchFields')} className="h-8 pl-8" data-testid="builder-field-search" />
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1" data-testid="builder-fields">
        {groups.length === 0 && <p className="py-4 text-center text-sm text-fg-muted">{t('builder.noFields')}</p>}
        {groups.map(g => {
          const open = !closed.has(g.path) || !!q;
          return (
            <div key={g.path} className="mb-1">
              <button type="button" aria-expanded={open} className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm font-medium text-fg-muted hover:text-fg"
                onClick={() => setClosed(s => { const n = new Set(s); if (n.has(g.path)) n.delete(g.path); else n.add(g.path); return n; })}>
                {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                <span className="truncate">{g.path}</span>
                <span className="ml-auto text-xs font-normal text-fg-subtle tabular-nums">{g.fields.length}</span>
              </button>
              {open && <ul className="ml-2 border-l border-border pl-1">{g.fields.map(f => <FieldItem key={f.id} f={f} onAdd={onAdd} counts={counts} />)}</ul>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

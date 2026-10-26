'use client';
import { useDraggable } from '@dnd-kit/core';
import type { FieldType } from '@procure/schema';
import { cn, Input } from '@procure/ui';
import { Search } from 'lucide-react';
import { useState, type PointerEventHandler } from 'react';
import { t } from '@/i18n';
import { PALETTE, type PaletteItem } from './catalog';

export function Palette({ onAdd }: { onAdd: (type: FieldType) => void }) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  return (
    <div className="flex h-full flex-col" data-testid="builder-palette">
      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('fb.palette.search')} aria-label={t('fb.palette.search')} className="h-8 pl-8" />
        </div>
        <p className="mt-2 text-xs text-fg-subtle">{t('fb.palette.hint')}</p>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {PALETTE.map(g => {
          const items = g.items.filter(i => !query || t(i.label).toLowerCase().includes(query) || i.type.includes(query));
          if (!items.length) return null;
          return (
            <section key={g.id} aria-labelledby={`pal-${g.id}`}>
              <h3 id={`pal-${g.id}`} className="mb-1.5 text-xs font-medium text-fg-subtle">{t(g.label)}</h3>
              <ul className="grid grid-cols-2 gap-1.5">
                {items.map(i => <li key={i.type}><PaletteButton item={i} onAdd={onAdd} /></li>)}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function PaletteButton({ item, onAdd }: { item: PaletteItem; onAdd: (type: FieldType) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `palette:${item.type}`, data: { from: 'palette', type: item.type } });
  const Icon = item.icon;
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      // Pointer drag only: Enter/Space must "click" (add at the end) instead of starting a keyboard drag.
      onPointerDown={listeners?.onPointerDown as PointerEventHandler<HTMLButtonElement> | undefined}
      onClick={() => onAdd(item.type)}
      aria-roledescription={t('fb.palette.draggable')}
      aria-label={t('fb.palette.add', { type: t(item.label) })}
      data-testid={`palette-${item.type}`}
      className={cn(
        'flex min-h-8 w-full items-center gap-1.5 rounded border border-border bg-surface px-2 py-1.5 text-left text-sm transition-colors hover:border-accent/50 hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-ring',
        isDragging && 'opacity-40',
      )}
    >
      <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
      <span className="min-w-0 leading-tight">{t(item.label)}</span>
    </button>
  );
}

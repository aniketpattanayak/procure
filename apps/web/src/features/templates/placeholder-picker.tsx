'use client';
import { cn, Input, Skeleton, SkeletonGroup } from '@procure/ui';
import { ChevronRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { t, type MessageKey } from '@/i18n';
import type { ContextField } from '@/features/notify/api';
import { exampleText, GROUP_ORDER, groupOf, HELPERS } from './placeholders';

/**
 * Placeholder rail: every context field for the document type (custom header and line fields included), grouped,
 * searchable, each with an example value. Clicking inserts at the cursor of the editor that last had focus.
 */
export function PlaceholderPicker({ fields, loading, onPick, onHelper, className }: {
  fields: ContextField[]; loading?: boolean; onPick: (f: ContextField) => void; onHelper: (snippet: string) => void; className?: string;
}) {
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const m = new Map<string, ContextField[]>();
    for (const f of fields) {
      if (needle && !f.path.toLowerCase().includes(needle) && !f.label.toLowerCase().includes(needle)) continue;
      const g = groupOf(f.path);
      m.set(g, [...(m.get(g) ?? []), f]);
    }
    return GROUP_ORDER.filter(g => m.has(g)).map(g => [g, m.get(g)!] as const);
  }, [fields, q]);
  const helpers = HELPERS.filter(h => !q.trim() || h.name.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (g: string) => setClosed(s => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; });

  return (
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="tpl-placeholders">
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t('tpl.ph.search')} aria-label={t('tpl.ph.search')} className="h-8 pl-8 text-sm" data-testid="tpl-ph-search" />
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {loading ? (
          <SkeletonGroup className="space-y-1.5">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-7" />)}</SkeletonGroup>
        ) : (
          <>
            {groups.map(([g, items]) => {
              const open = !closed.has(g) || !!q.trim();
              return (
                <section key={g} className="mb-1.5">
                  <button type="button" onClick={() => toggle(g)} aria-expanded={open} className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm font-semibold hover:bg-muted">
                    <ChevronRight className={cn('size-3.5 text-fg-subtle transition-transform motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
                    {t(`tpl.ph.group.${g}` as MessageKey)}
                    <span className="ml-auto text-xs font-normal text-fg-subtle">{items.length}</span>
                  </button>
                  {open && (
                    <ul className="space-y-px">
                      {items.map(f => (
                        <li key={f.path}>
                          <button type="button" onClick={() => onPick(f)} className="group w-full rounded px-2 py-1 text-left hover:bg-accent-soft focus-visible:bg-accent-soft"
                            data-testid={`tpl-ph-${f.path}`} title={t('tpl.ph.insertTitle', { path: f.path })}>
                            <span className="block truncate text-sm">{f.label}</span>
                            <span className="flex min-w-0 items-baseline gap-2">
                              <code className="truncate text-[11.5px] text-warning">{f.path === 'lines' ? '#each lines' : f.path.startsWith('lines.') ? f.path.slice(6) : f.path}</code>
                              {exampleText(f.example) && <span className="ml-auto max-w-[45%] shrink-0 truncate text-[11px] text-fg-subtle">{exampleText(f.example)}</span>}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
            {!!helpers.length && (
              <section className="mb-1.5 border-t border-border pt-1.5">
                <p className="px-1 py-1 text-sm font-semibold">{t('tpl.ph.helpers')}</p>
                <ul className="space-y-px">
                  {helpers.map(h => (
                    <li key={h.name}>
                      <button type="button" onClick={() => onHelper(h.snippet)} className="w-full rounded px-2 py-1 text-left hover:bg-accent-soft focus-visible:bg-accent-soft" data-testid={`tpl-helper-${h.name}`}>
                        <code className="block truncate text-[11.5px] text-accent">{h.signature}</code>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!groups.length && !helpers.length && <p className="px-1 py-2 text-sm text-fg-muted">{t('tpl.ph.none')}</p>}
          </>
        )}
      </div>
    </div>
  );
}

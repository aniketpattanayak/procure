'use client';
import type { LocationNode } from '@procure/schema';
import { Button, cn, Dialog, DialogContent, Input, Skeleton } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Globe2, MapPin, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { t } from '@/i18n';
import { locationKeys, locationsApi } from '@/features/locations/api';
import { buildTree, fullPath, searchVisible, type LocationTree } from '@/features/locations/tree';
import { TreeView } from '@/features/locations/tree-view';

export function useLocationTree() {
  const q = useQuery({ queryKey: locationKeys.tree('active', 'all'), queryFn: () => locationsApi.tree({ view: 'active', scope: 'all' }), staleTime: 60_000 });
  const tree = useMemo<LocationTree | null>(() => (q.data ? buildTree(q.data) : null), [q.data]);
  return { ...q, tree };
}

export function locationPath(n: LocationNode | undefined | null): string {
  return n ? fullPath(n).join(' / ') : '';
}

/**
 * Button showing the chosen location (or "All locations") that opens a searchable tree. `allowAll` adds the
 * "All locations" choice (null), used for the default series.
 */
export function LocationPicker({ value, onChange, testId, allowAll = true, allLabel }: { value: string | null; onChange: (id: string | null) => void; testId: string; allowAll?: boolean; allLabel?: string }) {
  const [open, setOpen] = useState(false);
  const { tree, isLoading } = useLocationTree();
  const node = value ? tree?.byId.get(value)?.node : null;
  return (
    <>
      <Button type="button" variant="secondary" className="w-full justify-start font-normal" onClick={() => setOpen(true)} data-testid={testId} aria-haspopup="dialog">
        {value ? <MapPin aria-hidden /> : <Globe2 aria-hidden />}
        <span className="truncate">{value ? (node ? locationPath(node) : isLoading ? t('common.loading') : t('num.unknownLocation')) : (allLabel ?? t('num.allLocations'))}</span>
      </Button>
      {open && <LocationDialog value={value} onPick={id => { onChange(id); setOpen(false); }} onClose={() => setOpen(false)} allowAll={allowAll} testId={`${testId}-dialog`} allLabel={allLabel} />}
    </>
  );
}

function LocationDialog({ value, onPick, onClose, allowAll, testId, allLabel }: { value: string | null; onPick: (id: string | null) => void; onClose: () => void; allowAll: boolean; testId: string; allLabel?: string }) {
  const { tree, isLoading } = useLocationTree();
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    if (tree) for (const r of tree.roots) s.add(r.id);
    if (value && tree) for (let p = tree.byId.get(value)?.parent; p; p = p.parent) s.add(p.id);
    return s;
  });
  const search = tree ? searchVisible(tree, q) : null;
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={t('num.pickLocation')} closeLabel={t('common.close')} data-testid={testId}>
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('num.searchLocations')} aria-label={t('num.searchLocations')} className="pl-8" data-testid={`${testId}-search`} />
          </div>
          {allowAll && (
            <button type="button" onClick={() => onPick(null)} data-testid={`${testId}-all`}
              className={cn('flex w-full items-center gap-2 rounded px-2.5 py-2 text-left hover:bg-muted', value === null && 'bg-accent-soft font-medium text-accent')}>
              <Globe2 className="size-4" aria-hidden />{allLabel ?? t('num.allLocations')}
            </button>
          )}
          {isLoading || !tree ? <Skeleton className="h-40" /> : (
            <TreeView
              roots={tree.roots}
              label={t('num.pickLocation')}
              expanded={expanded}
              onExpandedChange={setExpanded}
              visibleIds={search?.visible ?? null}
              selectedId={value}
              onSelect={tn => onPick(tn.id)}
              rowTestId={tn => `${testId}-node-${tn.node.code}`}
              className="max-h-80 overflow-y-auto"
              renderRow={(tn, s) => (
                <span className={cn('flex min-w-0 items-center gap-2', s.selected && 'font-medium text-accent')}>
                  <span className="truncate">{tn.node.name}</span>
                  <code className="text-xs text-fg-subtle">{tn.node.code}</code>
                  <span className="text-xs text-fg-subtle">{tn.node.levelLabel}</span>
                </span>
              )}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

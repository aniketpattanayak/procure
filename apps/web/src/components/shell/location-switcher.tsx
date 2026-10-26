'use client';
import { Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input, Skeleton } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Globe2, MapPin } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { locationKeys, locationsApi } from '@/features/locations/api';
import { ancestorPath } from '@/features/locations/tree';
import { t } from '@/i18n';
import { setCurrentLocation, useCurrentLocationId } from '@/lib/location';
import { usePermissions } from '@/lib/permissions';
import { useTenantPrincipal } from '@/lib/session';

/** Top-bar location switcher: the user's scoped nodes (`/locations?scope=mine`), choice remembered per user. */
export function LocationSwitcher() {
  const me = useTenantPrincipal();
  const p = usePermissions();
  const userId = me?.userId ?? null;
  const current = useCurrentLocationId(userId);
  const [q, setQ] = useState('');
  const nodes = useQuery({
    queryKey: locationKeys.mine,
    queryFn: () => locationsApi.tree({ scope: 'mine', view: 'active' }),
    enabled: !!userId,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const list = useMemo(() => nodes.data ?? [], [nodes.data]);
  const selected = list.find(n => n.id === current) ?? null;
  const canAll = p.scope.allNodes || p.isTenantAdmin || list.length !== 1;

  // Drop a remembered node that's no longer in scope; a single-node scope selects that node.
  useEffect(() => {
    if (!userId || !nodes.data) return;
    if (current && !nodes.data.some(n => n.id === current)) setCurrentLocation(userId, null);
    else if (!current && !canAll && nodes.data[0]) setCurrentLocation(userId, nodes.data[0].id);
  }, [userId, current, nodes.data, canAll]);

  if (!userId) return null;
  if (nodes.isError || (nodes.data && !list.length)) {
    // No locations yet (or endpoint unavailable): a quiet static label.
    return (
      <span className="hidden items-center gap-1.5 px-2 text-sm text-fg-muted md:inline-flex" data-testid="location-switcher">
        <MapPin className="size-4" aria-hidden />{t('topbar.allLocations')}
      </span>
    );
  }
  const needle = q.trim().toLowerCase();
  const filtered = needle ? list.filter(n => n.name.toLowerCase().includes(needle) || n.code.toLowerCase().includes(needle)) : list;
  const allLabel = p.scope.allNodes || p.isTenantAdmin ? t('topbar.allLocations') : t('location.allMine');
  const label = selected ? selected.name : allLabel;

  return (
    <DropdownMenu onOpenChange={o => { if (!o) setQ(''); }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-56" aria-label={t('location.switcherLabel', { current: label })} data-testid="location-switcher" data-current={selected?.id ?? 'all'}>
          {selected ? <MapPin aria-hidden /> : <Globe2 aria-hidden />}
          <span className="hidden truncate sm:inline">{nodes.isLoading ? <Skeleton className="h-3 w-20" /> : label}</span>
          <ChevronDown className="!size-3.5 text-fg-subtle" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(20rem,calc(100vw-2rem))] p-0" data-testid="location-switcher-menu">
        <DropdownMenuLabel className="px-3 pt-2.5 text-fg">{t('location.switcherTitle')}</DropdownMenuLabel>
        {list.length > 8 && (
          <div className="px-2 pb-2" onKeyDown={e => e.stopPropagation()}>
            <Input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('locations.search')} aria-label={t('locations.search')} className="h-8" autoFocus />
          </div>
        )}
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-80 overflow-y-auto p-1">
          {canAll && !needle && (
            <DropdownMenuItem onSelect={() => setCurrentLocation(userId, null)} data-testid="location-option-all">
              <Globe2 aria-hidden />
              <span className="flex-1">{allLabel}</span>
              {!selected && <Check className="text-accent" aria-hidden />}
            </DropdownMenuItem>
          )}
          {filtered.map(n => (
            <DropdownMenuItem key={n.id} onSelect={() => setCurrentLocation(userId, n.id)} data-testid={`location-option-${n.code}`}>
              <span style={{ paddingLeft: `${(n.depth - 1) * 0.875}rem` }} className={cn('flex min-w-0 flex-1 flex-col')}>
                <span className="truncate">{n.name}</span>
                <span className="truncate text-xs text-fg-subtle">{ancestorPath(n).length ? t('location.levelIn', { level: n.levelLabel, path: ancestorPath(n).join(' / ') }) : n.levelLabel}</span>
              </span>
              {selected?.id === n.id && <Check className="text-accent" aria-hidden />}
            </DropdownMenuItem>
          ))}
          {!filtered.length && <p className="px-3 py-3 text-sm text-fg-muted">{t('locations.noMatch')}</p>}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

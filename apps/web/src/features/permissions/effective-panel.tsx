'use client';
import { Badge, Card, CardBody, CardHeader, EmptyState, Input, Skeleton, SkeletonGroup } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Search, ShieldQuestion } from 'lucide-react';
import { useMemo, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { permissionsApi, qk } from './api';
import { actionKey, viewKey } from './model';
import { groupTabs, useRegistry } from './permission-workbench';

function sourceLabel(s: string) {
  if (s.startsWith('role:')) return { text: t('perm.why.role', { name: s.slice(5) }), tone: 'neutral' as const };
  if (s === 'user:allow') return { text: t('perm.why.allow'), tone: 'success' as const };
  if (s === 'user:deny') return { text: t('perm.why.deny'), tone: 'danger' as const };
  if (s === 'tenant_admin') return { text: t('perm.why.admin'), tone: 'accent' as const };
  return { text: s, tone: 'neutral' as const };
}

/** "Why can she do this?" — every key with its result and where it came from. */
export function EffectivePanel({ userId }: { userId: string }) {
  const eff = useQuery({ queryKey: qk.effective(userId), queryFn: () => permissionsApi.effective(userId) });
  const registry = useRegistry();
  const [q, setQ] = useState('');
  const [onlyGranted, setOnlyGranted] = useState(true);

  const rows = useMemo(() => {
    const byKey = new Map(eff.data?.keys.map(k => [k.key, k]) ?? []);
    const needle = q.trim().toLowerCase();
    return groupTabs(registry.data ?? []).map(([group, tabs]) => ({
      group,
      tabs: tabs.map(tab => ({
        tab,
        items: [
          ...tab.actions.map(a => ({ key: actionKey(tab, a.key), label: a.label })),
          ...tab.views.map(v => ({ key: viewKey(tab, v.key), label: `${t('perm.viewPrefix')} ${v.label}` })),
        ]
          .map(i => ({ ...i, row: byKey.get(i.key) }))
          .filter(i => (!onlyGranted || i.row?.granted) && (!needle || i.label.toLowerCase().includes(needle) || tab.label.toLowerCase().includes(needle))),
      })).filter(x => x.items.length),
    })).filter(g => g.tabs.length);
  }, [eff.data, registry.data, q, onlyGranted]);

  if (eff.isLoading || registry.isLoading) return <SkeletonGroup className="space-y-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}</SkeletonGroup>;
  if (eff.isError) return <InlineAlert>{(eff.error as Error).message}</InlineAlert>;
  const data = eff.data!;

  return (
    <div className="space-y-4" data-testid="effective-panel">
      <Card>
        <CardHeader title={t('perm.why.scopeTitle')} />
        <CardBody>
          {data.isTenantAdmin ? <p>{t('perm.why.adminAll')}</p> : data.scope.allNodes ? <p>{t('scope.summaryAll')}</p> : data.scope.nodes.length ? (
            <ul className="flex flex-wrap gap-2">
              {data.scope.nodes.map(n => (
                <li key={`${n.id}-${n.tabKey}`}><Badge>{n.name}{n.includeDescendants ? ` ${t('perm.why.plusSub')}` : ''}{n.tabKey ? ` (${n.tabKey})` : ''}</Badge></li>
              ))}
            </ul>
          ) : <p className="text-fg-muted">{t('scope.summaryNone')}</p>}
          {data.hiddenByPlan.length > 0 && <p className="mt-3 text-sm text-fg-muted">{t('perm.why.hiddenByPlan', { tabs: (data.hiddenByPlan as (string | { key: string; label: string })[]).map(h => (typeof h === 'string' ? h : h.label)).join(', ') })}</p>}
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('perm.why.search')} aria-label={t('perm.why.search')} className="pl-8" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyGranted} onChange={e => setOnlyGranted(e.target.checked)} className="size-4 accent-[rgb(var(--c-accent))]" />
          {t('perm.why.onlyGranted')}
        </label>
      </div>

      {!rows.length ? <EmptyState icon={<ShieldQuestion />} title={t('perm.why.empty')} /> : rows.map(g => (
        <section key={g.group} aria-label={g.group} className="space-y-2">
          <h3 className="text-sm font-medium text-fg-subtle">{g.group}</h3>
          {g.tabs.map(({ tab, items }) => (
            <Card key={tab.key} className="overflow-hidden">
              <p className="border-b border-border bg-subtle px-4 py-2 font-medium">{tab.label}</p>
              <ul className="divide-y divide-border">
                {items.map(i => (
                  <li key={i.key} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2" data-testid={`why-${i.key}`}>
                    <span className={i.row?.granted ? '' : 'text-fg-muted line-through decoration-fg-subtle'}>{i.label}</span>
                    <span className="flex flex-wrap gap-1">
                      {(i.row?.sources ?? []).map(s => { const l = sourceLabel(s); return <Badge key={s} tone={l.tone}>{l.text}</Badge>; })}
                      {!i.row?.sources.length && <span className="text-sm text-fg-subtle">{t('perm.why.noSource')}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </section>
      ))}
    </div>
  );
}

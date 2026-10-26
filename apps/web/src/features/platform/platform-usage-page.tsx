'use client';
import { Card, EmptyState, Input, Skeleton, SkeletonGroup, Table, TBody, TD, TH, THead, TR, UsageBar, usageLevel, cn } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Gauge, Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { fmtNumber } from '@/lib/format';
import { platformApi } from './api';

export function PlatformUsagePage() {
  const usage = useQuery({ queryKey: ['platform', 'usage'], queryFn: platformApi.usage });
  const catalog = useQuery({ queryKey: ['platform', 'catalog'], queryFn: platformApi.catalog, staleTime: 10 * 60_000 });
  const [search, setSearch] = useState('');
  const [onlyHot, setOnlyHot] = useState(false);

  const keys = useMemo(() => {
    const seen = new Set<string>();
    usage.data?.forEach(r => r.limits.forEach(l => seen.add(l.key)));
    const order = catalog.data?.limits.map(l => l.key) ?? [];
    return [...seen].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
  }, [usage.data, catalog.data]);
  const nameOf = (k: string) => catalog.data?.limits.find(l => l.key === k)?.name ?? k;

  const rows = (usage.data ?? []).filter(r => {
    const s = search.trim().toLowerCase();
    if (s && !r.name.toLowerCase().includes(s) && !r.code.includes(s)) return false;
    if (onlyHot && !r.limits.some(l => usageLevel(l.used, l.effective) !== 'ok')) return false;
    return true;
  });

  return (
    <PageBody>
      <PageHeader title={t('platformUsage.title')} description={t('platformUsage.description')} />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2.5">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('tenants.search')} aria-label={t('tenants.search')} className="pl-8" />
          </div>
          <label className="flex items-center gap-2 text-base">
            <input type="checkbox" checked={onlyHot} onChange={e => setOnlyHot(e.target.checked)} className="size-4 accent-[rgb(var(--c-accent))]" />
            {t('platformUsage.onlyHot')}
          </label>
        </div>
        {usage.isLoading ? (
          <SkeletonGroup className="space-y-2 p-4">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12" />)}</SkeletonGroup>
        ) : usage.isError ? (
          <div className="p-4"><InlineAlert>{(usage.error as Error).message}</InlineAlert></div>
        ) : !rows.length ? (
          <EmptyState icon={<Gauge />} title={t('platformUsage.empty')} />
        ) : (
          <Table data-testid="platform-usage-table">
            <THead><TR>
              <TH className="sticky left-0 bg-subtle">{t('tenants.col.name')}</TH>
              {keys.map(k => <TH key={k} className="min-w-36">{nameOf(k)}</TH>)}
            </TR></THead>
            <TBody>
              {rows.map(r => (
                <TR key={r.tenantId}>
                  <TD className="sticky left-0 bg-surface">
                    <Link href={`/platform/tenants/${r.tenantId}`} className="font-medium hover:underline">{r.name}</Link>
                    <p className="font-mono text-sm text-fg-muted">{r.code}</p>
                  </TD>
                  {keys.map(k => {
                    const l = r.limits.find(x => x.key === k);
                    if (!l) return <TD key={k} className="text-fg-subtle">—</TD>;
                    const level = usageLevel(l.used, l.effective);
                    return (
                      <TD key={k}>
                        <p className={cn('mb-1 text-sm tabular', level === 'warn' && 'font-medium text-warning', level === 'full' && 'font-medium text-danger')}>
                          {fmtNumber(l.used)} / {l.effective === null ? '∞' : fmtNumber(l.effective)}
                        </p>
                        <UsageBar used={l.used} max={l.effective} label={`${r.name}: ${nameOf(k)}`} />
                      </TD>
                    );
                  })}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </PageBody>
  );
}

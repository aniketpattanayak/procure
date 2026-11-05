'use client';
import type { InboxCounts, InboxItem } from '@procure/schema';
import { Button, Card, cn, EmptyState, LoadMore, Skeleton, Switch } from '@procure/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronRight, Clock, Forward, Inbox, Siren } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PageBody, PageHeader } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { formatDecimal } from '@/engines/form-renderer/values';
import { approvalsApi, docKeys } from '@/features/documents/api';
import { dueText } from '@/features/documents/workflow-progress';
import { t } from '@/i18n';
import { useInboxCounts } from './use-inbox-counts';
import { fmtRelative } from '@/lib/format';

export const approveHref = (i: Pick<InboxItem, 'docTypeKey' | 'documentId' | 'stageKey'>) => `/docs/${i.docTypeKey}/${i.documentId}/approve?stage=${encodeURIComponent(i.stageKey)}`;


export function InboxPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { currency } = useTenantLocale();
  const docType = sp.get('docType') ?? undefined;
  const stage = sp.get('stage') ?? undefined;
  const overdue = sp.get('overdue') === '1';
  const set = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    const qs = n.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const counts = useInboxCounts();
  const list = useInfiniteQuery({
    queryKey: [...docKeys.inbox, 'list', docType ?? '', stage ?? '', overdue],
    queryFn: ({ pageParam }) => approvalsApi.list({ docType, stage, overdue, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: last => last.nextCursor,
  });
  const rows = list.data?.pages.flatMap(p => p.data) ?? [];

  return (
    <PageBody>
      <PageHeader title={t('inbox.title')} description={t('inbox.subtitle')} />
      <CountsStrip counts={counts.data} loading={counts.isLoading} docType={docType} stage={stage} overdue={overdue} onPick={(dt, st) => set({ docType: dt, stage: st })} onOverdue={v => set({ overdue: v ? '1' : null })} />

      <Card className="mt-4 overflow-hidden" data-testid="inbox-list">
        {list.isLoading ? (
          <div className="divide-y divide-border" aria-busy="true">{[0, 1, 2, 3].map(i => <div key={i} className="flex gap-3 p-4"><Skeleton className="h-10 w-10 rounded" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-3 w-1/2" /></div></div>)}</div>
        ) : list.isError ? (
          <div role="alert" className="p-8 text-center text-fg-muted">{t('inbox.error')} <Button variant="link" onClick={() => void list.refetch()}>{t('common.retry')}</Button></div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Inbox />} title={docType || overdue ? t('inbox.emptyFiltered') : t('inbox.empty')} description={docType || overdue ? undefined : t('inbox.emptyHint')}
            action={docType || overdue ? <Button variant="secondary" onClick={() => set({ docType: null, stage: null, overdue: null })}>{t('docs.list.clearFilters')}</Button> : undefined} />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(i => <InboxRow key={`${i.documentId}:${i.stageKey}`} i={i} currency={currency} />)}
          </ul>
        )}
        <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} label={t('table.loadMore')} />
      </Card>
    </PageBody>
  );
}

function CountsStrip({ counts, loading, docType, stage, overdue, onPick, onOverdue }: {
  counts: InboxCounts | undefined; loading: boolean; docType?: string; stage?: string; overdue: boolean;
  onPick: (docType: string | null, stage: string | null) => void; onOverdue: (v: boolean) => void;
}) {
  if (loading) return <div className="flex gap-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9 w-36 rounded-full" />)}</div>;
  const by = counts?.byType ?? [];
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div role="group" aria-label={t('inbox.filterLabel')} className="flex flex-1 gap-1.5 overflow-x-auto pb-1">
        <Chip on={!docType} onClick={() => onPick(null, null)} label={t('inbox.all')} count={counts?.total ?? 0} testId="inbox-filter-all" />
        {by.map(b => (
          <Chip key={`${b.docTypeKey}:${b.stageKey}`} on={docType === b.docTypeKey && stage === b.stageKey} onClick={() => onPick(b.docTypeKey, b.stageKey)}
            label={`${b.name} · ${b.stageName}`} count={b.count} overdue={b.overdue} testId={`inbox-filter-${b.docTypeKey}-${b.stageKey}`} />
        ))}
      </div>
      <label className="flex shrink-0 items-center gap-2 text-sm">
        <Switch checked={overdue} onCheckedChange={onOverdue} data-testid="inbox-overdue" />
        <span>{t('inbox.overdueOnly')}</span>
        {!!counts?.overdue && <span className="rounded-full bg-danger-soft px-1.5 text-xs font-semibold text-danger tabular-nums" data-testid="inbox-overdue-count">{counts.overdue}</span>}
      </label>
    </div>
  );
}

function Chip({ on, onClick, label, count, overdue, testId }: { on: boolean; onClick: () => void; label: string; count: number; overdue?: number; testId: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} data-testid={testId} data-count={count}
      className={cn('inline-flex h-9 shrink-0 items-center gap-2 rounded-full border pl-3.5 pr-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:bg-muted hover:text-fg')}>
      <span className="whitespace-nowrap">{label}</span>
      <span className={cn('min-w-6 rounded-full px-1.5 text-center text-xs tabular-nums', on ? 'bg-accent text-accent-fg' : 'bg-muted')}>{count}</span>
      {!!overdue && <span className="rounded-full bg-danger-soft px-1.5 text-xs font-semibold text-danger tabular-nums" title={t('inbox.overdueN', { n: overdue })}>{overdue}</span>}
    </button>
  );
}

function InboxRow({ i, currency }: { i: InboxItem; currency: string }) {
  const due = dueText(i.dueAt, i.overdue);
  return (
    <li>
      <Link href={approveHref(i)} className="group flex items-center gap-3 px-4 py-3 hover:bg-subtle focus-visible:bg-accent-soft focus-visible:outline-none" data-testid={`inbox-row-${i.number ?? i.documentId}`}>
        <span className={cn('grid size-10 shrink-0 place-items-center rounded-lg text-sm font-semibold', i.overdue ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent')} aria-hidden>
          {i.overdue ? <Siren className="size-5" /> : i.pendingLines}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold tabular-nums">{i.number ?? t('docs.draft')}</span>
            <span className="text-sm text-fg-muted">{i.docTypeName} · {i.stageName}</span>
            {i.assignedBecause !== 'rule' && (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 text-xs text-fg-muted"><Forward className="size-3" aria-hidden />{t(i.assignedBecause === 'forward' ? 'inbox.forwarded' : 'inbox.escalated')}</span>
            )}
          </p>
          <p className="truncate text-sm text-fg-muted">
            {[i.location, i.submittedBy, i.submittedAt ? fmtRelative(i.submittedAt) : null].filter(Boolean).join(' · ')}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
            <span className="text-accent">{t('inbox.pendingLines', { n: i.pendingLines })}</span>
            {i.heldLines > 0 && <span className="text-warning">{t('inbox.heldLines', { n: i.heldLines })}</span>}
            {due && <span className={cn('inline-flex items-center gap-1', i.overdue ? 'font-medium text-danger' : 'text-fg-subtle')}><Clock className="size-3" aria-hidden />{due}</span>}
          </p>
        </div>
        {i.totalAmount && <span className="hidden text-right font-medium tabular-nums sm:block">{formatDecimal(i.totalAmount, 2, { currency })}</span>}
        <ChevronRight className="size-4 shrink-0 text-fg-subtle group-hover:text-fg" aria-hidden />
      </Link>
    </li>
  );
}

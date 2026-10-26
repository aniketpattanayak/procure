'use client';
import type { DocumentRow } from '@procure/schema';
import { Button, EmptyState, Skeleton, SkeletonGroup } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Inbox, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { t } from '@/i18n';
import { fmtRelative } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { notifyKeys, sendApi, type OutboundMessageRow } from '@/features/notify/api';
import { ChannelTag, DeliveryRail, MessageStatusBadge } from '@/features/notify/ui';
import { MessageDetail, useRetry } from './message-detail';

const LIVE = new Set(['queued', 'sending', 'sent', 'delivered']);

/** Messages tab on a document: every send for it with live delivery / read status. */
export function DocMessages({ type, doc }: { type: string; doc: DocumentRow }) {
  const p = usePermissions();
  const [open, setOpen] = useState<OutboundMessageRow | null>(null);
  const { retry, busy } = useRetry();
  const q = useQuery({
    queryKey: notifyKeys.docMessages(type, doc.id),
    queryFn: () => sendApi.docMessages(type, doc.id),
    // Poll while anything is still moving (a WhatsApp "delivered" can still become "read").
    refetchInterval: query => ((query.state.data ?? []).some(m => LIVE.has(m.status) && Date.now() - new Date(m.createdAt).getTime() < 3600_000) ? 4000 : false),
  });
  const rows = [...(q.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (q.isLoading) return <SkeletonGroup className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></SkeletonGroup>;
  if (q.isError) return <EmptyState title={t('table.error')} action={<Button variant="secondary" onClick={() => void q.refetch()}>{t('common.retry')}</Button>} />;
  if (!rows.length) return <EmptyState icon={<Inbox />} title={t('msg.docEmpty')} description={t('msg.docEmptyHint')} />;
  return (
    <>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface" data-testid="msg-doc-list">
        {rows.map(m => (
          <li key={m.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4" data-testid="msg-doc-row" data-status={m.status} data-channel={m.channel}>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(m)}>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <ChannelTag channel={m.channel} />
                <span className="min-w-0 truncate font-medium">{m.recipientName ?? m.recipient}</span>
                {m.recipientName && <span className="truncate text-sm text-fg-muted">{m.recipient}</span>}
              </span>
              <span className="mt-0.5 block truncate text-sm text-fg-muted">{m.subject ?? m.bodyPreview ?? ''}</span>
            </button>
            <div className="flex items-center gap-3">
              <span className="flex w-[4.75rem] justify-end"><DeliveryRail m={m} compact /></span>
              <span className="flex w-24"><MessageStatusBadge status={m.status} /></span>
              <span className="w-28 whitespace-nowrap text-right text-xs text-fg-subtle" title={m.createdAt}>{fmtRelative(m.createdAt)}</span>
              {m.status === 'failed' && p.has('messages:action.retry') && (
                <Button size="icon-sm" variant="ghost" aria-label={t('msg.retry')} onClick={() => void retry(m)} loading={busy === m.id} data-testid="msg-retry-row"><RotateCcw aria-hidden /></Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <MessageDetail m={open} onClose={() => setOpen(null)} onChanged={setOpen} />
    </>
  );
}

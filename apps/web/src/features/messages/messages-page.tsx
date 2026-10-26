'use client';
import { Button, DataTable, EmptyState, Input, NativeSelect, Segmented, type DataTableColumn } from '@procure/ui';
import { MailX, RefreshCw, RotateCcw, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { fmtDateTime } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { useDebounced } from '@/lib/use-debounced';
import { messagesApi, type MessageChannel, type MessageFilters, type MessageStatus, type OutboundMessageRow } from '@/features/notify/api';
import { ChannelTag, DeliveryRail, MessageStatusBadge, channelLabel, statusLabel } from '@/features/notify/ui';
import { MessageDetail, useRetry } from './message-detail';

const shortFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shortWhen = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? v : shortFmt.format(d); };

const STATUSES: MessageStatus[] = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'blocked_limit', 'blocked_config', 'cancelled'];

/** /messages: every email, WhatsApp and in-app message the workspace sent, with delivery status. */
export function MessagesPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const p = usePermissions();
  const [channel, setChannel] = useState<'all' | MessageChannel>((sp.get('channel') as MessageChannel) || 'all');
  const [status, setStatus] = useState<'' | MessageStatus>((sp.get('status') as MessageStatus) || '');
  const [doc, setDoc] = useState(sp.get('documentId') ?? '');
  const [open, setOpen] = useState<OutboundMessageRow | null>(null);
  const [tick, setTick] = useState(0);
  const { retry, busy } = useRetry(() => setTick(x => x + 1));
  const docQ = useDebounced(doc.trim(), 350);

  const filters: MessageFilters = { channel: channel === 'all' ? undefined : channel, status: status || undefined, documentId: docQ || undefined };
  const key = JSON.stringify({ ...filters, tick });
  const fetchPage = useCallback((cursor: string | null) => messagesApi.list(JSON.parse(key) as MessageFilters, cursor), [key]);
  const active = channel !== 'all' || !!status || !!doc;
  const canRetry = p.has('messages:action.retry');
  const clear = () => { setChannel('all'); setStatus(''); setDoc(''); router.replace('/messages'); };

  const columns = useMemo<DataTableColumn<OutboundMessageRow>[]>(() => [
    { id: 'when', header: t('msg.col.created'), width: 130, alwaysVisible: true, cell: ({ row }) => <span className="tabular-nums text-fg-muted" title={fmtDateTime(row.original.createdAt)}>{shortWhen(row.original.createdAt)}</span> },
    { id: 'channel', header: t('msg.col.channel'), width: 105, cell: ({ row }) => <ChannelTag channel={row.original.channel} /> },
    {
      id: 'to', header: t('msg.col.to'), width: 200, cell: ({ row }) => (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate">{row.original.recipientName ?? row.original.recipient}</span>
          {row.original.recipientName && <span className="truncate text-xs text-fg-subtle">{row.original.recipient}</span>}
        </span>
      ),
    },
    { id: 'subject', header: t('msg.col.subject'), width: 210, cell: ({ row }) => <span className="truncate text-fg-muted">{row.original.subject ?? row.original.bodyPreview ?? '—'}</span> },
    {
      id: 'document', header: t('msg.col.document'), width: 145, cell: ({ row }) => row.original.document
        ? <Link href={`/docs/${row.original.document.docTypeKey}/${row.original.document.id}?tab=messages`} onClick={e => e.stopPropagation()} className="truncate text-accent hover:underline">{row.original.document.number ?? t('msg.draftDoc')}</Link>
        : <span className="text-fg-subtle">—</span>,
    },
    {
      id: 'status', header: t('msg.col.status'), width: 190, cell: ({ row }) => (
        <span className="flex items-center gap-2.5" data-testid={`msg-status-${row.original.id}`} data-status={row.original.status}>
          <DeliveryRail m={row.original} compact />
          <MessageStatusBadge status={row.original.status} />
        </span>
      ),
    },
    { id: 'source', header: t('msg.col.source'), width: 170, defaultHidden: true, cell: ({ row }) => <span className="truncate text-fg-muted">{row.original.manual ? t('msg.manual') : row.original.triggerRule ?? t('msg.automatic')}</span> },
    { id: 'attempts', header: t('msg.attempts'), width: 90, align: 'right', defaultHidden: true, cell: ({ row }) => <span className="tabular-nums">{row.original.attempts}</span> },
    {
      id: 'actions', header: '', width: 80, align: 'right', alwaysVisible: true, cell: ({ row }) => row.original.status === 'failed' && canRetry ? (
        <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); void retry(row.original); }} loading={busy === row.original.id} data-testid={`msg-retry-${row.original.id}`}>
          <RotateCcw aria-hidden />{t('msg.retry')}
        </Button>
      ) : null,
    },
  ], [busy, canRetry, retry]);

  return (
    <PageBody>
      <PageHeader title={t('msg.title')} description={t('msg.description')}
        actions={<Button variant="secondary" onClick={() => setTick(x => x + 1)} data-testid="msg-refresh"><RefreshCw aria-hidden />{t('msg.refresh')}</Button>} />
      <div className="mb-3 flex flex-wrap items-end gap-2" role="search" aria-label={t('msg.filters')} data-testid="msg-filters">
        <Segmented label={t('msg.col.channel')} value={channel} onChange={setChannel} data-testid="msg-filter-channel"
          options={[{ value: 'all', label: t('tpl.filter.all') }, ...(['email', 'whatsapp', 'inapp'] as MessageChannel[]).map(c => ({ value: c, label: channelLabel(c) }))]} />
        <NativeSelect aria-label={t('msg.col.status')} value={status} onChange={e => setStatus(e.target.value as MessageStatus | '')} className="h-8 w-auto min-w-[10rem] text-sm" data-testid="msg-filter-status">
          <option value="">{t('msg.allStatuses')}</option>
          {STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </NativeSelect>
        <Input aria-label={t('msg.f.document')} placeholder={t('msg.f.documentPlaceholder')} value={doc} onChange={e => setDoc(e.target.value)} className="h-8 w-56 text-sm" data-testid="msg-filter-document" />
        {active && <Button size="sm" variant="ghost" onClick={clear} data-testid="msg-filter-clear"><X aria-hidden />{t('auditlog.clear')}</Button>}
      </div>
      <DataTable
        data-testid="msg-table"
        columns={columns}
        fetchPage={fetchPage}
        queryKey={key}
        getRowId={r => r.id}
        onRowClick={r => setOpen(r)}
        storageKey="tenant-messages"
        height="calc(100dvh - 16rem)"
        labels={{ caption: t('msg.title'), columns: t('table.columns'), loadMore: t('table.loadMore'), error: t('table.error'), retry: t('common.retry'), loading: t('common.loading') }}
        empty={<EmptyState icon={<MailX />} title={active ? t('msg.emptyFiltered') : t('msg.empty')} description={active ? undefined : t('msg.emptyHint')} />}
      />
      <MessageDetail m={open} onClose={() => setOpen(null)} onChanged={m => { setOpen(m); setTick(x => x + 1); }} />
    </PageBody>
  );
}

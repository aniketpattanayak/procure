'use client';
import { Button, Sheet, SheetContent, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { DetailList, InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { messagesApi, notifyKeys, type OutboundMessageRow } from '@/features/notify/api';
import { ChannelTag, DeliveryRail, MessageStatusBadge } from '@/features/notify/ui';

export function useRetry(onDone?: (m: OutboundMessageRow) => void) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  async function retry(m: OutboundMessageRow) {
    setBusy(m.id);
    try {
      const next = await messagesApi.retry(m.id);
      toast.success(t('msg.retried'));
      void qc.invalidateQueries({ queryKey: notifyKeys.messages });
      if (m.document) void qc.invalidateQueries({ queryKey: notifyKeys.docMessages(m.document.docTypeKey, m.document.id) });
      onDone?.(next);
    } catch (e) {
      toast.error(t('msg.retryFailed'), isApiError(e) ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }
  return { retry, busy };
}

/** Right-hand drawer with one message's full lifecycle. */
export function MessageDetail({ m, onClose, onChanged }: { m: OutboundMessageRow | null; onClose: () => void; onChanged?: (m: OutboundMessageRow) => void }) {
  const p = usePermissions();
  const { retry, busy } = useRetry(onChanged);
  return (
    <Sheet open={!!m} onOpenChange={o => { if (!o) onClose(); }}>
      {m && (
        <SheetContent side="right" title={t('msg.detailTitle')} closeLabel={t('common.close')} className="w-full max-w-none sm:w-[34rem] sm:max-w-[34rem]" data-testid="msg-detail">
          <div className="space-y-5 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <MessageStatusBadge status={m.status} />
              <DeliveryRail m={m} />
            </div>
            {m.error && <InlineAlert data-testid="msg-detail-error">{m.error}</InlineAlert>}
            {m.status === 'blocked_limit' && <InlineAlert tone="warning">{t('msg.blockedLimitHint')}</InlineAlert>}
            {m.status === 'blocked_config' && <InlineAlert tone="warning">{t('msg.blockedConfigHint')}</InlineAlert>}
            <DetailList items={[
              { label: t('msg.col.channel'), value: <ChannelTag channel={m.channel} /> },
              { label: t('msg.col.to'), value: <span>{m.recipientName && <span className="font-medium">{m.recipientName} </span>}<span className="break-all text-fg-muted">{m.recipient}</span></span> },
              { label: t('msg.col.document'), value: m.document ? <Link href={`/docs/${m.document.docTypeKey}/${m.document.id}`} className="text-accent hover:underline">{m.document.number ?? t('msg.draftDoc')}</Link> : '—' },
              { label: t('msg.col.source'), value: m.manual ? t('msg.manual') : m.triggerRule ?? t('msg.automatic') },
              { label: t('msg.queuedAt'), value: fmtDateTime(m.createdAt) },
              { label: t('msg.status.sent'), value: fmtDateTime(m.sentAt) },
              { label: t('msg.status.delivered'), value: fmtDateTime(m.deliveredAt) },
              ...(m.channel === 'whatsapp' ? [{ label: t('msg.status.read'), value: fmtDateTime(m.readAt) }] : []),
              { label: t('msg.attempts'), value: String(m.attempts) },
            ]} />
            {m.subject && <div><p className="text-sm text-fg-muted">{t('tpl.email.subject')}</p><p className="font-medium">{m.subject}</p></div>}
            {m.bodyPreview && (
              <div>
                <p className="mb-1 text-sm text-fg-muted">{t('msg.bodyPreview')}</p>
                <p className="whitespace-pre-wrap rounded border border-border bg-subtle p-3 text-sm" data-testid="msg-detail-body">{m.bodyPreview}</p>
              </div>
            )}
            {m.status === 'failed' && p.has('messages:action.retry') && (
              <Button onClick={() => void retry(m)} loading={busy === m.id} data-testid="msg-retry"><RotateCcw aria-hidden />{t('msg.retry')}</Button>
            )}
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}

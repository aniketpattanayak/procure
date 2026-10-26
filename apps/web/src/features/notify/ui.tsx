'use client';
import { cn, StatusBadge, type BadgeTone } from '@procure/ui';
import { Bell, FileText, Mail, MessageCircle } from 'lucide-react';
import { t, type MessageKey } from '@/i18n';
import { fmtDateTime, fmtNumber } from '@/lib/format';
import type { MessageStatus, OutboundMessageRow, TemplateChannel } from './api';

export const channelIcon = { pdf: FileText, email: Mail, whatsapp: MessageCircle, inapp: Bell } as const;

export function channelLabel(c: TemplateChannel) {
  return t(`notify.channel.${c}` as MessageKey);
}

export function ChannelTag({ channel, className }: { channel: TemplateChannel; className?: string }) {
  const Icon = channelIcon[channel];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', className)} data-channel={channel}>
      <Icon className="size-3.5 text-fg-subtle" aria-hidden />{channelLabel(channel)}
    </span>
  );
}

const statusTone: Record<MessageStatus, BadgeTone> = {
  queued: 'neutral', sending: 'neutral', sent: 'accent', delivered: 'success', read: 'success',
  failed: 'danger', blocked_limit: 'warning', blocked_config: 'warning', cancelled: 'neutral',
};

export function statusLabel(s: MessageStatus) {
  return t(`msg.status.${s}` as MessageKey);
}

export function MessageStatusBadge({ status, className }: { status: MessageStatus; className?: string }) {
  return <StatusBadge tone={statusTone[status]} className={className} data-status={status}>{statusLabel(status)}</StatusBadge>;
}

/**
 * Delivery track: queued → sent → delivered → read, filled up to where the message got. Failed and blocked
 * messages stop the track at the step they reached, drawn in the failure colour, with the reason in text.
 */
export function DeliveryRail({ m, compact }: { m: OutboundMessageRow; compact?: boolean }) {
  const steps: { key: 'queued' | 'sent' | 'delivered' | 'read'; at: string | null }[] = [
    { key: 'queued', at: m.createdAt },
    { key: 'sent', at: m.sentAt },
    { key: 'delivered', at: m.deliveredAt },
    ...(m.channel === 'whatsapp' ? [{ key: 'read' as const, at: m.readAt }] : []),
  ];
  const broken = m.status === 'failed' || m.status === 'blocked_limit' || m.status === 'blocked_config' || m.status === 'cancelled';
  const byStatus = steps.findIndex(s => s.key === (m.status === 'sending' ? 'queued' : m.status));
  const reachedIdx = byStatus >= 0 ? byStatus : Math.max(0, steps.map(s => !!s.at).lastIndexOf(true));
  return (
    <ol className={cn('flex items-center', compact ? 'gap-0.5' : 'gap-1')} aria-label={t('msg.rail.label', { status: statusLabel(m.status) })} data-testid="msg-rail" data-status={m.status}>
      {steps.map((s, i) => {
        const done = i <= reachedIdx;
        const isBreak = broken && i === reachedIdx + 1;
        return (
          <li key={s.key} className="flex items-center" title={`${t(`msg.status.${s.key}` as MessageKey)}${s.at ? ` · ${fmtDateTime(s.at)}` : ''}`}>
            {i > 0 && <span className={cn('h-0.5', compact ? 'w-3' : 'w-6', done ? 'bg-success' : isBreak ? 'bg-danger/60' : 'bg-border')} aria-hidden />}
            <span
              className={cn(
                'block rounded-full border-2',
                compact ? 'size-2' : 'size-2.5',
                done ? 'border-success bg-success' : isBreak ? 'border-danger bg-surface' : 'border-border-strong bg-surface',
              )}
              aria-hidden
            />
            <span className="sr-only">{t(`msg.status.${s.key}` as MessageKey)}{done ? ` ${t('msg.rail.done')}` : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Monthly send quota for a channel. Amber from 80%, red at 100%; text carries the value too. */
export function QuotaMeter({ used, limit, channel }: { used: number; limit: number | null; channel: 'email' | 'whatsapp' }) {
  if (limit === null) {
    return <p className="text-sm text-fg-muted" data-testid="send-quota" data-level="ok">{t('send.quota.unlimited', { used: fmtNumber(used), channel: channelLabel(channel) })}</p>;
  }
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
  const level = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : 'ok';
  return (
    <div className="space-y-1" data-testid="send-quota" data-level={level}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-fg-muted">{t('send.quota.label', { channel: channelLabel(channel) })}</span>
        <span className={cn('tabular-nums', level === 'full' ? 'font-medium text-danger' : level === 'warn' ? 'font-medium text-warning' : 'text-fg-muted')}>
          {t('send.quota.value', { used: fmtNumber(used), limit: fmtNumber(limit) })}
        </span>
      </div>
      <div role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-valuetext={t('send.quota.value', { used: fmtNumber(used), limit: fmtNumber(limit) })}
        aria-label={t('send.quota.label', { channel: channelLabel(channel) })} className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', level === 'full' ? 'bg-danger' : level === 'warn' ? 'bg-warning-bar' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
      {level === 'full' && <p className="text-xs text-danger">{t('send.quota.full')}</p>}
    </div>
  );
}

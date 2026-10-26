'use client';
import type { DocTypeSummary } from '@procure/schema';
import { cn, StatusBadge, type BadgeTone } from '@procure/ui';
import { t } from '@/i18n';
import { dec, fmtQty } from './decimal';

const TONE: Record<DocTypeSummary['statuses'][number]['tone'], BadgeTone> = {
  neutral: 'neutral', blue: 'accent', amber: 'warning', green: 'success', red: 'danger',
};

export function statusTone(key: string, docType?: DocTypeSummary | null): BadgeTone {
  const s = docType?.statuses.find(x => x.key === key);
  if (s) return TONE[s.tone] ?? 'neutral';
  if (key.startsWith('waiting_')) return 'accent';
  switch (key) {
    case 'approved': return 'success';
    case 'rejected': return 'danger';
    case 'on_hold': case 'partially_approved': return 'warning';
    default: return 'neutral';
  }
}

export function DocStatusBadge({ statusKey, label, docType, className }: { statusKey: string; label: string; docType?: DocTypeSummary | null; className?: string }) {
  return <StatusBadge tone={statusTone(statusKey, docType)} className={className} data-status={statusKey}>{label}</StatusBadge>;
}

/** Compact "pending" pill for item-wise rows: amber when something waits, quiet dash otherwise. */
export function PendingPill({ value, testId }: { value: string; testId?: string }) {
  const has = dec.gt0(value);
  return (
    <span
      data-testid={testId}
      data-value={dec.norm(value)}
      className={cn('inline-flex min-w-10 justify-end rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums', has ? 'bg-warning-soft text-warning' : 'text-fg-subtle')}
      title={has ? t('docs.qty.pendingApproval') : undefined}
    >
      {has ? fmtQty(value) : '0'}
    </span>
  );
}

/** Right-aligned quantity cell; zero renders muted so the eye lands on the numbers that matter. */
export function QtyCell({ value, testId, tone }: { value: string | null | undefined; testId?: string; tone?: 'success' | 'warning' | 'danger' }) {
  const zero = !value || dec.isZero(value);
  return (
    <span data-testid={testId} data-value={dec.norm(value ?? '0')}
      className={cn('tabular-nums', zero ? 'text-fg-subtle' : tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-fg')}>
      {zero ? '0' : fmtQty(value)}
    </span>
  );
}

import type { Buckets } from './qty';
import { pendingApproval } from './qty';

/**
 * Status computation (contract "Status computation", pure). Line status from the ledger buckets plus where the
 * line's remaining quantity sits in the workflow; document status from its lines.
 */
export const OUTCOME_STATUSES = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'] as const;

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', on_hold: 'On hold', partially_approved: 'Partially approved', approved: 'Approved', rejected: 'Rejected',
  cancelled: 'Cancelled', closed: 'Closed',
};
export const STATUS_TONES: Record<string, 'neutral' | 'blue' | 'amber' | 'green' | 'red'> = {
  draft: 'neutral', on_hold: 'amber', partially_approved: 'amber', approved: 'green', rejected: 'red', cancelled: 'neutral', closed: 'neutral',
};

export const waitingKey = (stage: string) => `waiting_${stage}`;
export const stageOfStatus = (status: string) => (status.startsWith('waiting_') ? status.slice('waiting_'.length) : null);

export function humanize(key: string): string {
  const s = key.replace(/_/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : key;
}

export interface LineState {
  buckets: Buckets;
  /** stage -> pending/held quantity units still in the workflow. */
  stages: Record<string, { pending: bigint; held: bigint }>;
}

/** Stages ordered by the workflow; unknown stages after known ones (alphabetical). */
function earliest(stages: string[], order: string[]): string | null {
  if (!stages.length) return null;
  const rank = (s: string) => (order.includes(s) ? order.indexOf(s) : order.length);
  return [...stages].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0]!;
}

export function lineStatus(l: LineState, stageOrder: string[], docClosed: boolean): string {
  const b = l.buckets;
  const pendingStages = Object.entries(l.stages).filter(([, v]) => v.pending > 0n).map(([k]) => k);
  const first = earliest(pendingStages, stageOrder);
  if (first) return waitingKey(first);
  if (Object.values(l.stages).some(v => v.held > 0n)) return 'on_hold';
  const live = b.requested + b.over_approved;
  if (live > 0n && b.cancelled >= live) return 'cancelled';
  if (docClosed) return 'closed';
  if (b.short_closed > 0n && b.approved + b.over_approved - b.ordered - b.short_closed <= 0n && b.approved > 0n) return 'closed';
  if (b.held > 0n && pendingApproval(b) > 0n) return 'on_hold';
  if (b.approved === 0n) return 'rejected';
  if (b.approved < b.requested - b.cancelled) return 'partially_approved';
  return 'approved';
}

export interface DocState {
  submitted: boolean;
  cancelled: boolean;
  closed: boolean;
}

export function documentStatus(d: DocState, lineStatuses: string[], stageOrder: string[]): string {
  if (!d.submitted) return 'draft';
  const waiting = lineStatuses.map(stageOfStatus).filter((s): s is string => !!s);
  const first = earliest(waiting, stageOrder);
  if (first) return waitingKey(first);
  if (lineStatuses.includes('on_hold')) return 'on_hold';
  if (d.cancelled) return 'cancelled';
  if (d.closed) return 'closed';
  const live = lineStatuses.filter(s => s !== 'cancelled');
  if (!live.length) return lineStatuses.length ? 'cancelled' : 'approved';
  const approvedish = live.filter(s => s === 'approved' || s === 'closed').length;
  const rejected = live.filter(s => s === 'rejected').length;
  if (live.includes('partially_approved') || (approvedish > 0 && rejected > 0)) return 'partially_approved';
  if (live.every(s => s === 'closed')) return 'closed';
  if (approvedish === live.length) return 'approved';
  if (rejected === live.length) return 'rejected';
  return 'partially_approved';
}

/** Label for a status key: workflow stage labels for waiting_<stage>, fixed labels otherwise. */
export function statusLabel(key: string, stageLabels: Record<string, string>): string {
  const stage = stageOfStatus(key);
  if (stage) return stageLabels[key] ?? `Waiting for ${humanize(stage)}`;
  return STATUS_LABELS[key] ?? humanize(key);
}

/**
 * Line decision drafts for the approval screen. Pure functions over decimal strings (exact; see documents/decimal).
 * Rule from the contract: approve + hold + reject = the line's pending qty at the stage. All three zero = leave the
 * line pending (not sent). Hold, reject and reductions need a reason.
 */
import { dec, isDecimal } from '@/features/documents/decimal';

export type Bucket = 'approve' | 'hold' | 'reject';
export const BUCKETS: Bucket[] = ['approve', 'hold', 'reject'];

export interface LineDraft {
  lineId: string;
  lineNo: number;
  pending: string;
  approve: string;
  hold: string;
  reject: string;
  reason: string;
  /** Values for the stage's editable line fields. */
  values?: Record<string, unknown>;
}

export type Outcome = 'skip' | 'approve' | 'hold' | 'reject' | 'reduce' | 'mixed';

export function initDraft(lineId: string, lineNo: number, pending: string): LineDraft {
  const p = dec.norm(pending);
  return { lineId, lineNo, pending: p, approve: p, hold: '0', reject: '0', reason: '' };
}

/** Whole pending qty into one bucket (quick buttons A / H / R). */
export function setWhole(d: LineDraft, b: Bucket): LineDraft {
  return { ...d, approve: b === 'approve' ? d.pending : '0', hold: b === 'hold' ? d.pending : '0', reject: b === 'reject' ? d.pending : '0' };
}

export function skip(d: LineDraft): LineDraft {
  return { ...d, approve: '0', hold: '0', reject: '0' };
}

/**
 * Typing a quantity keeps the line balanced: approving or holding less moves the remainder to reject (a reduction);
 * rejecting less moves the remainder to approve. Invalid or oversized input is kept as typed and flagged.
 */
export function setQty(d: LineDraft, b: Bucket, raw: string): LineDraft {
  const next = { ...d, [b]: raw } as LineDraft;
  if (!isDecimal(raw) || dec.cmp(raw, d.pending) > 0) return next;
  if (b === 'reject') {
    const rest = dec.sub(dec.sub(d.pending, raw), isDecimal(next.hold) ? next.hold : '0');
    if (dec.cmp(rest, '0') >= 0) next.approve = rest;
  } else {
    const other = b === 'approve' ? next.hold : next.approve;
    const rest = dec.sub(dec.sub(d.pending, raw), isDecimal(other) ? other : '0');
    if (dec.cmp(rest, '0') >= 0) next.reject = rest;
  }
  return next;
}

export function outcome(d: LineDraft): Outcome {
  const a = dec.gt0(d.approve); const h = dec.gt0(d.hold); const r = dec.gt0(d.reject);
  if (!a && !h && !r) return 'skip';
  if (a && !h && !r) return 'approve';
  if (!a && h && !r) return 'hold';
  if (!a && !h && r) return 'reject';
  if (a && r && !h) return 'reduce';
  return 'mixed';
}

export function needsReason(d: LineDraft): boolean {
  return dec.gt0(d.hold) || dec.gt0(d.reject);
}

export type DraftError = 'number' | 'sum' | 'reason' | 'hold_not_allowed' | 'reject_not_allowed' | 'partial_not_allowed';

/** First problem with a draft (null = OK). `actions` = the stage's configured actions. */
export function draftError(d: LineDraft, actions: readonly string[]): DraftError | null {
  for (const b of BUCKETS) if (!isDecimal(d[b] || '0')) return 'number';
  if (outcome(d) === 'skip') return null;
  if (dec.cmp(dec.add(d.approve, d.hold, d.reject), d.pending) !== 0) return 'sum';
  // Mirrors the engine: each non-zero bucket needs its action at the stage (a reduction is approve + reject).
  if (dec.gt0(d.hold) && !actions.includes('hold')) return 'hold_not_allowed';
  if (dec.gt0(d.reject) && !actions.includes('reject')) return dec.gt0(d.approve) ? 'partial_not_allowed' : 'reject_not_allowed';
  if (needsReason(d) && d.reason.trim().length < 3) return 'reason';
  return null;
}

export interface Summary {
  approve: number; hold: number; reject: number; reduced: number; skip: number;
  /** Reduced quantity per unit: { kg: '100' }. */
  reducedQty: Record<string, string>;
}

export function summarize(drafts: LineDraft[], uomOf: (lineId: string) => string): Summary {
  const s: Summary = { approve: 0, hold: 0, reject: 0, reduced: 0, skip: 0, reducedQty: {} };
  for (const d of drafts) {
    const o = outcome(d);
    if (o === 'skip') { s.skip++; continue; }
    if (dec.gt0(d.approve)) s.approve++;
    if (dec.gt0(d.hold)) s.hold++;
    if (!dec.gt0(d.approve) && dec.gt0(d.reject)) s.reject++;
    if (dec.gt0(d.approve) && dec.gt0(d.reject)) {
      s.reduced++;
      const u = uomOf(d.lineId);
      s.reducedQty[u] = dec.add(s.reducedQty[u] ?? '0', d.reject);
    }
  }
  return s;
}

/** Body lines for POST …/actions (skipped lines are not sent; they stay pending). */
export function toDecisions(drafts: LineDraft[]) {
  return drafts.filter(d => outcome(d) !== 'skip').map(d => ({
    lineId: d.lineId,
    approve: dec.norm(d.approve || '0'),
    hold: dec.norm(d.hold || '0'),
    reject: dec.norm(d.reject || '0'),
    ...(d.reason.trim() ? { reason: d.reason.trim() } : {}),
    ...(d.values && Object.keys(d.values).length ? { values: d.values } : {}),
  }));
}

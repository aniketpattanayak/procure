import type { QuantityBuckets } from '@procure/schema';

/**
 * Exact quantity arithmetic for the ledger (numeric(18,4) in the database). Quantities are held as bigint units of
 * 1/10000 so no float ever touches a stored figure.
 */
export const QTY_SCALE = 4;
const SCALE = 10n ** BigInt(QTY_SCALE);
const RE = /^(-)?(\d{1,14})(?:\.(\d{1,4}))?$/;

export function isQty(v: unknown): v is string {
  return typeof v === 'string' && RE.test(v.trim());
}

/** Parses a decimal string (at most 4 decimals) into units; throws on anything else. */
export function toUnits(v: string | number | null | undefined): bigint {
  if (v === null || v === undefined || v === '') return 0n;
  const s = typeof v === 'number' ? String(v) : v.trim();
  const m = RE.exec(s) ?? /^(-)?(\d+)\.(\d{1,4})0*$/.exec(s);
  if (!m) throw new Error(`invalid quantity "${s}"`);
  const n = BigInt(m[2]!) * SCALE + BigInt((m[3] ?? '').padEnd(QTY_SCALE, '0') || '0');
  return m[1] ? -n : n;
}

/** Canonical decimal string: no trailing zeros ("12.5", "3", "0"). */
export function fromUnits(u: bigint): string {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const int = a / SCALE;
  const frac = (a % SCALE).toString().padStart(QTY_SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Normalises a stored numeric ("10.5000") to canonical form ("10.5"). */
export const qty = (v: string | number | null | undefined): string => fromUnits(toUnits(v));

export const BUCKETS = [
  'requested', 'approved', 'held', 'rejected', 'cancelled', 'short_closed', 'over_approved', 'selected', 'ordered',
  'received', 'accepted', 'rejected_at_receipt', 'issued', 'returned',
] as const;
export type Bucket = (typeof BUCKETS)[number];
export type Buckets = Record<Bucket, bigint>;

export const emptyBuckets = (): Buckets => Object.fromEntries(BUCKETS.map(b => [b, 0n])) as Buckets;

export function bucketsFromRow(r: Partial<Record<Bucket, string | number | null>> | null | undefined): Buckets {
  const b = emptyBuckets();
  if (r) for (const k of BUCKETS) b[k] = toUnits(r[k] ?? 0);
  return b;
}

/** Ledger event type -> (bucket, sign). */
export const EVENT_EFFECT: Record<string, [Bucket, 1n | -1n]> = {
  requested: ['requested', 1n], approved: ['approved', 1n], held: ['held', 1n], unheld: ['held', -1n],
  rejected: ['rejected', 1n], cancelled: ['cancelled', 1n], short_closed: ['short_closed', 1n], over_approved: ['over_approved', 1n],
  over_approval_cancelled: ['over_approved', -1n], // QA47-BUG-001: over-approval no longer needed after a selection cut
  selected: ['selected', 1n], selection_cancelled: ['selected', -1n], ordered: ['ordered', 1n], order_cancelled: ['ordered', -1n],
  received: ['received', 1n], accepted: ['accepted', 1n], rejected_at_receipt: ['rejected_at_receipt', 1n], issued: ['issued', 1n],
  returned: ['returned', 1n],
};

/** Applies one event; returns the violated bucket (negative, or 'approved' when the approval cap is exceeded) or null. */
export function applyEvent(b: Buckets, type: string, q: bigint): Bucket | 'invariant' | null {
  const eff = EVENT_EFFECT[type];
  if (!eff) return 'invariant';
  const [bucket, sign] = eff;
  b[bucket] += sign * q;
  if (b[bucket] < 0n) return bucket;
  if (b.approved + b.rejected + b.cancelled > b.requested + b.over_approved) return bucket;
  return null;
}

/** Qty still in approval: requested − approved − rejected − cancelled (includes held). Over-approval happens
 *  after approval (at vendor selection) and never re-opens approval, so it is excluded (Phase 4 decision). */
export const pendingApproval = (b: Buckets) => b.requested - b.approved - b.rejected - b.cancelled;
/** approved + overApproved − ordered − shortClosed (contract; equals approved for custom types). */
export const pendingOrder = (b: Buckets) => {
  const v = b.approved + b.over_approved - b.ordered - b.short_closed;
  return v < 0n ? 0n : v;
};

/** Phase 5: ordered − received + rejected at receipt (goods sent back before they entered stock re-open the line);
 *  with `includeReturned`, returns to vendor re-open it too (setting rtv.reopens_po). Never negative. */
export const pendingReceipt = (b: Pick<Buckets, 'ordered' | 'received' | 'rejected_at_receipt' | 'returned'>, includeReturned = false) => {
  if (b.ordered <= 0n) return 0n; // only ordered lines (PO) have a pending receipt
  const v = b.ordered - b.received + b.rejected_at_receipt + (includeReturned ? b.returned : 0n);
  return v < 0n ? 0n : v;
};

/** `returnsReopen`: the tenant setting rtv.reopens_po (callers read it once per request). */
export function toQuantityBuckets(b: Buckets, opts: { returnsReopen?: boolean } = {}): QuantityBuckets {
  const pa = pendingApproval(b);
  const pr = pendingReceipt(b, opts.returnsReopen ?? false);
  return {
    requested: fromUnits(b.requested), approved: fromUnits(b.approved), held: fromUnits(b.held), rejected: fromUnits(b.rejected),
    cancelled: fromUnits(b.cancelled), shortClosed: fromUnits(b.short_closed), overApproved: fromUnits(b.over_approved),
    selected: fromUnits(b.selected), ordered: fromUnits(b.ordered), received: fromUnits(b.received), accepted: fromUnits(b.accepted),
    rejectedAtReceipt: fromUnits(b.rejected_at_receipt), issued: fromUnits(b.issued), returned: fromUnits(b.returned),
    pendingApproval: fromUnits(pa < 0n ? 0n : pa), pendingOrder: fromUnits(pendingOrder(b)), pendingReceipt: fromUnits(pr < 0n ? 0n : pr),
  };
}

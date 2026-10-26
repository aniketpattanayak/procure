import type { StockPost, StockStatus } from '@procure/schema';

/** Zero uuid used as `batch_key` for non-batch stock (migration 0015). */
export const NO_BATCH = '00000000-0000-0000-0000-000000000000';

/** Module feature key of the store documents / stock tab. */
export const STOCK_FEATURE = 'store';

/** Movement types that only change the status of stock at one node (no valuation change at the node). */
export const STATUS_MOVES: ReadonlySet<StockPost['movementType']> = new Set(['block', 'unblock', 'reject']);

/**
 * What StockLedger.post accepts: a StockPost plus ledger-only hints.
 * - `sourceMovementId` (QA5-BUG-001, specific identification): on the out-side of an `rtv` or a status move
 *   (block / unblock / reject), the receipt movement whose goods are leaving. The out is valued at that movement's
 *   unit cost (WAC: the node keeps its own cost; FIFO: that receipt's layer is consumed first) instead of the node
 *   average / oldest layers.
 */
export type LedgerPost = StockPost & { sourceMovementId?: string | null };

/** One movement written (or found, for a repeated idempotency key) by StockLedger.post. */
export interface PostedMovement {
  id: string;
  itemId: string;
  nodeId: string;
  batchId: string | null;
  status: StockStatus;
  movementType: StockPost['movementType'];
  qtyIn: string;
  qtyOut: string;
  unitCost: string;
  /** Signed: + in, − out. */
  value: string;
  pairId: string | null;
  idempotencyKey: string | null;
  /** True when the idempotency key already existed and nothing was written for this post. */
  duplicate: boolean;
}

export interface PostOptions {
  /** Movement timestamp (defaults to now()); opening balances use their `asOf` date. */
  at?: Date;
  /** Skip the re-order check (bulk opening loads). */
  skipReorder?: boolean;
}

export interface BatchInput {
  itemId: string;
  batchNo: string;
  mfgDate?: string | null;
  expiryDate?: string | null;
  vendorId?: string | null;
}

/** Error codes thrown by the ledger (AppError 409 unless noted). */
export const STOCK_ERRORS = {
  negative: 'STOCK_NEGATIVE',               // meta { itemId, nodeId, batchId, status, available, requested }
  invalid: 'STOCK_INVALID_POST',            // 400
  valuationLocked: 'STOCK_VALUATION_LOCKED', // changing stock.valuation inside a financial year with movements
  openingExists: 'STOCK_OPENING_EXISTS',
  noHandler: 'STOCK_EFFECT_UNSUPPORTED',
} as const;

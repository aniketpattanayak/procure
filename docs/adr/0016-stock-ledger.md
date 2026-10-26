# ADR-0016 Stock as an append-only movement ledger

Status: Accepted (Phase 5)

## Context
Stock must support partial receipts, multi-stage verification (gate → store → QA), blocking/quarantine,
returns to vendor, transfers, adjustments, physical counts, issue and return — across an unlimited location tree,
with WAC or FIFO valuation and a full audit trail. Clients differ in which stage posts stock and which blocks it.

## Decision
1. `app.stock_movement` is append-only (UPDATE/DELETE revoked from app roles). Corrections are `reversal` rows.
2. `app.stock_balance` (item × node × batch × status) and `item_avg_cost` / `valuation_layer` are maintained in the
   SAME transaction by `StockLedger.post`, the single write path. Rows are locked in key order to avoid deadlocks.
3. Status changes (block, unblock, reject) and transfers are paired movements sharing a `pair_id`.
4. Valuation method is a tenant setting fixed per financial year; outs are valued by the ledger, never the caller.
5. Every stock transaction is a system document type on the documents core; whether and when it touches stock is
   decided by workflow effects (`post_stock`, `block_stock`, `unblock_stock`, `return_to_vendor`) chosen in the
   tenant's workflow definition — no per-client code.
6. Idempotency keys on movements make effects safe to retry.
7. A nightly drift check recomputes sampled balances from the ledger.

## Consequences
+ Any balance at any date is reproducible from the ledger; full auditability.
+ The verification chain is configuration.
− Balance rows are hot spots for very busy items; acceptable at target scale (row locks are short).
− Changing valuation method requires a new financial year.

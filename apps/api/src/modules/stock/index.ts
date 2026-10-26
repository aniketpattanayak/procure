/**
 * Public surface of the stock module (Phase 5, ADR-0016). Other modules import only from here.
 *
 * GRN / issue module usage:
 *   - import { StockModule } in your Nest module (it exports StockLedger, StockPostingHandlers, StockInstaller …);
 *   - post stock ONLY through `StockLedger.post(tx, posts, actorId)` inside your transaction;
 *   - register per-doc-type handlers for the workflow effects in onModuleInit:
 *       handlers.register('grn', 'post_stock', async ctx => [...StockPost]);   // also 'block_stock' / 'unblock_stock'
 *     use `ctx.key(lineId, …)` as idempotencyKey and `ctx.approved` / `ctx.rejected` for decided qty;
 *   - `return_to_vendor` is yours to register on EFFECT_REGISTRY.
 */
export { StockModule } from './stock.module';
// ---- ledger (stable interface)
export { StockLedger } from './ledger/stock-ledger.service';
export type { BatchInput, LedgerPost, PostedMovement, PostOptions } from './ledger/types';
export { NO_BATCH, STATUS_MOVES, STOCK_ERRORS, STOCK_FEATURE } from './ledger/types';
export { ReorderService } from './ledger/reorder.service';
// ---- workflow effect dispatch (stable interface)
export { StockPostingHandlers } from './posting/handlers';
export type { StockEffectName, StockPostingCtx, StockPostingHandler } from './posting/handlers';
export { StockEffects, genericStatusMove, uuidFrom } from './posting/stock-effects';
// ---- store documents
export { StockInstaller } from './docs/store-handlers';
export { resolveBatch } from './docs/batch';
export { STOCK_TRANSFER, STOCK_ADJUSTMENT, STOCK_COUNT, TRANSFER_SPEC, ADJUSTMENT_SPEC, COUNT_SPEC } from './docs/store-types';
// ---- read side / jobs / reports
export { StockQueryService, canSeeValue, heldStatuses } from './api/stock-query.service';
export type { StockActor } from './api/stock-query.service';
export { StockDriftCheck, STOCK_QUEUE } from './jobs/drift-check';
export { stockBalanceSource, stockLedgerSource } from './reports/stock-sources';
export { D as StockDecimal, q4, c6 } from './ledger/decimal';

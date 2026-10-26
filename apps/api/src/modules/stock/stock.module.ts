import { Module, OnModuleInit } from '@nestjs/common';
import { ProcurementModule } from '../procurement';
import { registerSource } from '../reports';
import { StockCommandService } from './api/stock-command.service';
import { StockQueryService } from './api/stock-query.service';
import { StockController } from './api/stock.controller';
import { StockInstaller } from './docs/store-handlers';
import { StockDriftCheck } from './jobs/drift-check';
import { ReorderService } from './ledger/reorder.service';
import { StockLedger } from './ledger/stock-ledger.service';
import { ValuationGuard } from './ledger/valuation-guard';
import { StockPostingHandlers } from './posting/handlers';
import { StockEffects } from './posting/stock-effects';
import { stockBalanceSource, stockLedgerSource } from './reports/stock-sources';

/**
 * Stock (Phase 5, ADR-0016): movement ledger (the only write path), workflow effects post/block/unblock_stock with a
 * per-doc-type handler registry, store documents (transfer, adjustment, count), stock endpoints, report sources and
 * the nightly drift check. The GRN / issue module imports StockLedger + StockPostingHandlers from the index.
 */
@Module({
  imports: [ProcurementModule],
  controllers: [StockController],
  providers: [
    StockLedger, ReorderService, StockPostingHandlers, StockEffects, ValuationGuard, StockInstaller, StockQueryService, StockCommandService, StockDriftCheck,
  ],
  exports: [StockLedger, StockPostingHandlers, StockInstaller, StockQueryService, ReorderService, StockEffects],
})
export class StockModule implements OnModuleInit {
  onModuleInit() {
    registerSource(stockBalanceSource());
    registerSource(stockLedgerSource());
  }
}

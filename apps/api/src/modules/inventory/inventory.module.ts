import { Module, OnModuleInit } from '@nestjs/common';
import { FormsModule } from '../forms';
import { ProcurementModule } from '../procurement';
import { registerSource } from '../reports';
import { StockModule } from '../stock';
import { GrnController } from './grn/grn.controller';
import { GrnHooks } from './grn/grn-hooks';
import { GrnLinesService } from './grn/grn-lines.service';
import { GrnShortCloseService } from './grn/grn-short-close.service';
import { GrnStock } from './grn/grn-stock';
import { ReceiptLedger } from './grn/receipts';
import { receiptsSource } from './grn/receipts.source';
import { RtvService } from './grn/rtv.service';
import { InventoryInstaller } from './installer';
import { IssueController } from './issue/issue.controller';
import { IssueHooks } from './issue/issue-hooks';
import { IssueLinesService } from './issue/issue-lines.service';
import { IssueStock } from './issue/issue-stock';

/**
 * Inventory documents (Phase 5): GRN + RTV (grn/) and issue request / store issue / store return (issue/) as system
 * document types on the documents core. Stock moves only through the stock module's posting handlers + StockLedger.
 */
@Module({
  imports: [FormsModule, ProcurementModule, StockModule],
  controllers: [GrnController, IssueController],
  providers: [InventoryInstaller, ReceiptLedger, GrnHooks, GrnLinesService, GrnShortCloseService, RtvService, GrnStock, IssueHooks, IssueLinesService, IssueStock],
  exports: [ReceiptLedger, GrnLinesService, RtvService, IssueLinesService],
})
export class InventoryModule implements OnModuleInit {
  onModuleInit() {
    registerSource(receiptsSource());
  }
}

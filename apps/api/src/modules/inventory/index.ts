/** Public surface of the inventory module (Phase 5: GRN / RTV / issue / return). Other modules import only from here. */
export { InventoryModule } from './inventory.module';
export { InventoryInstaller, PO_RECEIPT_VIEWS, withoutStock, NO_STOCK_NOTE_SUFFIX } from './installer';
export { GRN, RTV, GRN_SPEC, RTV_SPEC, GRN_LINE, RTV_LINE } from './grn/grn.types';
export { ISSUE_REQUEST, STORE_ISSUE, STORE_RETURN, ISSUE_LINE, RETURN_LINE } from './issue/issue.types';
export { ReceiptLedger, netReceived, pendingReceipt } from './grn/receipts';
export { GrnLinesService, ReceivableQuery } from './grn/grn-lines.service';
export { RtvService, RtvFromGrn, ReturnableGrnQuery } from './grn/rtv.service';
export type { ReturnableGrnLine } from './grn/rtv.service';
export { IssueLinesService, IssueFromRequests, ReturnFromIssues, IssuableQuery, ReturnableQuery } from './issue/issue-lines.service';
export { receiptsSource } from './grn/receipts.source';

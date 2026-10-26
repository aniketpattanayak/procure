/** Public surface of the procurement module (Phase 4). Other modules import only from here. */
export { ProcurementModule } from './procurement.module';
// --- agent A
export { ProcurementInstaller } from './installer/installer.service';
export type { InstallContext, InstallStep } from './installer/install-steps';
export { SystemTypeInstaller } from './installer/system-type';
export type { ExtraKey, SystemTypeSpec } from './installer/system-type';
export { FEATURE, INDENT, SELECTION, DEPARTMENT_MASTER, INDENT_SPEC, SELECTION_SPEC } from './installer/a-steps';
export { IndentLines, selectable, orderableFromIndent, isOpen, qtyExceeds, QTY_BUCKETS } from './indent/indent-lines';
export type { IndentLine, LineBuckets } from './indent/indent-lines';
export { QuotesService } from './quotes/quotes.service';
export { ComparisonService } from './quotes/comparison.service';
export { SelectionService, OVER_APPROVE_KEY } from './selection/selection.service';
export { effectiveRate, freightPerUnit, landedCost, validateSlabs, DEFAULT_LANDED_FORMULA } from './quotes/slabs';
export { vendorQuoteSource } from './quotes/report-source';
export type { VendorQuoteSourceDef } from './quotes/report-source';
export { procActor } from './indent/actor';
// --- agent B
export { PO, PO_SPEC, AMENDING, PURCHASE_FEATURE } from './po/po.type';
export { PoLedger } from './po/po-ledger';
export { PoDerived } from './po/po-derived';
export { computeGst } from './tax/gst';
export type { GstInput, GstResult, GstTotals } from './tax/gst';
export { TAX_MASTER, GST_CODES } from './tax/tax.install';
export { poFollowupSource } from './followups/followup.source';
export { FollowupsService } from './followups/followups.service';
export { PoLinesService } from './po/po-lines.service';
export { RevisionsService } from './revisions/revisions.service';

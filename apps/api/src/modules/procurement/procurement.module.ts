import { Module } from '@nestjs/common';
import { FormsModule } from '../forms';
import { IndentController } from './indent/indent.controller';
import { IndentLines } from './indent/indent-lines';
import { IndentShortCloseService } from './indent/short-close.service';
import { ProcurementSteps } from './installer/a-steps';
import { ProcurementInstaller } from './installer/installer.service';
import { SystemTypeInstaller } from './installer/system-type';
import { ComparisonContextExtension } from './quotes/comparison.extension';
import { ComparisonService } from './quotes/comparison.service';
import { QuotesController } from './quotes/quotes.controller';
import { QuotesService } from './quotes/quotes.service';
import { SelectionController } from './selection/selection.controller';
import { SelectionService } from './selection/selection.service';
// --- agent B
import { FollowupsService } from './followups/followups.service';
import { PoController, PoLinesController } from './po/po.controller';
import { PoDerived } from './po/po-derived';
import { PoHooks } from './po/po-hooks';
import { PoLedger } from './po/po-ledger';
import { PoLinesService } from './po/po-lines.service';
import { PoService } from './po/po.service';
import { RevisionsService } from './revisions/revisions.service';
import { TaxInstallStep } from './tax/tax.install';

/**
 * Procurement (Phase 4, ADR-0013): indent / vendor selection / PO as system document types on the documents core.
 * Agent A: installer/, indent/, quotes/, selection/.  Agent B: po/, tax/, followups/, revisions/.
 * Shared registration point — append providers/controllers; keep both agents' lists separate.
 */
@Module({
  imports: [FormsModule],
  controllers: [
    // --- agent A
    QuotesController, SelectionController, IndentController,
    // --- agent B
    PoLinesController, PoController,
  ],
  providers: [
    // --- agent A
    ProcurementInstaller, SystemTypeInstaller, ProcurementSteps, IndentLines, QuotesService, ComparisonService, ComparisonContextExtension, SelectionService, IndentShortCloseService,
    // --- agent B
    TaxInstallStep, PoDerived, PoLedger, RevisionsService, FollowupsService, PoLinesService, PoService, PoHooks,
  ],
  exports: [ProcurementInstaller, SystemTypeInstaller, IndentLines, QuotesService, ComparisonService, SelectionService, /* agent B */ PoLedger, PoDerived],
})
export class ProcurementModule {}

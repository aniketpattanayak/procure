import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ComparisonSheet, DocumentRow, MyPermissions, VendorQuoteInput, VendorQuoteRow } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../../core/auth/permissions';
import { DbService } from '../../../core/db.service';
import { Zod } from '../../../core/zod';
import { UuidParam } from '../../identity';
import { procActor } from '../indent/actor';
import { ComparisonService } from './comparison.service';
import { QuotesService } from './quotes.service';

const ListQuery = z.object({ all: z.enum(['true', 'false']).optional() });
const LineCompareQuery = z.object({ qty: z.string().regex(/^\d+(\.\d{1,4})?$/).optional() });
const ItemCompareQuery = z.object({ location: z.string().uuid().optional() });

@TenantOnly()
@Controller('procurement')
export class QuotesController {
  constructor(private readonly db: DbService, private readonly quotes: QuotesService, private readonly comparison: ComparisonService) {}

  @Get('indent-lines/:lineId/quotes')
  @Requires('doc.indent:action.view')
  list(@Param('lineId', new UuidParam('Indent line')) lineId: string, @Query(new Zod(ListQuery)) q: z.infer<typeof ListQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<VendorQuoteRow[]> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.quotes.list(tx, a, lineId, q.all === 'true'));
  }

  @Post('indent-lines/:lineId/quotes')
  @Requires('doc.indent:action.log_quote')
  log(@Param('lineId', new UuidParam('Indent line')) lineId: string, @Body(new Zod(VendorQuoteInput)) body: z.infer<typeof VendorQuoteInput>, @CurrentPermissions() perms?: MyPermissions): Promise<VendorQuoteRow[]> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.quotes.log(tx, a, lineId, body));
  }

  @Put('quotes/:quoteId')
  @Requires('doc.indent:action.log_quote')
  revise(@Param('quoteId', new UuidParam('Quote')) quoteId: string, @Body(new Zod(VendorQuoteInput)) body: z.infer<typeof VendorQuoteInput>, @CurrentPermissions() perms?: MyPermissions): Promise<VendorQuoteRow> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.quotes.revise(tx, a, quoteId, body));
  }

  @Get('indent-lines/:lineId/comparison')
  @Requires('doc.indent:action.compare')
  lineComparison(@Param('lineId', new UuidParam('Indent line')) lineId: string, @Query(new Zod(LineCompareQuery)) q: z.infer<typeof LineCompareQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<ComparisonSheet> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.comparison.forLine(tx, a, lineId, q.qty));
  }

  @Get('items/:itemId/comparison')
  @Requires('doc.indent:action.compare')
  itemComparison(@Param('itemId', new UuidParam('Item')) itemId: string, @Query(new Zod(ItemCompareQuery)) q: z.infer<typeof ItemCompareQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<ComparisonSheet> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.comparison.forItem(tx, a, itemId, q.location));
  }
  /**
   * POST /procurement/quotes/:quoteId/approve
   * Requires `doc.indent:action.approve_quote` — available to the vendor_approver role.
   * Creates a vendor_selection document for this quote's line (vendor + rate from the quote) and submits it
   * immediately. If the VS workflow is skipped (auto-approve path), the PO creation flow begins from here.
   * Body: { qty?: string } — quantity to select; defaults to the indent line's full pending qty.
   */
  @Post('quotes/:quoteId/approve')
  @Requires('doc.indent:action.approve_quote')
  approve(
    @Param('quoteId', new UuidParam('Quote')) quoteId: string,
    @Body() body: { qty?: string },
    @CurrentPermissions() perms?: MyPermissions,
  ): Promise<DocumentRow> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.quotes.approveQuote(tx, a, quoteId, body.qty));
  }
}

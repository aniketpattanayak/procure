import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AmendInput, DocumentRow, FollowupInput, FollowupRow, MyPermissions, OrderableLine, Page, PoFromLines, RevisionRow } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../../core/auth/permissions';
import { DbService } from '../../../core/db.service';
import { Zod } from '../../../core/zod';
import { UuidParam } from '../../identity';
import { FollowupsService } from '../followups/followups.service';
import { procActor } from '../indent/actor';
import { RevisionsService } from '../revisions/revisions.service';
import { OrderableQuery, PoLinesService } from './po-lines.service';
import { PoService, PoTaxes, ShortCloseInput } from './po.service';

const DocId = new UuidParam('Document');

/** Procurement endpoints for orderable lines → POs. */
@TenantOnly()
@Controller('procurement')
export class PoLinesController {
  constructor(private readonly db: DbService, private readonly lines: PoLinesService) {}

  @Get('orderable-lines')
  @Requires('doc.po:action.add')
  orderable(@Query(new Zod(OrderableQuery)) q: z.infer<typeof OrderableQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<Page<OrderableLine>> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.lines.orderable(tx, a, q));
  }

  @Post('po/from-lines')
  @Requires('doc.po:action.add')
  fromLines(@Body(new Zod(PoFromLines)) body: z.infer<typeof PoFromLines>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow[]> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.lines.fromLines(tx, a, body));
  }
}

/** PO-specific document endpoints (the generic ones live in the documents core under /docs/:type). */
@TenantOnly()
@Controller('docs/po')
export class PoController {
  constructor(
    private readonly db: DbService, private readonly po: PoService, private readonly followups: FollowupsService, private readonly revisions: RevisionsService,
  ) {}

  @Get(':id/taxes')
  @Requires('doc.po:action.view')
  taxes(@Param('id', DocId) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<PoTaxes> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.po.taxes(tx, a, id));
  }

  @Get(':id/followups')
  @Requires('doc.po:action.view')
  listFollowups(@Param('id', DocId) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<FollowupRow[]> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.followups.list(tx, a, id));
  }

  @Post(':id/followups')
  @Requires('doc.po:action.followup')
  logFollowup(@Param('id', DocId) id: string, @Body(new Zod(FollowupInput)) body: z.infer<typeof FollowupInput>, @CurrentPermissions() perms?: MyPermissions): Promise<FollowupRow> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.followups.log(tx, a, id, body));
  }

  @Post(':id/amend')
  @HttpCode(200)
  @Requires('doc.po:action.amend')
  amend(@Param('id', DocId) id: string, @Body(new Zod(AmendInput)) body: z.infer<typeof AmendInput>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.revisions.amend(tx, a, id, body));
  }

  /** Abandons an amendment that was not resubmitted (values return to the current revision). */
  @Delete(':id/amend')
  @Requires('doc.po:action.amend')
  withdraw(@Param('id', DocId) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.revisions.withdraw(tx, a, id));
  }

  @Get(':id/revisions')
  @Requires('doc.po:action.view')
  listRevisions(@Param('id', DocId) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<RevisionRow[]> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.revisions.list(tx, a, id));
  }

  @Post(':id/short-close')
  @HttpCode(200)
  @Requires('doc.po:action.short_close')
  shortClose(@Param('id', DocId) id: string, @Body(new Zod(ShortCloseInput)) body: z.infer<typeof ShortCloseInput>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.po.shortClose(tx, a, id, body));
  }
}

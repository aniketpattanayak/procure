import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { DocumentRow, GrnFromPo, MyPermissions, Page, ReceivablePoLine } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../../core/auth/permissions';
import { DbService } from '../../../core/db.service';
import { UuidParam } from '../../identity';
import { Zod } from '../../../core/zod';
import { invActor } from '../common';
import { GrnLinesService, ReceivableQuery } from './grn-lines.service';
import { GrnShortCloseInput, GrnShortCloseService } from './grn-short-close.service';
import { ReturnableGrnLine, ReturnableGrnQuery, RtvFromGrn, RtvService } from './rtv.service';

/** GRN / RTV endpoints (contract "GRN and RTV"); the generic document endpoints live under /docs/grn and /docs/rtv. */
@TenantOnly()
@Controller('inventory')
export class GrnController {
  constructor(
    private readonly db: DbService,
    private readonly lines: GrnLinesService,
    private readonly rtv: RtvService,
    private readonly sc: GrnShortCloseService,
  ) {}

  @Get('receivable-po-lines')
  @Requires('doc.grn:action.add')
  receivable(@Query(new Zod(ReceivableQuery)) q: z.infer<typeof ReceivableQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<Page<ReceivablePoLine>> {
    const a = invActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.lines.receivable(tx, a, q));
  }

  @Post('grn/from-po')
  @Requires('doc.grn:action.add')
  fromPo(@Body(new Zod(GrnFromPo)) body: z.infer<typeof GrnFromPo>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow[]> {
    const a = invActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.lines.fromPo(tx, a, body));
  }

  @Get('returnable-grn-lines')
  @Requires('doc.rtv:action.add')
  returnable(@Query(new Zod(ReturnableGrnQuery)) q: z.infer<typeof ReturnableGrnQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<Page<ReturnableGrnLine>> {
    const a = invActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.rtv.returnable(tx, a, q));
  }

  @Post('rtv/from-grn')
  @Requires('doc.rtv:action.add')
  rtvFromGrn(@Body(new Zod(RtvFromGrn)) body: z.infer<typeof RtvFromGrn>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = invActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.rtv.fromGrn(tx, a, body));
  }

  @Post('grn/:id/short-close')
  @HttpCode(200)
  @Requires('doc.grn:action.short_close')
  grnShortClose(@Param('id', new UuidParam('Document')) id: string, @Body(new Zod(GrnShortCloseInput)) body: z.infer<typeof GrnShortCloseInput>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = invActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.sc.shortClose(tx, a, id, body));
  }
}

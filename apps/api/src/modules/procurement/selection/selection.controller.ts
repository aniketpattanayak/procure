import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { DocumentRow, MyPermissions, OrderableLine, Page, SelectionCreate } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../../core/auth/permissions';
import { DbService } from '../../../core/db.service';
import { Zod } from '../../../core/zod';
import { procActor } from '../indent/actor';
import { SelectionService } from './selection.service';

const SelectableQuery = z.object({
  item: z.string().uuid().optional(), location: z.string().uuid().optional(), q: z.string().trim().max(200).optional(), cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@TenantOnly()
@Controller('procurement')
export class SelectionController {
  constructor(private readonly db: DbService, private readonly svc: SelectionService) {}

  @Get('selectable-lines')
  @Requires('doc.vendor_selection:action.add')
  selectable(@Query(new Zod(SelectableQuery)) q: z.infer<typeof SelectableQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<Page<OrderableLine>> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.svc.selectable(tx, a, q));
  }

  @Post('selections')
  @Requires('doc.vendor_selection:action.add')
  create(@Body(new Zod(SelectionCreate)) body: z.infer<typeof SelectionCreate>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.svc.create(tx, a, body));
  }
}

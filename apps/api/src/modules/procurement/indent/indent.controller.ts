import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { DocumentRow, MyPermissions } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../../core/auth/permissions';
import { DbService } from '../../../core/db.service';
import { Zod } from '../../../core/zod';
import { UuidParam } from '../../identity';
import { procActor } from './actor';
import { IndentShortCloseService } from './short-close.service';

export const ShortCloseInput = z.object({ reason: z.string().trim().min(3).max(500), lineIds: z.array(z.string().uuid()).max(1000).optional() });

@TenantOnly()
@Controller('docs/indent')
export class IndentController {
  constructor(private readonly db: DbService, private readonly svc: IndentShortCloseService) {}

  @Post(':id/short-close')
  @HttpCode(200)
  @Requires('doc.indent:action.short_close')
  shortClose(@Param('id', new UuidParam('Document')) id: string, @Body(new Zod(ShortCloseInput)) body: z.infer<typeof ShortCloseInput>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = procActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.svc.shortClose(tx, a, id, body));
  }
}

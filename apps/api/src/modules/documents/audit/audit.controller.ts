import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { AuditCheckRow, AuditQuery, AuditRow, Page } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../../core/auth/decorators';
import { Requires } from '../../../core/auth/permissions';
import { DbService } from '../../../core/db.service';
import { tenantPrincipal } from '../../../core/request-context';
import { Zod } from '../../../core/zod';
import { AuditQueryService } from './audit-query.service';
import { AuditVerifier } from './audit-verifier';

@TenantOnly()
@Controller('audit')
export class AuditController {
  constructor(private readonly db: DbService, private readonly query: AuditQueryService, private readonly verifier: AuditVerifier) {}

  @Get()
  @Requires('admin.audit:action.view')
  list(@Query(new Zod(AuditQuery)) q: z.infer<typeof AuditQuery>): Promise<Page<AuditRow>> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.query.list(tx, p.tenantId, q));
  }

  @Get('checks')
  @Requires('admin.audit:action.view')
  checks(): Promise<AuditCheckRow[]> {
    return this.verifier.recentChecks(tenantPrincipal().tenantId);
  }

  @Post('checks')
  @HttpCode(201)
  @Requires('admin.audit:action.verify')
  run(): Promise<AuditCheckRow> {
    return this.verifier.verifyTenant(tenantPrincipal().tenantId);
  }
}

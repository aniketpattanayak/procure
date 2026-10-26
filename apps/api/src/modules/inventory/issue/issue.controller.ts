import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { DocumentRow, IssuableLine, MyPermissions, Page, ReturnableLine } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../../core/auth/permissions';
import { DbService } from '../../../core/db.service';
import { Zod } from '../../../core/zod';
import { invActor } from '../common';
import { IssuableQuery, IssueFromRequests, IssueLinesService, ReturnableQuery, ReturnFromIssues } from './issue-lines.service';

/** Issue / return endpoints (contract "Issue and return"); generic document endpoints live under /docs/<type>. */
@TenantOnly()
@Controller('inventory')
export class IssueController {
  constructor(private readonly db: DbService, private readonly lines: IssueLinesService) {}

  @Get('issuable-lines')
  @Requires('doc.store_issue:action.add')
  issuable(@Query(new Zod(IssuableQuery)) q: z.infer<typeof IssuableQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<Page<IssuableLine>> {
    const a = invActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.lines.issuable(tx, a, q));
  }

  @Post('issues/from-requests')
  @Requires('doc.store_issue:action.add')
  fromRequests(@Body(new Zod(IssueFromRequests)) body: z.infer<typeof IssueFromRequests>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = invActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.lines.fromRequests(tx, a, body));
  }

  @Get('returnable-lines')
  @Requires('doc.store_return:action.add')
  returnable(@Query(new Zod(ReturnableQuery)) q: z.infer<typeof ReturnableQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<Page<ReturnableLine>> {
    const a = invActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.lines.returnable(tx, a, q));
  }

  @Post('returns/from-issues')
  @Requires('doc.store_return:action.add')
  fromIssues(@Body(new Zod(ReturnFromIssues)) body: z.infer<typeof ReturnFromIssues>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = invActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.lines.fromIssues(tx, a, body));
  }
}

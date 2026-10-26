import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import {
  ErrorCode, InboxCounts, MyPermissions, SimulateInput, SimulateResult, WorkflowActionInput, WorkflowDetail, WorkflowDraftSave, WorkflowPublish,
} from '@procure/schema';
import { z } from 'zod';
import { RequiresFeature, TenantOnly } from '../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../core/auth/permissions';
import { DbService } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { AppError } from '../../core/errors';
import { tenantPrincipal } from '../../core/request-context';
import { Zod } from '../../core/zod';
import { DefinitionsService } from './definitions.service';
import { DocumentRowBuilder } from './document-row';
import { EngineService } from './engine.service';
import { InboxService } from './inbox.service';

const TYPE_KEY = /^[a-z][a-z0-9_]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const typeOf = (k: string) => { if (!TYPE_KEY.test(k)) throw AppError.notFound('Document type'); return k; };

@TenantOnly()
@Controller('config/workflows')
export class ConfigWorkflowsController {
  constructor(private readonly db: DbService, private readonly defs: DefinitionsService, private readonly ent: EntitlementsService) {}

  @Get()
  @Requires('config.workflows:action.view')
  list() {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.defs.list(tx));
  }

  @Get(':docType')
  @Requires('config.workflows:action.view')
  detail(@Param('docType') t: string): Promise<WorkflowDetail> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.defs.detail(tx, p.tenantId, typeOf(t), p.userId));
  }

  @Put(':docType/draft')
  @RequiresFeature('workflow_designer')
  @Requires('config.workflows:action.edit')
  saveDraft(@Param('docType') t: string, @Body(new Zod(WorkflowDraftSave)) body: z.infer<typeof WorkflowDraftSave>): Promise<WorkflowDetail> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.defs.saveDraft(tx, p.tenantId, p.userId, typeOf(t), body.definition, body.version));
  }

  @Delete(':docType/draft')
  @RequiresFeature('workflow_designer')
  @Requires('config.workflows:action.edit')
  discardDraft(@Param('docType') t: string): Promise<WorkflowDetail> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.defs.discardDraft(tx, p.tenantId, p.userId, typeOf(t)));
  }

  @Post(':docType/publish')
  @HttpCode(200)
  @RequiresFeature('workflow_designer')
  @Requires('config.workflows:action.publish')
  async publish(@Param('docType') t: string, @Body(new Zod(WorkflowPublish)) body: z.infer<typeof WorkflowPublish>): Promise<WorkflowDetail> {
    const p = tenantPrincipal();
    const out = await this.db.tenantTx(p.tenantId, tx => this.defs.publish(tx, p.tenantId, p.userId, typeOf(t), body.version, body.changeNote ?? null));
    await this.ent.bumpPermissions(p.tenantId);
    return out;
  }

  @Get(':docType/versions')
  @Requires('config.workflows:action.view')
  versions(@Param('docType') t: string) {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.defs.versions(tx, typeOf(t)));
  }

  @Get(':docType/versions/:v')
  @Requires('config.workflows:action.view')
  version(@Param('docType') t: string, @Param('v', ParseIntPipe) v: number) {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.defs.version(tx, typeOf(t), v));
  }

  @Post(':docType/simulate')
  @HttpCode(200)
  @Requires('config.workflows:action.view')
  simulate(@Param('docType') t: string, @Body(new Zod(SimulateInput)) body: z.infer<typeof SimulateInput>): Promise<SimulateResult> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.defs.simulate(tx, p.tenantId, typeOf(t), body));
  }
}

@TenantOnly()
@Controller('docs')
export class WorkflowActionsController {
  constructor(private readonly db: DbService, private readonly engine: EngineService, private readonly rows: DocumentRowBuilder) {}

  @Post(':type/:id/actions')
  @HttpCode(200)
  async act(
    @Param('type') type: string, @Param('id') id: string,
    @Body(new Zod(WorkflowActionInput)) body: z.infer<typeof WorkflowActionInput>,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') idem: string | undefined,
    @CurrentPermissions() perms?: MyPermissions,
  ) {
    const p = tenantPrincipal();
    typeOf(type);
    if (!UUID.test(id)) throw AppError.notFound('Document');
    let version: number | undefined;
    if (ifMatch !== undefined && ifMatch !== '') {
      version = Number(ifMatch.replace(/^W\//, '').replace(/"/g, ''));
      if (!Number.isInteger(version)) throw new AppError(400, ErrorCode.VALIDATION, 'If-Match must be the document version number.');
    }
    const key = idem?.trim() ? idem.trim().slice(0, 200) : undefined;
    const caller = { userId: p.userId, perms };
    const run = () => this.db.tenantTx(p.tenantId, async tx => {
      await this.engine.act(tx, type, id, body, caller, { ifMatch: version, idempotencyKey: key });
      return this.rows.build(tx, id, caller);
    });
    try {
      return await run();
    } catch (e) {
      // Same Idempotency-Key raced past the lookup: the other request won; answer with the current document.
      const pg = e as { code?: string; constraint?: string };
      if (key && pg?.code === '23505' && pg.constraint === 'wf_action_idem') return run();
      throw e;
    }
  }
}

const InboxQuery = z.object({
  docType: z.string().regex(TYPE_KEY).optional(),
  stage: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/).optional(),
  overdue: z.enum(['true', 'false', '1', '0']).optional().transform(v => v === 'true' || v === '1'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@TenantOnly()
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly db: DbService, private readonly inbox: InboxService) {}

  @Get()
  @Requires('approvals:action.view')
  list(@Query(new Zod(InboxQuery)) q: z.infer<typeof InboxQuery>, @CurrentPermissions() perms?: MyPermissions) {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.inbox.list(tx, p.userId, perms, q));
  }

  @Get('counts')
  @Requires('approvals:action.view')
  counts(@CurrentPermissions() perms?: MyPermissions): Promise<InboxCounts> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.inbox.counts(tx, p.userId, perms));
  }
}

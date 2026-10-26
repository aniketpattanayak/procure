import { Global, Module } from '@nestjs/common';
import { WORKFLOW_PORT } from '../../core/ports';
import { ActorsService } from './actors.service';
import { DefinitionsService } from './definitions.service';
import { DocsPortRef } from './docs-port';
import { DocumentRowBuilder } from './document-row';
import { WorkflowEffects } from './effects';
import { EngineService } from './engine.service';
import { InboxService } from './inbox.service';
import { WorkflowPortService } from './port.service';
import { SlaService } from './sla.service';
import { ApprovalsController, ConfigWorkflowsController, WorkflowActionsController } from './workflow.controller';

/**
 * Workflow engine (ADR-0011): definitions + publishing, runtime actions, approvals inbox, SLA job, Phase 3 effects.
 * Provides WORKFLOW_PORT (global) and consumes DOCUMENTS_PORT lazily (DocsPortRef) — no provider cycle.
 */
@Global()
@Module({
  controllers: [ConfigWorkflowsController, WorkflowActionsController, ApprovalsController],
  providers: [
    ActorsService, DefinitionsService, DocsPortRef, EngineService, InboxService, SlaService, WorkflowEffects, WorkflowPortService, DocumentRowBuilder,
    { provide: WORKFLOW_PORT, useExisting: WorkflowPortService },
  ],
  exports: [InboxService, WORKFLOW_PORT, DefinitionsService, EngineService, SlaService, DocsPortRef, WorkflowPortService],
})
export class WorkflowModule {}

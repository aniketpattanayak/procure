import { Global, Module } from '@nestjs/common';
import { DOCUMENTS_PORT } from '../../core/ports';
import { FilesModule } from '../files';
import { FormsModule } from '../forms';
import { AuditController } from './audit/audit.controller';
import { AuditQueryService } from './audit/audit-query.service';
import { AuditVerifier } from './audit/audit-verifier';
import { CollaborationService } from './collaboration.service';
import { DocTypesController, DocumentsController, NumberingController, SavedViewsController } from './controllers';
import { DocTypesService } from './doc-types.service';
import { DocumentsPortService } from './documents-port.service';
import { DocumentsService } from './documents.service';
import { DocumentHooks } from './hooks';
import { DocListService } from './list.service';
import { NumberingService } from './numbering.service';
import { SavedViewsService } from './saved-views.service';
import { DocStore } from './store';
import { OutboxRelay } from './system/outbox-relay';
import { TenantCalendar } from './system/tenant-calendar';
import { WorkflowLink } from './workflow-link';

/**
 * Documents core (Phase 3, ADR-0010/0012): document types, numbering, documents + lines, quantity ledger, status,
 * collaboration, saved views, audit API + chain verification, outbox relay. Provides DOCUMENTS_PORT (global) for the
 * workflow module and later modules; uses WORKFLOW_PORT lazily (optional).
 */
@Global()
@Module({
  imports: [FormsModule, FilesModule],
  controllers: [DocTypesController, NumberingController, DocumentsController, SavedViewsController, AuditController],
  providers: [
    WorkflowLink, DocumentHooks, TenantCalendar, NumberingService, DocTypesService, DocStore, DocumentsService, DocListService, CollaborationService,
    SavedViewsService, AuditQueryService, AuditVerifier, OutboxRelay, DocumentsPortService,
    { provide: DOCUMENTS_PORT, useExisting: DocumentsPortService },
    // Workflow module's optional hook for the DocumentRow returned by POST /docs/:type/:id/actions.
    { provide: 'DOCUMENT_ROW_READER', useExisting: DocumentsPortService },
  ],
  exports: [TenantCalendar, DocumentHooks, DOCUMENTS_PORT, 'DOCUMENT_ROW_READER', DocumentsService, DocTypesService, NumberingService, DocStore, WorkflowLink, AuditVerifier, OutboxRelay, DocListService],
})
export class DocumentsModule {}

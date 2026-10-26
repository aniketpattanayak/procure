/** Public surface of the workflow module. Other modules import only from here (or use WORKFLOW_PORT). */
export { WorkflowModule } from './workflow.module';
export { DefinitionsService } from './definitions.service';
export type { DocTypeRow as WorkflowDocTypeRow } from './definitions.service';
export { EngineService } from './engine.service';
export { SlaService } from './sla.service';
export { DocsPortRef } from './docs-port';
export { WorkflowPortService } from './port.service';
export { DOCUMENT_ROW_READER } from './document-row';
export type { DocumentRowReader } from './document-row';
export { groupsOf, mergeVotes, parseDefinition, stageKeyPerm, stageViewPerm } from './model';
export { validateDefinition } from './validate';
export { InboxService } from './inbox.service';

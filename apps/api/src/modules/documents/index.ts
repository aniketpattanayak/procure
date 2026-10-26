/** Public surface of the documents core (Phase 3). Other modules import only from here (and use DOCUMENTS_PORT). */
export { DocumentsModule } from './documents.module';
export { DocumentsService } from './documents.service';
export { DocTypesService } from './doc-types.service';
export { NumberingService } from './numbering.service';
export { DocListService } from './list.service';
export { DocStore } from './store';
export { WorkflowLink } from './workflow-link';
export { AuditVerifier } from './audit/audit-verifier';
export { OutboxRelay, OUTBOX_QUEUE, EVENTS_QUEUE, EVENTS_NOTIFY_QUEUE, EVENT_FANOUT_QUEUES } from './system/outbox-relay';
export type { OutboxRow, Publisher } from './system/outbox-relay';
export { DocumentsPortService } from './documents-port.service';
export { financialYear, periodOf, renderNumber } from './numbering';
export { documentStatus, lineStatus, statusLabel } from './status';
export { applyEvent, emptyBuckets, fromUnits, toUnits, toQuantityBuckets } from './qty';
export { parseMentions } from './mentions';
export { docTab, docAction, docView, staticDocKeys, DOC_ACTIONS, DOC_VIEWS } from './types';
export type { DocActor } from './types';
// ---- Phase 4 (additive): generic hooks for system document types
export { DocumentHooks, OUTCOME_EVENT_TYPES } from './hooks';
export type { LineOutcomeCtx, LineOutcomeHook, SubmitHook, SubmitHookCtx } from './hooks';
// ---- Phase 4 (agent B, additive): beforeRecord / onSave / onResubmit / lineExtras / draftLike
export type { BeforeRecordHook, ResubmitHook, ResubmitHookCtx, SaveHook, SaveHookCtx } from './hooks';
export { dateStr } from './store';
export type { DocRow, LineRow } from './store';
export { TenantCalendar } from './system/tenant-calendar';
// ---- Phase 5 (GRN agent, additive): status rules (PO partially_received / received)
export type { StatusRule, StatusRuleCtx } from './hooks';
export type { Buckets } from './qty';
export { pendingReceipt as pendingReceiptUnits } from './qty';
// ---- QA3-BUG-003: UoM decimal places
export { fitsUom, itemUomRules, uomMessage, uomRules } from './uom';
export type { UomRule } from './uom';

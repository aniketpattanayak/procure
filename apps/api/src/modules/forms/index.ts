/** Public surface of the form & master engine. Other modules import only from here. */
export { FormsModule } from './forms.module';
export { FormsService, fieldAccessOf, stripHidden, tenantToday } from './forms.service';
export type { Actor, FormRow } from './forms.service';
export { MastersService } from './masters.service';
export type { MasterRow } from './masters.service';
export { RecordEngine, labelFor } from './record-engine';
export type { PreparedData, PrepareInput, TargetRecord } from './record-engine';
export { RecordsService } from './records.service';
export type { RecordDbRow, RecordInput } from './records.service';
export { RecordIoService } from './record-io.service';
export { TemplateInstaller } from './template-installer';
export { STANDARD_BUNDLE, STANDARD_TEMPLATE_ROW, SYSTEM_MASTERS, USER_FORM, USER_SYSTEM_FIELDS } from './templates';
export type { TemplateBundle, TemplateMaster } from './templates';
export { UserFieldsService } from './user-fields.service';
export type { UserCustomResult } from './user-fields.service';
export { checkStructure, mergeForPublish } from './structure';
export * as validators from './validators';
export { formulaAvailable } from './formula.adapter';
export { MASTER_ACTIONS, MASTER_VIEWS, masterKeys, upsertMasterRegistry } from './registry';
// ---- Phase 3 (documents): virtual `lines` grid composition and pipeline helpers
export { composeDocumentDefinition, dataFields, DOC_LINES_KEY, docFormPart, isEmpty, isFileField, isGrid, isLookup, parseStoredDefinition } from './definition';
export type { ComposedDocumentDefinition } from './definition';
export { evaluateExpr } from './formula.adapter';
export { kindOfSource, validationFailed } from './record-engine';
export type { RefKind } from './record-engine';
export { canonicalDecimal } from './validators';

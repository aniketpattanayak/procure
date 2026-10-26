/** Public surface of the reports module (Phase 7, ADR-0015). Other modules import only from here. */
export { ReportsModule } from './reports.module';
export { ReportsCatalogue, registerSource, registeredSources } from './catalogue.service';
export { ReportRunner } from './runner.service';
export { ReportsService } from './reports.service';
export { ExportsService, EXPORTS_QUEUE } from './exports.service';
export { installReportBuiltins, BUILTIN_REPORTS } from './builtins';
export { asBool, asDate, asNumeric, asTimestamp, asUuid, dateParts, formFields } from './fields';
export type { EngineSourceDef, ResolvedSource, SourceContext, SourceField, RunActor } from './types';

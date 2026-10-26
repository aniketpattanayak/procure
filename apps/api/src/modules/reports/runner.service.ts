import { Injectable } from '@nestjs/common';
import { ReportDefinition, ReportResult } from '@procure/schema';
import type { MyPermissions } from '@procure/schema';
import type { Tx } from '../../core/db.service';
import { TenantCalendar } from '../documents';
import { ScopeService } from '../permissions';
import { ReportsCatalogue } from './catalogue.service';
import { compile, CompileContext, Compiled, execute, RunOptions, runRange, viewerFields } from './compiler';
import { localDate } from './presets';
import type { ResolvedSource, RunActor, SourceField } from './types';

/** A system definition without the parts that need fields the viewer cannot see (see `ReportRunner.prepare`). */
export function adaptToViewer(def: ReportDefinition, fields: SourceField[]): ReportDefinition {
  const ok = new Set(fields.map(f => f.id));
  const columns = def.columns.filter(c => ok.has(c.field));
  if (!columns.length || columns.length === def.columns.length) return def;
  const series = def.chart?.series.filter(s => ok.has(s)) ?? [];
  return {
    ...def, columns,
    groupBy: def.groupBy.filter(g => ok.has(g)),
    sort: def.sort.filter(s => ok.has(s.field)),
    chart: def.chart && ok.has(def.chart.x) && series.length ? { ...def.chart, series } : undefined,
  };
}

/**
 * Runs report definitions for a viewer: tenant calendar (timezone, fiscal year), source resolution with the
 * viewer's permissions, compile, execute. Used by run/preview, exports, schedules and dashboards.
 */
@Injectable()
export class ReportRunner {
  constructor(private readonly catalogue: ReportsCatalogue, private readonly scope: ScopeService, private readonly calendar: TenantCalendar) {}

  /** Fiscal-year start month of the tenant (platform.tenant.fy_start_month via the documents module's calendar). */
  fyStartMonth(tenantId: string): Promise<number> {
    return this.calendar.fyStartMonth(tenantId);
  }

  async context(tenantId: string, perms: MyPermissions | null, now = new Date()): Promise<CompileContext> {
    const timezone = await this.catalogue.timezone(tenantId);
    return {
      timezone, fyStartMonth: await this.fyStartMonth(tenantId), today: localDate(now, timezone), perms,
      nodeFilter: (p, tab) => this.scope.nodeFilter(p, tab),
    };
  }

  /**
   * Resolves the source for the viewer and compiles. `adapt` (system reports): columns, grouping, sorting and chart
   * series over fields the viewer cannot see (field access, e.g. stock value without `stock:action.view_value`) are
   * dropped instead of failing, so one shipped definition serves every viewer.
   */
  async prepare(tx: Tx, actor: RunActor, def: ReportDefinition, opts: Pick<RunOptions, 'params' | 'dateRange'> & { adapt?: boolean } = {}, now?: Date): Promise<{ compiled: Compiled; source: ResolvedSource; ctx: CompileContext }> {
    const ctx = await this.context(actor.tenantId, actor.perms, now);
    const params = opts.params ?? {};
    const range = runRange(def, params, ctx, opts.dateRange);
    const source = await this.catalogue.resolve(tx, actor, def.source, { params, range });
    const effective = opts.adapt ? adaptToViewer(def, viewerFields(source.fields, actor.perms)) : def;
    return { compiled: compile(source, effective, ctx, opts), source, ctx };
  }

  async run(tx: Tx, actor: RunActor, def: ReportDefinition, opts: RunOptions & { adapt?: boolean }): Promise<ReportResult> {
    const { compiled } = await this.prepare(tx, actor, def, opts);
    return execute(tx, compiled, opts);
  }
}

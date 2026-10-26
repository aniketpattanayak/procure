import { Injectable } from '@nestjs/common';
import { DashboardInput, DashboardWidget, ErrorCode, ReportResult } from '@procure/schema';
import type { InboxCounts, MyPermissions } from '@procure/schema';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { DocListService, DocTypesService } from '../documents';
import { InboxService } from '../workflow';
import { MY_WORK_KEY } from './builtins';
import { ReportsCatalogue } from './catalogue.service';
import { PACK_DASHBOARDS } from './pack/definitions';
import { execute } from './compiler';
import { previousRange, DatePreset } from './presets';
import { isAdmin, ReportsService } from './reports.service';
import { ReportRunner } from './runner.service';
import type { RunActor } from './types';

type Widget = z.infer<typeof DashboardWidget>;
export interface DashboardRow {
  id: string; name: string; widgets: Widget[]; builtin: string | null; ownerUserId: string | null; sharedRoleIds: string[]; isDefaultForRoleIds: string[];
  isMine: boolean; canEdit: boolean; version: number; updatedAt: string;
}
type DbRow = { id: string; name: string; layout: unknown; owner_user_id: string | null; shared_role_ids: string[]; is_default_for_role_ids: string[]; version: number; updated_at: Date };
const COLS = ['id', 'name', 'layout', 'owner_user_id', 'shared_role_ids', 'is_default_for_role_ids', 'version', 'updated_at'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const holds = (perms: MyPermissions | null, key: string) => !perms || perms.keys.includes(key);
const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);

interface Layout { builtin: string | null; widgets: Widget[]; requires: string[]; features: string[] }
function layoutOf(raw: unknown): Layout {
  const l = (typeof raw === 'string' ? JSON.parse(raw) : raw ?? {}) as { builtin?: unknown; widgets?: unknown[]; requires?: unknown; features?: unknown };
  const widgets = (l.widgets ?? []).map(w => DashboardWidget.safeParse(w)).filter(r => r.success).map(r => r.data as Widget);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { builtin: typeof l.builtin === 'string' ? l.builtin : null, widgets, requires: strs(l.requires), features: strs(l.features) };
}

/** Pack dashboards (built-in with `requires`): the tenant has one of the features and the viewer one of the keys. */
function packFits(l: Layout, perms: MyPermissions | null, features: string[]): boolean {
  if (!l.builtin || !l.requires.length) return true;
  if (l.features.length && !l.features.some(f => features.includes(f))) return false;
  return isAdmin(perms) || l.requires.some(k => holds(perms, k));
}

/** Dashboards: grids of widgets over saved reports and built-in metrics; "mine" resolves the viewer's default. */
@Injectable()
export class DashboardsService {
  constructor(
    private readonly reports: ReportsService,
    private readonly runner: ReportRunner,
    private readonly lists: DocListService,
    private readonly types: DocTypesService,
    private readonly audit: AuditService,
    private readonly inbox: InboxService,
    private readonly catalogue: ReportsCatalogue,
  ) {}

  /** Widgets of a pack dashboard the viewer can use (reports available to them, document types they can list). */
  private async usable(tx: Tx, actor: RunActor, d: DashboardRow): Promise<DashboardRow> {
    if (!d.builtin || d.builtin === MY_WORK_KEY) return d;
    const ids = d.widgets.map(w => w.reportId).filter((x): x is string => !!x);
    const rows = ids.length ? await tx.selectFrom('app.report_def').select(['id', 'kind', 'definition']).where('tenant_id', '=', actor.tenantId)
      .where('id', 'in', ids).where('is_active', '=', true).execute() : [];
    const byId = new Map(rows.map(r => [r.id, r]));
    const cache = new Map<string, boolean>();
    const widgets: Widget[] = [];
    for (const w of d.widgets) {
      if (w.reportId) {
        const r = byId.get(w.reportId);
        if (!r || !holds(actor.perms, 'reports:action.view') || !(await this.reports.builtinAvailable(tx, actor, r, cache))) continue;
      }
      if (w.type === 'doc_counts' && w.docTypeKey) {
        if (!(await this.catalogue.available(tx, actor, { kind: 'doc', key: w.docTypeKey }, cache))) continue;
      }
      widgets.push(w);
    }
    return { ...d, widgets };
  }

  private toRow(r: DbRow, actor: RunActor): DashboardRow {
    const l = layoutOf(r.layout);
    const mine = !!actor.userId && r.owner_user_id === actor.userId;
    return {
      id: r.id, name: r.name, widgets: l.widgets, builtin: l.builtin, ownerUserId: r.owner_user_id, sharedRoleIds: r.shared_role_ids ?? [],
      isDefaultForRoleIds: r.is_default_for_role_ids ?? [], isMine: mine,
      canEdit: !l.builtin && (mine || isAdmin(actor.perms)) && holds(actor.perms, 'dashboards:action.edit'),
      version: r.version, updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  /** Visible = built-in, owned, shared with (or default for) one of my roles; tenant admins see all. */
  private visible(r: DbRow, actor: RunActor, roles: string[]): boolean {
    if (isAdmin(actor.perms) || layoutOf(r.layout).builtin) return true;
    if (r.owner_user_id && r.owner_user_id === actor.userId) return true;
    return [...(r.shared_role_ids ?? []), ...(r.is_default_for_role_ids ?? [])].some(x => roles.includes(x));
  }

  async list(tx: Tx, actor: RunActor): Promise<DashboardRow[]> {
    await this.reports.ensureBuiltins(actor.tenantId);
    const roles = await this.reports.roleIds(tx, actor.userId);
    const rows = (await tx.selectFrom('app.dashboard_def').select([...COLS]).where('tenant_id', '=', actor.tenantId).orderBy('name').execute()) as DbRow[];
    const features = await this.catalogue.tenantFeatures(actor.tenantId);
    return rows.filter(r => this.visible(r, actor, roles) && packFits(layoutOf(r.layout), actor.perms, features)).map(r => this.toRow(r, actor));
  }

  async get(tx: Tx, actor: RunActor, id: string, lock = false): Promise<DashboardRow> {
    if (!UUID.test(id)) throw AppError.notFound('Dashboard');
    await this.reports.ensureBuiltins(actor.tenantId);
    let q = tx.selectFrom('app.dashboard_def').select([...COLS]).where('tenant_id', '=', actor.tenantId).where('id', '=', id);
    if (lock) q = q.forUpdate();
    const r = (await q.executeTakeFirst()) as DbRow | undefined;
    if (!r || !this.visible(r, actor, await this.reports.roleIds(tx, actor.userId))) throw AppError.notFound('Dashboard');
    if (!packFits(layoutOf(r.layout), actor.perms, await this.catalogue.tenantFeatures(actor.tenantId))) throw AppError.notFound('Dashboard');
    return this.usable(tx, actor, this.toRow(r, actor));
  }

  /** Default dashboard: role default → my latest personal dashboard → built-in "My work". */
  async mine(tx: Tx, actor: RunActor): Promise<DashboardRow> {
    await this.reports.ensureBuiltins(actor.tenantId);
    const roles = await this.reports.roleIds(tx, actor.userId);
    const base = () => tx.selectFrom('app.dashboard_def').select([...COLS]).where('tenant_id', '=', actor.tenantId);
    if (roles.length) {
      // a role default the company built wins over the pack's defaults
      const r = await base().where(sql<boolean>`is_default_for_role_ids && ${roles}::uuid[]`).where(sql<boolean>`not (layout ? 'builtin')`)
        .orderBy('updated_at', 'desc').executeTakeFirst();
      if (r) return this.toRow(r as DbRow, actor);
    }
    if (!isAdmin(actor.perms)) {
      // pack dashboards are the default for roles with their tabs (procurement first, then stores)
      const features = await this.catalogue.tenantFeatures(actor.tenantId);
      const packs = (await base().where(sql<boolean>`layout ? 'requires'`).execute()) as DbRow[];
      const order = (r: DbRow) => PACK_DASHBOARDS.findIndex(p => p.key === layoutOf(r.layout).builtin);
      const fit = packs.filter(r => packFits(layoutOf(r.layout), actor.perms, features)).sort((a, b) => order(a) - order(b))[0];
      if (fit) return this.usable(tx, actor, this.toRow(fit, actor));
    }
    if (actor.userId) {
      const r = await base().where('owner_user_id', '=', actor.userId).orderBy('updated_at', 'desc').executeTakeFirst();
      if (r) return this.toRow(r as DbRow, actor);
    }
    const b = await base().where(sql<boolean>`layout ->> 'builtin' = ${MY_WORK_KEY}`).executeTakeFirst();
    if (!b) throw AppError.notFound('Dashboard');
    return this.toRow(b as DbRow, actor);
  }

  private async validate(tx: Tx, actor: RunActor, input: z.infer<typeof DashboardInput>, before?: Pick<DashboardRow, 'sharedRoleIds' | 'isDefaultForRoleIds'>) {
    // QA47-BUG-010: sharing with roles / making it a role's default needs reports:action.share (as for reports).
    // Only roles being added are gated, so an owner without the key can still edit (or unshare) a shared dashboard.
    const prevShared = new Set(before?.sharedRoleIds ?? []);
    const prevDefault = new Set(before?.isDefaultForRoleIds ?? []);
    const adds = input.sharedRoleIds.some(r => !prevShared.has(r)) || input.isDefaultForRoleIds.some(r => !prevDefault.has(r));
    if (adds && actor.perms && !actor.perms.keys.includes('reports:action.share')) {
      throw AppError.forbidden('You cannot share dashboards with roles or make them a role default.');
    }
    const ids = input.widgets.map(w => w.id);
    if (new Set(ids).size !== ids.length) throw bad('widgets', 'Widget ids must be unique.');
    for (const [i, w] of input.widgets.entries()) {
      if ((w.type === 'kpi' || w.type === 'chart' || w.type === 'table') && !w.reportId) throw bad(`widgets.${i}.reportId`, 'Choose a report for this widget.');
      if (w.reportId) await this.reports.get(tx, actor, w.reportId);
      if (w.type === 'doc_counts' && w.docTypeKey) {
        const t = await this.types.find(tx, actor.tenantId, w.docTypeKey);
        if (!t) throw bad(`widgets.${i}.docTypeKey`, `Unknown document type "${w.docTypeKey}".`);
      }
    }
    const roleIds = [...new Set([...input.sharedRoleIds, ...input.isDefaultForRoleIds])];
    if (roleIds.length) {
      const found = await tx.selectFrom('app.role').select('id').where('tenant_id', '=', actor.tenantId).where('id', 'in', roleIds).where('is_deleted', '=', false).execute();
      if (found.length !== roleIds.length) throw bad('sharedRoleIds', 'Unknown role.');
    }
  }

  async create(tx: Tx, actor: RunActor, input: z.infer<typeof DashboardInput>): Promise<DashboardRow> {
    await this.validate(tx, actor, input);
    const row = await tx.insertInto('app.dashboard_def').values({
      name: input.name, layout: JSON.stringify({ widgets: input.widgets }), owner_user_id: actor.userId, shared_role_ids: input.sharedRoleIds,
      is_default_for_role_ids: input.isDefaultForRoleIds, created_by: actor.userId,
    }).returning([...COLS]).executeTakeFirstOrThrow();
    await this.audit.tenant(tx, { action: 'create', entity: 'dashboard', entityId: row.id, actorId: actor.userId, after: { name: input.name, widgets: input.widgets.length } });
    return this.toRow(row as DbRow, actor);
  }

  private async editable(tx: Tx, actor: RunActor, id: string): Promise<DashboardRow> {
    const d = await this.get(tx, actor, id, true);
    if (d.builtin) throw AppError.conflict('The built-in dashboard is read-only. Create your own dashboard instead.');
    if (!d.isMine && !isAdmin(actor.perms)) throw AppError.forbidden('Only the owner can change this dashboard.');
    return d;
  }

  async update(tx: Tx, actor: RunActor, id: string, input: z.infer<typeof DashboardInput>): Promise<DashboardRow> {
    const before = await this.editable(tx, actor, id);
    await this.validate(tx, actor, input, before);
    const row = await tx.updateTable('app.dashboard_def').set({
      name: input.name, layout: JSON.stringify({ widgets: input.widgets }), shared_role_ids: input.sharedRoleIds, is_default_for_role_ids: input.isDefaultForRoleIds,
      version: sql<number>`version + 1`,
    }).where('tenant_id', '=', actor.tenantId).where('id', '=', id).returning([...COLS]).executeTakeFirstOrThrow();
    await this.audit.tenant(tx, { action: 'update', entity: 'dashboard', entityId: id, actorId: actor.userId, after: { name: input.name, widgets: input.widgets.length } });
    return this.toRow(row as DbRow, actor);
  }

  async remove(tx: Tx, actor: RunActor, id: string): Promise<void> {
    const d = await this.editable(tx, actor, id);
    await tx.deleteFrom('app.dashboard_def').where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    await this.audit.tenant(tx, { action: 'delete', entity: 'dashboard', entityId: id, actorId: actor.userId, before: { name: d.name } });
  }

  // ------------------------------------------------------------------ widget data

  async widgetData(tx: Tx, actor: RunActor, dashboardId: string, widgetId: string): Promise<Record<string, unknown>> {
    const d = await this.get(tx, actor, dashboardId);
    const w = d.widgets.find(x => x.id === widgetId);
    if (!w) throw AppError.notFound('Widget');
    switch (w.type) {
      case 'kpi': return this.kpi(tx, actor, w);
      case 'chart': {
        const { def, r } = await this.runWidget(tx, actor, w, 200);
        return { type: 'chart', title: w.title, chartType: def.chart?.type ?? 'bar', chart: r.chart ?? fallbackChart(r), columns: r.columns };
      }
      case 'table': {
        const limit = Math.min(200, Math.max(1, Number(w.params.limit) || 20));
        const { r } = await this.runWidget(tx, actor, w, limit);
        return { type: 'table', title: w.title, columns: r.columns, rows: r.rows, totals: r.totals, links: r.links ?? null, more: !!r.nextCursor };
      }
      case 'inbox_counts': return { type: 'inbox_counts', title: w.title, ...(await this.inboxCounts(tx, actor)), link: '/approvals' };
      case 'doc_counts': return { type: 'doc_counts', title: w.title, types: await this.docCounts(tx, actor, w.docTypeKey) };
    }
  }

  private async runWidget(tx: Tx, actor: RunActor, w: Widget, limit: number, dateRange?: { from: string; to: string } | null) {
    if (!holds(actor.perms, 'reports:action.view')) throw AppError.forbidden('You cannot view reports.');
    const report = await this.reports.get(tx, actor, w.reportId!);
    const { compiled } = await this.runner.prepare(tx, actor, report.definition, { params: w.params, dateRange, adapt: report.kind === 'builtin' });
    return { def: report.definition, r: await execute(tx, compiled, { params: w.params, limit }) };
  }

  /** KPI: the first summarised column's total (or the first number of the first row) and its change vs the previous period. */
  private async kpi(tx: Tx, actor: RunActor, w: Widget) {
    const { def, r } = await this.runWidget(tx, actor, w, 1);
    const value = kpiValue(r) ?? 0; // an empty period sums to zero
    const presetParam = typeof w.params.datePreset === 'string' ? w.params.datePreset : null;
    const preset = (presetParam ?? def.datePreset) as DatePreset;
    let previous: number | null = null;
    if (preset !== 'none') {
      const ctx = await this.runner.context(actor.tenantId, actor.perms);
      const range = previousRange(preset, ctx.today, ctx.fyStartMonth);
      if (range) previous = kpiValue((await this.runWidget(tx, actor, w, 1, range)).r) ?? 0;
    }
    const delta = previous !== null ? round(value - previous) : null;
    const deltaPct = delta !== null && previous ? round((delta / Math.abs(previous)) * 100) : null;
    const col = r.columns.find(c => c.aggregate !== 'none') ?? r.columns.find(c => c.type === 'number' || c.type === 'currency');
    return { type: 'kpi', title: w.title, value, previous, delta, deltaPct, label: col?.label ?? null, format: col?.type ?? 'number', link: `/reports/${w.reportId}` };
  }

  /** Approvals inbox counts from the workflow module's inbox (actionable stages for this user). */
  async inboxCounts(tx: Tx, actor: RunActor): Promise<InboxCounts> {
    if (!actor.userId) return { total: 0, overdue: 0, byType: [] };
    return this.inbox.counts(tx, actor.userId, actor.perms ?? undefined);
  }

  /** Status counts per doc type (one type, or every type the viewer can list), each linking to the filtered list. */
  async docCounts(tx: Tx, actor: RunActor, docTypeKey?: string) {
    const all = await tx.selectFrom('app.doc_type').select('key').where('tenant_id', '=', actor.tenantId).where('is_active', '=', true).orderBy('name').execute();
    const keys = (docTypeKey ? all.filter(t => t.key === docTypeKey) : all).map(t => t.key).filter(k => holds(actor.perms, `doc.${k}:action.view`));
    if (docTypeKey && !keys.length) throw AppError.notFound('Document type');
    const out = [];
    for (const key of keys.slice(0, 12)) {
      const t = await this.types.load(tx, actor.tenantId, key);
      const counts = await this.lists.counts(tx, actor, t, { view: 'document', limit: 50, fields: {} });
      out.push({
        docTypeKey: t.key, name: t.plural_name, link: `/docs/${t.key}`, total: counts.reduce((a, c) => a + c.count, 0),
        counts: counts.map(c => ({ ...c, link: `/docs/${t.key}?status=${encodeURIComponent(c.statusKey)}` })),
      });
    }
    return out;
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

function kpiValue(r: ReportResult): number | null {
  const i = r.columns.findIndex(c => c.aggregate !== 'none');
  if (i >= 0) {
    const v = r.totals?.[i] ?? (r.rows.length === 1 ? r.rows[0]![i] : null);
    return v === null || v === undefined ? null : Number(v);
  }
  const j = r.columns.findIndex(c => c.type === 'number' || c.type === 'currency');
  const v = j >= 0 ? r.rows[0]?.[j] : null;
  return v === null || v === undefined ? null : Number(v);
}

function fallbackChart(r: ReportResult): ReportResult['chart'] {
  const xi = r.columns.findIndex(c => c.type !== 'number' && c.type !== 'currency');
  const series = r.columns.map((c, i) => ({ c, i })).filter(x => x.c.type === 'number' || x.c.type === 'currency');
  return {
    x: r.rows.map(row => (xi >= 0 ? row[xi] : null)),
    series: series.map(s => ({ name: s.c.label, values: r.rows.map(row => Number(row[s.i] ?? 0)) })),
  };
}

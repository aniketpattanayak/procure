/**
 * Fixtures for the reports suites (reports*.test.ts): a tenant with reports + report builder, a location tree
 * (Pune → Pune main store, Chennai), items with a category lookup, a Capex document type and documents.
 */
import { sql } from 'kysely';
import { EntitlementsService } from '../src/core/entitlements.service';
import { CAPEX_HEADER, CAPEX_LINE, capexBody, docsApi, DocsFixture } from './documents-helpers';
import { api, createMaster, mustOk, publish, userWithKeys } from './forms-helpers';
import { Ctx, superAdmin, tenantWithAdmin, uid } from './helpers';

export const REPORT_FEATURES = ['indent', 'purchase', 'form_builder', 'reports', 'report_builder', 'workflow_designer'];

export interface ReportsFixture extends DocsFixture {
  categories: { a: string; b: string };
  /** item ids: [cat A, cat B] */
  docType: string;
}

export async function reportsTenant(c: Ctx, features = REPORT_FEATURES): Promise<ReportsFixture> {
  const sa = await superAdmin(c);
  const t = await tenantWithAdmin(c, sa.token, { features, limits: { max_users: 50, custom_forms: 20, storage_gb: 1, max_locations: 20 } });
  const token = t.admin.token;
  const a = api(c, token);
  const pune = await mustOk(a.post('/locations', { code: `PUN-${uid(4)}`, name: 'Pune plant' }), 201);
  const puneMain = await mustOk(a.post('/locations', { parentId: pune.id, code: `PUNM-${uid(4)}`, name: 'Pune main store' }), 201);
  const chennai = await mustOk(a.post('/locations', { code: `CHE-${uid(4)}`, name: 'Chennai plant' }), 201);
  const uom = await mustOk(a.post('/masters/uom/records', { code: `U${uid(4)}`, name: 'Numbers', data: { decimals: '0' } }), 201);
  await createMaster(c, token, 'item_category');
  const catA = await mustOk(a.post('/masters/item_category/records', { code: 'CA', name: 'Category A', data: {} }), 201);
  const catB = await mustOk(a.post('/masters/item_category/records', { code: 'CB', name: 'Category B', data: {} }), 201);
  const item = await mustOk(a.get('/config/forms/item'));
  const fields = [...item.published.fields, { key: 'category', type: 'lookup', label: 'Category', source: { kind: 'master', masterKey: 'item_category' } }];
  await mustOk(publish(c, token, 'item', fields));
  const i1 = await mustOk(a.post('/masters/item/records', { name: 'Laptop', data: { uom: uom.id, category: catA.id } }), 201);
  const i2 = await mustOk(a.post('/masters/item/records', { name: 'Printer', data: { uom: uom.id, category: catB.id } }), 201);
  await mustOk(a.post('/config/doc-types', {
    key: 'capex', name: 'Capex Request', pluralName: 'Capex Requests', headerDefinition: { fields: [...CAPEX_HEADER, { key: 'budget', type: 'currency', label: 'Budget' }] },
    lineDefinition: { fields: CAPEX_LINE }, numberPattern: 'CAPEX/{SEQ:5}',
  }), 201);
  return {
    tenantId: t.tenant.tenantId, code: t.tenant.code, token, adminId: t.admin.userId, pune: pune.id, puneMain: puneMain.id, chennai: chennai.id,
    uom: uom.id, items: [i1.id, i2.id], categories: { a: catA.id, b: catB.id }, docType: 'capex',
  };
}

/** Creates (and optionally submits) a capex document through the API. */
export async function capexDoc(c: Ctx, f: ReportsFixture, o: { location?: string; submit?: boolean; date?: string; priority?: string; budget?: string; values?: Record<string, unknown>; lines?: { item?: string; qty: string; est_rate: string }[] } = {}, token = f.token) {
  const d = docsApi(c, token);
  const body = capexBody(f, {
    location: o.location, lines: o.lines,
    values: { doc_date: o.date ?? '2026-10-01', priority: o.priority ?? 'Normal', ...(o.priority === 'Urgent' ? { justification: 'Line down' } : {}), ...(o.budget ? { budget: o.budget } : {}), ...(o.values ?? {}) },
  });
  const doc = await mustOk(d.create(body), 201);
  if (o.submit) return mustOk(d.submit(doc.id, doc.version), 200);
  return doc;
}

export const reportKeys = ['reports:action.view', 'reports:action.export', 'reports:action.schedule', 'reports:action.build', 'reports:action.share', 'dashboards:action.view', 'dashboards:action.edit'];
export const capexViewKeys = ['doc.capex:action.view', ...['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'].map(v => `doc.capex:view.${v}`)];

/** A restricted user with keys and (optionally) a data scope node; all nodes otherwise. */
export async function reportUser(c: Ctx, f: ReportsFixture, keys: string[], scopeNodeId?: string, fieldAccess: { formKey: string; fieldKey: string; mode: 'hidden' | 'readonly' }[] = []) {
  const u = await userWithKeys(c, f.token, f.code, keys);
  const a = api(c, f.token);
  await mustOk(a.put(`/roles/${u.roleId}/scope`, { entries: [scopeNodeId ? { nodeId: scopeNodeId } : { allNodes: true }] }));
  if (fieldAccess.length) {
    const tab = keys[0]!.split(':')[0]!;
    const byTab = keys.filter(k => k.startsWith(`${tab}:`));
    await mustOk(a.put(`/roles/${u.roleId}/permissions/tabs/${tab}`, {
      actions: byTab.filter(k => k.includes(':action.')), views: byTab.filter(k => k.includes(':view.')), fieldAccess,
    }));
  }
  await c.app.get(EntitlementsService).bumpPermissions(f.tenantId);
  return u;
}

export const reportsApi = (c: Ctx, token: string) => {
  const a = api(c, token);
  return {
    ...a,
    preview: (definition: unknown, params: Record<string, unknown> = {}) => a.post('/reports/preview', { definition, params }),
    run: (id: string, body: unknown = {}) => a.post(`/reports/${id}/run`, body),
    create: (body: unknown) => a.post('/reports', body),
  };
};

/**
 * Bulk documents straight into the tables (as the DB owner) for volume tests: `docs` approved capex documents with
 * `linesPer` lines each, spread over the fixture's locations, items and months of 2026.
 */
export async function bulkCapex(c: Ctx, f: ReportsFixture, docs: number, linesPer: number, prefix = 'BULK') {
  const t = await c.db.selectFrom('app.doc_type as dt').innerJoin('app.form_def as h', 'h.id', 'dt.header_form_id').innerJoin('app.form_def as l', 'l.id', 'dt.line_form_id')
    .select(['dt.id', 'h.current_version_id as hv', 'l.current_version_id as lv']).where('dt.tenant_id', '=', f.tenantId).where('dt.key', '=', f.docType).executeTakeFirstOrThrow();
  const locs = [f.puneMain, f.chennai, f.pune];
  await sql`
    insert into app.document (tenant_id, doc_type_id, number, status_key, location_node_id, doc_date, total_amount, custom, form_version_id, line_form_version_id, submitted_at)
    select ${f.tenantId}::uuid, ${t.id}::uuid, ${prefix} || '-' || lpad(g::text, 7, '0'), 'approved',
      (${locs}::uuid[])[1 + (g % 3)], date '2026-01-01' + (g % 300), (${linesPer} * 100)::numeric,
      jsonb_build_object('purpose', 'bulk ' || g, 'priority', case when g % 2 = 0 then 'Normal' else 'Urgent' end), ${t.hv}::uuid, ${t.lv}::uuid, now()
    from generate_series(1, ${docs}) g`.execute(c.db);
  if (linesPer > 0) {
    await sql`
      insert into app.document_line (tenant_id, document_id, doc_type_id, line_no, item_id, uom_id, qty, rate, amount, location_node_id, status_key, custom)
      select d.tenant_id, d.id, d.doc_type_id, n, (${f.items}::uuid[])[1 + (n % 2)], ${f.uom}::uuid, n, 100, 100 * n, d.location_node_id, 'approved',
        jsonb_build_object('est_rate', '100.00')
      from app.document d cross join generate_series(1, ${linesPer}) n
      where d.tenant_id = ${f.tenantId} and d.doc_type_id = ${t.id} and d.number like ${`${prefix}-%`}`.execute(c.db);
    await sql`
      insert into app.line_qty_summary (line_id, tenant_id, document_id, requested, approved)
      select l.id, l.tenant_id, l.document_id, l.qty, l.qty from app.document_line l join app.document d on d.id = l.document_id
      where l.tenant_id = ${f.tenantId} and d.number like ${`${prefix}-%`}`.execute(c.db);
  }
  await sql`analyze app.document`.execute(c.db);
  await sql`analyze app.document_line`.execute(c.db);
}

/** Tenancy-isolation seed for the reports tables (owner inserts; the isolation plan has no reports feature). */
export async function seedReportsIsolation(c: Ctx, s: { tenantId: string; adminId: string }) {
  const def = JSON.stringify({ source: { kind: 'engine', key: 'audit' }, columns: [{ field: 'action' }] });
  const r = await c.db.insertInto('app.report_def').values({ tenant_id: s.tenantId, key: `iso_${uid(6)}`, name: 'Iso report', kind: 'custom', definition: def, owner_user_id: s.adminId } as never)
    .returning('id').executeTakeFirstOrThrow();
  const sch = await c.db.insertInto('app.report_schedule').values({
    tenant_id: s.tenantId, report_id: r.id, cron: '0 9 * * 1', recipients: JSON.stringify([{ type: 'user', userId: s.adminId }]), run_as_user_id: s.adminId, is_active: false,
  } as never).returning('id').executeTakeFirstOrThrow();
  const dash = await c.db.insertInto('app.dashboard_def').values({ tenant_id: s.tenantId, name: 'Iso dashboard', layout: JSON.stringify({ widgets: [] }), owner_user_id: s.adminId } as never)
    .returning('id').executeTakeFirstOrThrow();
  const job = await c.db.insertInto('app.export_job').values({ tenant_id: s.tenantId, kind: 'report', source: JSON.stringify({ reportId: r.id }), format: 'csv', requested_by: s.adminId } as never)
    .returning('id').executeTakeFirstOrThrow();
  return { reportId: r.id, scheduleId: sch.id, dashboardId: dash.id, exportId: job.id };
}

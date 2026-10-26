/**
 * Workflow test fixtures: a tenant with the workflow designer, a document type (header + line forms, static
 * permission keys), documents created/submitted directly, users holding stage keys, and API shortcuts.
 * Documents are inserted as the DB owner and submitted through the engine (WorkflowPort.start) in an app tenantTx,
 * so these suites do not depend on the documents module's API.
 */
import { WorkflowDefinition } from '@procure/schema';
import { sql } from 'kysely';
import { expect } from 'vitest';
import type { Tx } from '../src/core/db.service';
import { DbService } from '../src/core/db.service';
import type { DocumentsPort } from '../src/core/ports';
import { DocsPortRef, EngineService, SlaService } from '../src/modules/workflow';
import { api, mustOk } from './forms-helpers';
import { API, bearer, Ctx, superAdmin, tenantWithAdmin, uid } from './helpers';
import { createRole, grantTab, restrictedUser } from './permissions-helpers';
import { FakeDocumentsPort } from './workflow-fake-docs';

export const WF_FEATURES = ['indent', 'purchase', 'form_builder', 'workflow_designer'];

export interface WfTenant {
  tenantId: string; code: string; token: string; adminId: string;
  plantA: { id: string; path: string }; storeA: { id: string; path: string }; plantB: { id: string; path: string };
}

export async function wfTenant(c: Ctx, features = WF_FEATURES): Promise<WfTenant> {
  const sa = await superAdmin(c);
  const { tenant, admin } = await tenantWithAdmin(c, sa.token, { features, limits: { max_users: 200, custom_forms: 20, max_locations: 20, storage_gb: 1 } });
  const a = api(c, admin.token);
  const pa = await mustOk(a.post('/locations', { code: `PA-${uid(4)}`, name: 'Plant A' }), 201);
  const sa2 = await mustOk(a.post('/locations', { parentId: pa.id, code: `SA-${uid(4)}`, name: 'Store A' }), 201);
  const pb = await mustOk(a.post('/locations', { code: `PB-${uid(4)}`, name: 'Plant B' }), 201);
  const path = async (id: string) => (await sql<{ p: string }>`select path::text as p from app.location_node where id = ${id}`.execute(c.db)).rows[0]!.p;
  return {
    tenantId: tenant.tenantId, code: tenant.code, token: admin.token, adminId: admin.userId,
    plantA: { id: pa.id, path: await path(pa.id) }, storeA: { id: sa2.id, path: await path(sa2.id) }, plantB: { id: pb.id, path: await path(pb.id) },
  };
}

const HEADER_FIELDS = [
  { key: 'location', type: 'lookup', label: 'Location', system: true, required: true, source: { kind: 'location' } },
  { key: 'doc_date', type: 'date', label: 'Date', system: true },
  { key: 'total_amount', type: 'currency', label: 'Total', system: true },
  { key: 'purpose', type: 'text', label: 'Purpose' },
  { key: 'priority', type: 'select', label: 'Priority', options: [{ value: 'Normal', label: 'Normal' }, { value: 'Urgent', label: 'Urgent' }] },
  { key: 'approver', type: 'lookup', label: 'Approver', source: { kind: 'user' } },
];
const LINE_FIELDS = [
  { key: 'qty', type: 'decimal', label: 'Qty', system: true, required: true },
  { key: 'rate', type: 'currency', label: 'Rate', system: true },
  { key: 'amount', type: 'currency', label: 'Amount', system: true },
  { key: 'est_rate', type: 'currency', label: 'Est. rate' },
  { key: 'remarks', type: 'text', label: 'Remarks' },
];

export interface DocType { id: string; key: string; headerVersionId: string; lineVersionId: string }

async function form(c: Ctx, tenantId: string, key: string, name: string, fields: unknown[]) {
  const f = await c.db.insertInto('app.form_def').values({ tenant_id: tenantId, key, name, kind: 'transaction', is_system: false }).returning('id').executeTakeFirstOrThrow();
  const v = await c.db.insertInto('app.form_version').values({ tenant_id: tenantId, form_id: f.id, version: 1, definition: JSON.stringify({ fields, validations: [] }) })
    .returning('id').executeTakeFirstOrThrow();
  await c.db.updateTable('app.form_def').set({ current_version_id: v.id }).where('id', '=', f.id).execute();
  return { formId: f.id, versionId: v.id };
}

/** Document type with header/line forms and the static `doc.<key>` registry rows (as the documents module writes them). */
export async function createDocType(c: Ctx, t: WfTenant, key = `t${uid(6)}`, name = 'Capex Request'): Promise<DocType> {
  const h = await form(c, t.tenantId, `${key}_header`, `${name} header`, HEADER_FIELDS);
  const l = await form(c, t.tenantId, `${key}_line`, `${name} line`, LINE_FIELDS);
  const dt = await c.db.insertInto('app.doc_type').values({
    tenant_id: t.tenantId, key, name, plural_name: `${name}s`, kind: 'custom', header_form_id: h.formId, line_form_id: l.formId, settings: '{}',
  }).returning('id').executeTakeFirstOrThrow();
  const tab = `doc.${key}`;
  const actions = ['view', 'add', 'edit', 'delete', 'submit', 'cancel', 'close', 'copy', 'comment', 'attach'];
  const views = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'];
  await c.db.insertInto('app.permission_def').values([
    { tenant_id: t.tenantId, key: tab, kind: 'tab', tab_key: tab, label: `${name}s`, group_label: 'Modules', sort_order: 300, source: 'form', source_id: dt.id, description: null, requires_feature: null, requires_setting: null },
    ...actions.map((a, i) => ({ tenant_id: t.tenantId, key: `${tab}:action.${a}`, kind: 'action' as const, tab_key: tab, label: a, group_label: null, sort_order: i + 1, source: 'form' as const, source_id: dt.id, description: null, requires_feature: null, requires_setting: null })),
    ...views.map((v, i) => ({ tenant_id: t.tenantId, key: `${tab}:view.${v}`, kind: 'view' as const, tab_key: tab, label: v, group_label: null, sort_order: i + 1, source: 'form' as const, source_id: dt.id, description: null, requires_feature: null, requires_setting: null })),
  ]).execute();
  return { id: dt.id, key, headerVersionId: h.versionId, lineVersionId: l.versionId };
}

export async function publishWorkflow(c: Ctx, token: string, docType: string, definition: unknown, expectOk = true) {
  const a = api(c, token);
  const d = await mustOk(a.get(`/config/workflows/${docType}`));
  const saved = await mustOk(a.put(`/config/workflows/${docType}/draft`, { definition, version: d.version }));
  const res = await a.post(`/config/workflows/${docType}/publish`, { version: saved.version });
  if (expectOk) expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
}

export interface DocLine { qty: string; rate?: string; values?: Record<string, unknown> }
export interface MadeDoc { id: string; lineIds: string[] }

/** Inserts a draft document (as the DB owner). total_amount defaults to Σ qty × rate. */
export async function makeDoc(c: Ctx, t: WfTenant, dt: DocType, o: { locationId?: string; createdBy?: string; values?: Record<string, unknown>; total?: string; lines: DocLine[] }): Promise<MadeDoc> {
  const total = o.total ?? o.lines.reduce((s, l) => s + Number(l.qty) * Number(l.rate ?? 0), 0).toString();
  const d = await c.db.insertInto('app.document').values({
    tenant_id: t.tenantId, doc_type_id: dt.id, location_node_id: o.locationId ?? t.plantA.id, custom: JSON.stringify(o.values ?? { purpose: 'Test' }),
    total_amount: total, form_version_id: dt.headerVersionId, line_form_version_id: dt.lineVersionId, created_by: o.createdBy ?? t.adminId,
  }).returning('id').executeTakeFirstOrThrow();
  const lineIds: string[] = [];
  for (const [i, l] of o.lines.entries()) {
    const r = await c.db.insertInto('app.document_line').values({
      tenant_id: t.tenantId, document_id: d.id, doc_type_id: dt.id, line_no: i + 1, qty: l.qty, rate: l.rate ?? null,
      amount: l.rate ? (Number(l.qty) * Number(l.rate)).toString() : null, location_node_id: o.locationId ?? t.plantA.id, custom: JSON.stringify(l.values ?? {}),
    }).returning('id').executeTakeFirstOrThrow();
    lineIds.push(r.id);
  }
  return { id: d.id, lineIds };
}

export const docsPort = (c: Ctx): DocumentsPort => c.app.get(DocsPortRef).get();

/** Submit as the documents module does: number, submitted_by, `requested` events, lock, WorkflowPort.start. */
export async function submitDoc(c: Ctx, t: WfTenant, doc: MadeDoc, userId: string) {
  await c.app.get(DbService).tenantTx(t.tenantId, async tx => {
    const port = docsPort(c);
    const lines = await tx.selectFrom('app.document_line').select(['id', 'qty']).where('document_id', '=', doc.id).where('is_deleted', '=', false).execute();
    await tx.updateTable('app.document').set({ number: `T/${uid(6)}`, submitted_at: new Date(), submitted_by: userId, status_key: 'submitted' }).where('id', '=', doc.id).execute();
    await port.recordQuantities(tx, doc.id, lines.map(l => ({ lineId: l.id, type: 'requested' as const, qty: l.qty })), userId);
    await port.setLocked(tx, doc.id, true);
    await c.app.get(EngineService).start(tx, doc.id, userId);
    await port.recomputeStatus(tx, doc.id);
  });
}

export async function inTenant<T>(c: Ctx, t: WfTenant, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return c.app.get(DbService).tenantTx(t.tenantId, fn);
}

export function useFakeDocs(c: Ctx) {
  c.app.get(DocsPortRef).use(new FakeDocumentsPort());
}

/** A user with a role holding the given keys (by tab), default scope = `scopeNode` subtree (or all nodes). */
export async function wfUser(c: Ctx, t: WfTenant, keys: string[], opts: { scopeNode?: string | null; roleId?: string; managerId?: string } = {}) {
  const role = opts.roleId ? { id: opts.roleId } : await createRole(c, t.token, `Role ${uid(4)}`);
  const byTab = new Map<string, { actions: string[]; views: string[] }>();
  for (const k of keys) {
    const tab = k.split(':')[0]!;
    const e = byTab.get(tab) ?? { actions: [], views: [] };
    (k.includes(':view.') ? e.views : e.actions).push(k);
    byTab.set(tab, e);
  }
  for (const [tab, e] of byTab) {
    const r = await grantTab(c, t.token, role.id, tab, e.actions, e.views);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  if (!opts.roleId) {
    const entries = opts.scopeNode === null ? [{ allNodes: true }] : [{ nodeId: opts.scopeNode ?? t.plantA.id }];
    const sc = await c.http.put(`${API}/roles/${role.id}/scope`).set(bearer(t.token)).send({ entries });
    expect(sc.status, JSON.stringify(sc.body)).toBe(200);
  }
  const u = await restrictedUser(c, t.code, t.token, [role.id]);
  if (opts.managerId) await c.db.updateTable('app.tenant_user').set({ reporting_manager_id: opts.managerId }).where('id', '=', u.id).execute();
  return { ...u, roleId: role.id };
}

export function act(c: Ctx, token: string, type: string, docId: string, body: unknown, headers: Record<string, string> = {}) {
  return c.http.post(`${API}/docs/${type}/${docId}/actions`).set(bearer(token)).set(headers).send(body as object);
}

export async function summary(c: Ctx, lineId: string) {
  const s = await c.db.selectFrom('app.line_qty_summary').selectAll().where('line_id', '=', lineId).executeTakeFirst();
  const n = (v: unknown) => Number(v ?? 0);
  return { requested: n(s?.requested), approved: n(s?.approved), held: n(s?.held), rejected: n(s?.rejected), cancelled: n(s?.cancelled) };
}

export async function lineStatesOf(c: Ctx, docId: string) {
  const rows = await c.db.selectFrom('app.wf_line_state as s').innerJoin('app.wf_instance as i', 'i.id', 's.instance_id')
    .select(['s.line_id', 's.stage_key', 's.pending_qty', 's.held_qty']).where('i.document_id', '=', docId).where('i.status', '=', 'running').execute();
  const out: Record<string, Record<string, { p: number; h: number }>> = {};
  for (const r of rows) (out[r.line_id] ??= {})[r.stage_key] = { p: Number(r.pending_qty), h: Number(r.held_qty) };
  return out;
}

export async function docStatus(c: Ctx, docId: string) {
  return (await c.db.selectFrom('app.document').select('status_key').where('id', '=', docId).executeTakeFirstOrThrow()).status_key;
}

export async function instanceOf(c: Ctx, docId: string) {
  return c.db.selectFrom('app.wf_instance').selectAll().where('document_id', '=', docId).orderBy('started_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
}

export async function stageStates(c: Ctx, docId: string) {
  const i = await instanceOf(c, docId);
  const rows = await c.db.selectFrom('app.wf_stage_state').selectAll().where('instance_id', '=', i!.id).execute();
  return Object.fromEntries(rows.map(r => [r.stage_key, r]));
}

export const sla = (c: Ctx) => c.app.get(SlaService);

/** Definition builder with schema defaults applied. */
export const wf = (d: unknown) => WorkflowDefinition.parse(d);

/**
 * Tenancy-isolation seed for the workflow tables (and the document rows they need): doc type `wfiso` with a published
 * workflow whose only stage has no eligible actor (→ admins assigned), one submitted document with a held line, and a
 * spare doc type + spare line for the suite's insert-control copies. No users are created (the suite's tenants are
 * at their user cap) and no plan feature is needed (definitions are published through the service).
 */
export async function seedWorkflowIsolation(c: Ctx, s: { tenantId: string; adminId: string; locationId: string; userId: string }) {
  const { DefinitionsService } = await import('../src/modules/workflow');
  const t = { tenantId: s.tenantId, adminId: s.adminId, plantA: { id: s.locationId } } as WfTenant;
  const dt = await createDocType(c, t, 'wfiso', 'Iso request');
  const spare = await createDocType(c, t, 'wfspare', 'Spare type');
  const ref = c.app.get(DocsPortRef);
  ref.use(new FakeDocumentsPort());
  try {
    await inTenant(c, t, async tx => {
      const defs = c.app.get(DefinitionsService);
      const row = await defs.docType(tx, 'wfiso');
      const wfRow = await defs.ensureDef(tx, s.tenantId, row, s.adminId, true);
      await defs.publishDefinition(tx, s.tenantId, row, wfRow, wf({ stages: [
        { key: 's1', name: 'Iso stage', actors: [{ type: 'users', userIds: [s.userId] }], ifNoActor: 'assign_admins', sla: { hours: 1, remindEveryHours: 1 } },
      ] }), 'iso', s.adminId);
    });
    const doc = await makeDoc(c, t, dt, { lines: [{ qty: '5' }, { qty: '2' }] });
    await submitDoc(c, t, doc, s.adminId);
    await inTenant(c, t, async tx => {
      const st = await tx.selectFrom('app.wf_line_state').select(['instance_id']).where('line_id', '=', doc.lineIds[0]!).executeTakeFirstOrThrow();
      // hold line 1 at s1 (as the engine would) so held state + events exist
      await tx.updateTable('app.wf_line_state').set({ pending_qty: '0', held_qty: '5' }).where('instance_id', '=', st.instance_id).where('line_id', '=', doc.lineIds[0]!).execute();
    });
    const spareLine = await c.db.insertInto('app.document_line').values({
      tenant_id: s.tenantId, document_id: doc.id, doc_type_id: dt.id, line_no: 99, qty: '1', location_node_id: s.locationId, custom: '{}', is_deleted: true,
    }).returning('id').executeTakeFirstOrThrow();
    return { docTypeKey: dt.key, docId: doc.id, spareDocTypeId: spare.id, spareLineId: spareLine.id };
  } finally {
    ref.use(null);
  }
}

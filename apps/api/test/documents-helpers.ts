/**
 * Fixtures for the documents-core suites (documents*, numbering*, ledger*, audit*, outbox*).
 */
import type { WorkflowRuntimeView } from '@procure/schema';
import { sql } from 'kysely';
import { DbService, Tx } from '../src/core/db.service';
import { EntitlementsService } from '../src/core/entitlements.service';
import { DOCUMENTS_PORT, DocumentsPort, WorkflowPort } from '../src/core/ports';
import { DOC_ACTIONS, WorkflowLink } from '../src/modules/documents';
import { api, builderTenant, mustOk, userWithKeys } from './forms-helpers';
import { Ctx, uid } from './helpers';

export const CAPEX_HEADER = [
  { key: 'purpose', type: 'textarea', label: 'Purpose', required: true },
  { key: 'priority', type: 'select', label: 'Priority', options: [{ value: 'Normal', label: 'Normal' }, { value: 'Urgent', label: 'Urgent' }], default: 'Normal' },
  { key: 'justification', type: 'textarea', label: 'Justification', visibleWhen: "priority = 'Urgent'", requiredWhen: "priority = 'Urgent'" },
];
export const CAPEX_LINE = [
  { key: 'rate', type: 'currency', label: 'Rate', system: true, hidden: true },
  { key: 'est_rate', type: 'currency', label: 'Estimated rate', required: true },
  { key: 'amount', type: 'formula', label: 'Amount', expr: 'qty * est_rate', precision: 2 },
  { key: 'remarks', type: 'text', label: 'Remarks' },
];

export interface DocsFixture {
  tenantId: string;
  code: string;
  token: string;
  adminId: string;
  pune: string;
  puneMain: string;
  chennai: string;
  uom: string;
  items: string[];
}

/** Tenant with form builder, a location tree (Pune → Main store, Chennai), a unit and two items. */
export async function docsTenant(c: Ctx, limits: Record<string, number | null> = {}): Promise<DocsFixture> {
  const t = await builderTenant(c, { custom_forms: 20, max_locations: 20, ...limits });
  const a = api(c, t.token);
  const pune = await mustOk(a.post('/locations', { code: `PUN-${uid(4)}`, name: 'Pune plant' }), 201);
  const puneMain = await mustOk(a.post('/locations', { parentId: pune.id, code: `PUNM-${uid(4)}`, name: 'Pune main store' }), 201);
  const chennai = await mustOk(a.post('/locations', { code: `CHE-${uid(4)}`, name: 'Chennai plant' }), 201);
  const uom = await mustOk(a.post('/masters/uom/records', { code: `U${uid(4)}`, name: 'Numbers', data: { decimals: '4' } }), 201); // QA3-BUG-003: fractional (ledger precision) unit; whole-unit rules have their own tests
  const i1 = await mustOk(a.post('/masters/item/records', { name: 'Laptop', data: { uom: uom.id } }), 201);
  const i2 = await mustOk(a.post('/masters/item/records', { name: 'Printer', data: { uom: uom.id } }), 201);
  return {
    tenantId: t.tenant.tenantId, code: t.tenant.code, token: t.token, adminId: t.admin.userId, pune: pune.id, puneMain: puneMain.id, chennai: chennai.id,
    uom: uom.id, items: [i1.id, i2.id],
  };
}

export async function createCapexType(c: Ctx, token: string, key = 'capex', extra: Record<string, unknown> = {}) {
  return mustOk(api(c, token).post('/config/doc-types', {
    key, name: 'Capex Request', pluralName: 'Capex Requests', headerDefinition: { fields: CAPEX_HEADER }, lineDefinition: { fields: CAPEX_LINE },
    numberPattern: 'CAPEX/{LOC}/{FYS}/{SEQ:4}', ...extra,
  }), 201);
}

export function capexBody(f: DocsFixture, over: { location?: string; lines?: { item?: string; qty: string; est_rate: string; remarks?: string }[]; values?: Record<string, unknown> } = {}) {
  return {
    values: { location: over.location ?? f.pune, purpose: 'New laptops for the design team', doc_date: '2026-10-01', ...(over.values ?? {}) },
    lines: (over.lines ?? [{ qty: '2', est_rate: '50000' }, { qty: '1', est_rate: '20000' }]).map((l, i) => ({ values: { item: l.item ?? f.items[i % f.items.length], ...l } })),
  };
}

export const docsApi = (c: Ctx, token: string, type = 'capex') => {
  const a = api(c, token);
  return {
    ...a,
    create: (body: unknown) => a.post(`/docs/${type}`, body),
    get: (id: string) => a.get(`/docs/${type}/${id}`),
    update: (id: string, body: unknown) => a.put(`/docs/${type}/${id}`, body),
    submit: (id: string, version: number) => a.post(`/docs/${type}/${id}/submit`, { version }),
    list: (qs = '') => a.get(`/docs/${type}${qs ? `?${qs}` : ''}`),
    counts: (qs = '') => a.get(`/docs/${type}/counts${qs ? `?${qs}` : ''}`),
    raw: a,
  };
};

/** Creates + submits a capex document; returns the submitted DocumentRow. */
export async function submittedCapex(c: Ctx, f: DocsFixture, over: Parameters<typeof capexBody>[1] = {}, token = f.token, type = 'capex') {
  const d = docsApi(c, token, type);
  const doc = await mustOk(d.create(capexBody(f, over)), 201);
  return mustOk(d.submit(doc.id, doc.version), 200);
}

/** A non-admin user holding `keys` (+ optional scope rows) — wraps forms-helpers.userWithKeys. */
export async function docUser(c: Ctx, f: DocsFixture, keys: string[], scopeNodeId?: string) {
  const u = await userWithKeys(c, f.token, f.code, keys);
  if (scopeNodeId) await mustOk(api(c, f.token).put(`/roles/${u.roleId}/scope`, { entries: [{ nodeId: scopeNodeId }] }));
  else await mustOk(api(c, f.token).put(`/roles/${u.roleId}/scope`, { entries: [{ allNodes: true }] }));
  return u;
}

export const ALL_CAPEX_KEYS = (type = 'capex') => [
  // Phase 6 added generated actions (print, send_email, send_whatsapp): derive from the generator's list.
  ...DOC_ACTIONS.map(a => `doc.${type}:action.${a.name}`),
  ...['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'].map(v => `doc.${type}:view.${v}`),
];

/** Adds registry view keys (e.g. waiting_hod) as the workflow module would at publish, and bumps permver. */
export async function addStageViews(c: Ctx, f: DocsFixture, type: string, stages: string[]) {
  const t = await c.db.selectFrom('app.doc_type').select('id').where('tenant_id', '=', f.tenantId).where('key', '=', type).executeTakeFirstOrThrow();
  for (const s of stages) {
    await c.db.insertInto('app.permission_def').values({
      tenant_id: f.tenantId, key: `doc.${type}:view.waiting_${s}`, kind: 'view', tab_key: `doc.${type}`, label: `Waiting for ${s}`, source: 'form', source_id: t.id, sort_order: 10,
    }).onConflict(oc => oc.doNothing()).execute();
  }
  await c.app.get(EntitlementsService).bumpPermissions(f.tenantId);
}

export const workflowLink = (c: Ctx) => c.app.get(WorkflowLink);
export const documentsPort = (c: Ctx) => c.app.get<DocumentsPort>(DOCUMENTS_PORT);
export const tenantTx = <T>(c: Ctx, tenantId: string, fn: (tx: Tx) => Promise<T>) => c.app.get(DbService).tenantTx(tenantId, fn);

/**
 * Minimal in-memory workflow for documents tests: two stages (hod → finance). start() puts every line's qty
 * pending at hod; decide() moves quantities like the real engine would, through DOCUMENTS_PORT.
 */
export class FakeWorkflow implements WorkflowPort {
  readonly order = ['hod', 'finance'];
  readonly state = new Map<string, Map<string, Record<string, { pending: number; held: number }>>>();
  readonly calls: string[] = [];

  async start(tx: Tx, documentId: string): Promise<void> {
    this.calls.push(`start:${documentId}`);
    const lines = await sql<{ id: string; qty: string }>`select id, qty from app.document_line where document_id = ${documentId} and not is_deleted`.execute(tx);
    this.state.set(documentId, new Map(lines.rows.map(l => [l.id, { hod: { pending: Number(l.qty), held: 0 } }])));
  }
  async cancel(_tx: Tx, documentId: string): Promise<void> {
    this.calls.push(`cancel:${documentId}`);
    this.state.delete(documentId);
  }
  async linesCancelled(_tx: Tx, documentId: string, lineIds: string[]): Promise<void> {
    this.calls.push(`linesCancelled:${documentId}:${lineIds.length}`);
    for (const id of lineIds) this.state.get(documentId)?.delete(id);
  }
  async runtimeView(_tx: Tx, documentId: string, viewer: { userId: string; permissions: string[] }): Promise<WorkflowRuntimeView | null> {
    const s = this.state.get(documentId);
    if (!s) return null;
    const active = (k: string) => [...s.values()].some(l => (l[k]?.pending ?? 0) > 0 || (l[k]?.held ?? 0) > 0);
    return {
      instanceId: '00000000-0000-0000-0000-000000000001', workflowVersion: 1, status: 'running',
      stages: this.order.map(k => ({
        key: k, name: k.toUpperCase(), status: active(k) ? 'active' : 'pending', skipReason: null, enteredAt: null, dueAt: null, completedAt: null, overdue: false,
        canAct: viewer.permissions.some(p => p.endsWith(`:action.stage_${k}`)), actors: [],
      })),
      stageActions: { hod: ['approve', 'reject', 'hold', 'send_back'], finance: ['approve', 'reject'] },
      granularity: 'line', editableLineFields: { hod: [], finance: [] },
      requireReasonOn: { hod: ['reject', 'hold', 'send_back', 'partial'], finance: ['reject', 'hold', 'send_back', 'partial'] },
    };
  }
  async lineStages(_tx: Tx, documentId: string) {
    const out: Record<string, Record<string, { pending: string; held: string }>> = {};
    for (const [line, st] of this.state.get(documentId) ?? []) {
      for (const [k, v] of Object.entries(st)) if (v.pending > 0 || v.held > 0) (out[line] ??= {})[k] = { pending: String(v.pending), held: String(v.held) };
    }
    return out;
  }
  async statusKeys() {
    return [{ key: 'waiting_hod', label: 'Waiting for HOD approval' }, { key: 'waiting_finance', label: 'Waiting for Finance review' }];
  }

  /** Applies a decision at a stage for one line (approve moves on / out, hold stays, reject leaves). */
  async decide(c: Ctx, tenantId: string, documentId: string, lineId: string, stage: string, d: { approve?: number; hold?: number; reject?: number }) {
    await tenantTx(c, tenantId, async tx => {
      const port = documentsPort(c);
      const line = this.state.get(documentId)!.get(lineId)!;
      const cur = line[stage]!;
      const approve = d.approve ?? 0; const hold = d.hold ?? 0; const reject = d.reject ?? 0;
      cur.pending -= approve + hold + reject;
      cur.held += hold;
      const events: { lineId: string; type: 'approved' | 'held' | 'rejected'; qty: string }[] = [];
      const next = this.order[this.order.indexOf(stage) + 1];
      if (approve) {
        if (next) line[next] = { pending: (line[next]?.pending ?? 0) + approve, held: line[next]?.held ?? 0 };
        else events.push({ lineId, type: 'approved', qty: String(approve) });
      }
      if (hold) events.push({ lineId, type: 'held', qty: String(hold) });
      if (reject) events.push({ lineId, type: 'rejected', qty: String(reject) });
      if (events.length) await port.recordQuantities(tx, documentId, events, null);
      await port.recomputeStatus(tx, documentId);
    });
  }
}

/**
 * Tenancy-isolation seed for the documents tables (used by tenancy-isolation.test.ts seedSide()). The isolation
 * plan has no form builder (nor custom_forms), so the type is created through the service as a system type (as Phase 4
 * modules provision theirs); everything else goes
 * through the API: a submitted document (numbering_counter, line_event, line_qty_summary, outbox_event), a draft,
 * a comment, an attachment and a saved view. line_link has no API until Phase 4 → inserted as the DB owner.
 */
export async function seedDocumentsIsolation(c: Ctx, s: { tenantId: string; adminId: string; adminToken: string; locationId: string; itemId: string }) {
  const { DocTypeCreate } = await import('@procure/schema');
  const { DocTypesService } = await import('../src/modules/documents');
  await tenantTx(c, s.tenantId, tx => c.app.get(DocTypesService).create(tx, { tenantId: s.tenantId, userId: s.adminId, perms: null }, DocTypeCreate.parse({
    key: 'isodoc', name: 'Iso doc', pluralName: 'Iso docs', numberPattern: 'ISO-{SEQ:3}', lineDefinition: { fields: [{ key: 'note', type: 'text', label: 'Note' }] },
  }), { kind: 'system' }));
  await c.app.get(EntitlementsService).bumpPermissions(s.tenantId);
  const a = api(c, s.adminToken);
  const body = { values: { location: s.locationId }, lines: [{ values: { item: s.itemId, qty: '2', rate: '10', note: 'iso' } }] };
  const doc = await mustOk(a.post('/docs/isodoc', body), 201);
  const sub = await mustOk(a.post(`/docs/isodoc/${doc.id}/submit`, { version: doc.version }));
  const draft = await mustOk(a.post('/docs/isodoc', body), 201);
  const comment = await mustOk(a.post(`/docs/isodoc/${sub.id}/comments`, { body: 'Iso comment' }), 201);
  // (no storage in the isolation plan: a clean file row as the DB owner)
  const file = await c.db.insertInto('app.file_object').values({
    tenant_id: s.tenantId, storage_key: `${s.tenantId}/iso/${uid(12)}.png`, filename: 'iso.png', mime: 'image/png', size_bytes: 3, sha256: 'x', scan_status: 'clean',
  }).returning('id').executeTakeFirstOrThrow();
  const att = await mustOk(a.post(`/docs/isodoc/${sub.id}/attachments`, { fileId: file.id }), 201);
  const view = await mustOk(a.post('/saved-views', { scopeKey: 'doc.isodoc:document', name: 'Iso view', config: { filters: {} } }), 201);
  const series = (await mustOk(a.get('/config/numbering?docType=isodoc')))[0];
  await c.db.insertInto('app.line_link').values({ tenant_id: s.tenantId, from_line_id: sub.lines[0].id, to_line_id: draft.lines[0].id, link_type: 'selected', qty: '1' }).execute();
  return {
    docId: sub.id as string, docVersion: sub.version as number, draftId: draft.id as string, draftVersion: draft.version as number, lineId: sub.lines[0].id as string,
    commentId: comment.id as string, attachmentId: att.id as string, viewId: view.id as string, viewVersion: view.version as number,
    seriesId: series.id as string, seriesVersion: series.version as number,
  };
}

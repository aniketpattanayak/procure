/**
 * Fixtures for the notify suites (notify*.test.ts): tenant with email/WhatsApp/API features, a doc type with a vendor
 * party + contact fields, vendor records, message templates, tenant-scoped `log` providers, WhatsApp templates, and
 * helpers that drive the trigger engine / sender directly (deterministic, no worker timing).
 */
import { sql } from 'kysely';
import { DbService, Tx } from '../src/core/db.service';
import { EntitlementsService } from '../src/core/entitlements.service';
import type { TemplateRenderer } from '../src/core/ports';
import { QueueService } from '../src/core/queue.service';
import { FilesService } from '../src/modules/files';
import { EventJob, RendererRef, SEND_JOB_OPTS, SenderService, TriggerEngine, WEBHOOK_QUEUE } from '../src/modules/notify';
import { api, mustOk } from './forms-helpers';
import { bearer, API, Ctx, superAdmin, tenantWithAdmin, uid } from './helpers';
import type { DocType, WfTenant } from './workflow-helpers';
import { WF_FEATURES } from './workflow-helpers';

export const NOTIFY_FEATURES = [...WF_FEATURES, 'email', 'whatsapp', 'api_access'];
export const NOTIFY_QUEUES = ['send-email', 'send-whatsapp', WEBHOOK_QUEUE, 'events-notify', 'notify-maint'];

export interface NotifyTenant extends WfTenant { saToken: string }

export async function notifyTenant(c: Ctx, o: { features?: string[]; limits?: Record<string, number | null>; saToken?: string } = {}): Promise<NotifyTenant> {
  const saToken = o.saToken ?? (await superAdmin(c)).token;
  const { tenant, admin } = await tenantWithAdmin(c, saToken, {
    features: o.features ?? NOTIFY_FEATURES,
    limits: { max_users: 200, custom_forms: 20, max_locations: 20, storage_gb: 1, email_per_month: 1000, whatsapp_per_month: 1000, webhook_endpoints: 5, ...o.limits },
  });
  const a = api(c, admin.token);
  const pa = await mustOk(a.post('/locations', { code: `PA-${uid(4)}`, name: 'Plant A' }), 201);
  const sa2 = await mustOk(a.post('/locations', { parentId: pa.id, code: `SA-${uid(4)}`, name: 'Store A' }), 201);
  const pb = await mustOk(a.post('/locations', { code: `PB-${uid(4)}`, name: 'Plant B' }), 201);
  const path = async (id: string) => (await sql<{ p: string }>`select path::text as p from app.location_node where id = ${id}`.execute(c.db)).rows[0]!.p;
  return {
    tenantId: tenant.tenantId, code: tenant.code, token: admin.token, adminId: admin.userId, saToken,
    plantA: { id: pa.id, path: await path(pa.id) }, storeA: { id: sa2.id, path: await path(sa2.id) }, plantB: { id: pb.id, path: await path(pb.id) },
  };
}

const HEADER = [
  { key: 'location', type: 'lookup', label: 'Location', system: true, required: true, source: { kind: 'location' } },
  { key: 'doc_date', type: 'date', label: 'Date', system: true },
  { key: 'party', type: 'lookup', label: 'Vendor', system: true, source: { kind: 'master', masterKey: 'vendor' } },
  { key: 'total_amount', type: 'currency', label: 'Total', system: true },
  { key: 'purpose', type: 'text', label: 'Purpose' },
  { key: 'priority', type: 'select', label: 'Priority', options: [{ value: 'Normal', label: 'Normal' }, { value: 'Urgent', label: 'Urgent' }] },
  { key: 'approver', type: 'lookup', label: 'Approver', source: { kind: 'user' } },
  { key: 'contact_email', type: 'email', label: 'Contact email' },
  { key: 'contact_phone', type: 'phone', label: 'Contact phone' },
];
const LINE = [
  { key: 'qty', type: 'decimal', label: 'Qty', system: true, required: true },
  { key: 'rate', type: 'currency', label: 'Rate', system: true },
  { key: 'amount', type: 'currency', label: 'Amount', system: true },
];

async function form(c: Ctx, tenantId: string, key: string, name: string, fields: unknown[]) {
  const f = await c.db.insertInto('app.form_def').values({ tenant_id: tenantId, key, name, kind: 'transaction', is_system: false }).returning('id').executeTakeFirstOrThrow();
  const v = await c.db.insertInto('app.form_version').values({ tenant_id: tenantId, form_id: f.id, version: 1, definition: JSON.stringify({ fields, validations: [] }) }).returning('id').executeTakeFirstOrThrow();
  await c.db.updateTable('app.form_def').set({ current_version_id: v.id }).where('id', '=', f.id).execute();
  return { formId: f.id, versionId: v.id };
}

/** Doc type with a vendor party (+ the static registry keys, incl. send_email / send_whatsapp, via the documents core). */
export async function notifyDocType(c: Ctx, t: WfTenant, key = `n${uid(6)}`, name = 'Purchase order'): Promise<DocType> {
  const h = await form(c, t.tenantId, `${key}_header`, `${name} header`, HEADER);
  const l = await form(c, t.tenantId, `${key}_line`, `${name} line`, LINE);
  const dt = await c.db.insertInto('app.doc_type').values({
    tenant_id: t.tenantId, key, name, plural_name: `${name}s`, kind: 'custom', header_form_id: h.formId, line_form_id: l.formId, settings: '{}',
  }).returning('id').executeTakeFirstOrThrow();
  const { DocTypesService } = await import('../src/modules/documents');
  await c.app.get(DbService).tenantTx(t.tenantId, tx => c.app.get(DocTypesService).upsertRegistry(tx, t.tenantId, { id: dt.id, key, name, plural_name: `${name}s`, module_key: null }));
  await c.app.get(EntitlementsService).bumpPermissions(t.tenantId);
  return { id: dt.id, key, headerVersionId: h.versionId, lineVersionId: l.versionId };
}

export async function vendor(c: Ctx, t: WfTenant, data: Record<string, unknown> = {}, name = `Vendor ${uid(4)}`) {
  return mustOk<{ id: string; name: string }>(api(c, t.token).post('/masters/vendor/records', { name, data }), 201);
}

/** Draft document (as the DB owner) with party + header values; returns ids. */
export async function makeNotifyDoc(c: Ctx, t: WfTenant, dt: DocType, o: { party?: string | null; values?: Record<string, unknown>; locationId?: string; createdBy?: string; lines?: { qty: string; rate?: string }[] } = {}) {
  const lines = o.lines ?? [{ qty: '2', rate: '500' }];
  const total = lines.reduce((s, l) => s + Number(l.qty) * Number(l.rate ?? 0), 0).toString();
  const d = await c.db.insertInto('app.document').values({
    tenant_id: t.tenantId, doc_type_id: dt.id, location_node_id: o.locationId ?? t.plantA.id, custom: JSON.stringify({ purpose: 'Laptops', ...(o.values ?? {}) }),
    party_id: o.party ?? null, total_amount: total, form_version_id: dt.headerVersionId, line_form_version_id: dt.lineVersionId, created_by: o.createdBy ?? t.adminId,
  }).returning('id').executeTakeFirstOrThrow();
  const lineIds: string[] = [];
  for (const [i, l] of lines.entries()) {
    const r = await c.db.insertInto('app.document_line').values({
      tenant_id: t.tenantId, document_id: d.id, doc_type_id: dt.id, line_no: i + 1, qty: l.qty, rate: l.rate ?? null,
      amount: l.rate ? (Number(l.qty) * Number(l.rate)).toString() : null, location_node_id: o.locationId ?? t.plantA.id, custom: '{}',
    }).returning('id').executeTakeFirstOrThrow();
    lineIds.push(r.id);
  }
  return { id: d.id, lineIds };
}

export interface Templates { email: string; inapp: string; pdf: string; whatsapp: string | null }

/** Message templates for a doc type (inserted as the DB owner; template CRUD belongs to the Templates module). */
export async function templates(c: Ctx, t: WfTenant, docTypeKey: string, waTemplateId: string | null = null): Promise<Templates> {
  const ins = async (v: { channel: 'pdf' | 'email' | 'whatsapp' | 'inapp'; key: string; subject?: string; body: string; doc?: string | null; wa?: string | null; vars?: unknown[] }) =>
    (await c.db.insertInto('app.message_template').values({
      tenant_id: t.tenantId, channel: v.channel, doc_type_key: v.doc === undefined ? docTypeKey : v.doc, key: v.key, name: v.key, subject: v.subject ?? null, body: v.body,
      whatsapp_template_id: v.wa ?? null, whatsapp_variables: JSON.stringify(v.vars ?? []),
    }).returning('id').executeTakeFirstOrThrow()).id;
  const k = uid(5);
  return {
    email: await ins({ channel: 'email', key: `e_${k}`, subject: 'Order {{document.number}}', body: '<p>Dear {{recipient.name}}, order {{document.number}} for {{document.values.purpose}}.</p>' }),
    inapp: await ins({ channel: 'inapp', key: `i_${k}`, subject: 'Pending: {{document.number}}', body: '{{document.number}} needs you', doc: null }),
    pdf: await ins({ channel: 'pdf', key: `p_${k}`, body: '<h1>{{document.number}}</h1>' }),
    whatsapp: waTemplateId
      ? await ins({ channel: 'whatsapp', key: `w_${k}`, body: 'wa', wa: waTemplateId, vars: [{ index: 1, expr: '{{recipient.name}}' }, { index: 2, expr: '{{document.number}}' }] })
      : null,
  };
}

/** Tenant-scoped provider via the Super Admin API (never touches the platform default). */
export async function provider(c: Ctx, t: NotifyTenant, channel: 'email' | 'whatsapp', providerKind = 'log', config: Record<string, unknown> = {}, secret?: string) {
  return mustOk<{ id: string; version: number }>(c.http.post(`${API}/platform/providers`).set(bearer(t.saToken))
    .send({ tenantId: t.tenantId, channel, provider: providerKind, config, ...(secret ? { secret } : {}) }), 201);
}

/** Platform WhatsApp template allowed for the tenant. */
export async function waTemplate(c: Ctx, t: NotifyTenant, o: { headerKind?: 'none' | 'document'; name?: string } = {}) {
  const tpl = await mustOk<{ id: string }>(c.http.post(`${API}/platform/whatsapp-templates`).set(bearer(t.saToken)).send({
    name: o.name ?? `t_${uid(8)}`, category: 'utility', headerKind: o.headerKind ?? 'none', body: 'Hello {{1}}, order {{2}} is ready.',
    variables: [{ index: 1, label: 'Name' }, { index: 2, label: 'Number' }],
  }), 201);
  const cur = await mustOk<{ templateIds: string[] }>(c.http.get(`${API}/platform/tenants/${t.tenantId}/whatsapp-templates`).set(bearer(t.saToken)));
  await mustOk(c.http.put(`${API}/platform/tenants/${t.tenantId}/whatsapp-templates`).set(bearer(t.saToken)).send({ templateIds: [...cur.templateIds, tpl.id] }));
  return tpl.id;
}

export async function rule(c: Ctx, t: WfTenant, body: Record<string, unknown>) {
  return mustOk<{ id: string; version: number }>(api(c, t.token).post('/config/triggers', { name: `Rule ${uid(4)}`, ...body }), 201);
}

/** Outbox events of a document (optionally of some types) as `events-notify` jobs, in id order. */
export async function outboxEvents(c: Ctx, docId: string, types?: string[]): Promise<EventJob[]> {
  let q = c.db.selectFrom('app.outbox_event').selectAll().where('aggregate_id', '=', docId);
  if (types) q = q.where('event_type', 'in', types);
  const rows = await q.orderBy('id').execute();
  return rows.map(r => ({
    outboxId: String(r.id), tenantId: r.tenant_id, type: r.event_type, aggregate: { kind: r.aggregate_kind, id: r.aggregate_id },
    payload: r.payload as Record<string, unknown>, at: new Date(r.created_at).toISOString(),
  }));
}

/** Synthetic event (when no document action is needed). */
export function event(t: WfTenant, type: string, docId: string | null, payload: Record<string, unknown> = {}): EventJob {
  return { outboxId: String(Math.floor(Math.random() * 1e12) + 1e12), tenantId: t.tenantId, type, aggregate: { kind: 'document', id: docId }, payload: { documentId: docId, ...payload }, at: new Date().toISOString() };
}

export const engine = (c: Ctx) => c.app.get(TriggerEngine);
export const sender = (c: Ctx) => c.app.get(SenderService);

export async function messagesOf(c: Ctx, tenantId: string, docId?: string) {
  let q = c.db.selectFrom('app.outbound_message').selectAll().where('tenant_id', '=', tenantId);
  if (docId) q = q.where('document_id', '=', docId);
  return q.orderBy('created_at').orderBy('recipient').execute();
}

/** Runs the send job of every queued email/WhatsApp message of a tenant once (like a worker, first attempt). */
export async function sendQueued(c: Ctx, tenantId: string, attemptsMade = 0) {
  const rows = await c.db.selectFrom('app.outbound_message').select(['id', 'channel', 'trigger_rule_id']).where('tenant_id', '=', tenantId).where('status', '=', 'queued').execute();
  const out: { id: string; status: string }[] = [];
  for (const r of rows) {
    const q = c.app.get(QueueService).queue(r.channel === 'email' ? 'send-email' : 'send-whatsapp');
    const job = await q.getJob(`msg:${r.id}`);
    const data = job?.data ?? { messageId: r.id, tenantId, attachPdfTemplateId: null };
    const res = await sender(c).process(r.channel as 'email' | 'whatsapp', { data, attemptsMade, opts: { attempts: SEND_JOB_OPTS.attempts } }).catch(e => ({ status: `error:${(e as Error).message}` }));
    out.push({ id: r.id, status: res.status });
  }
  return out;
}

/** Replaces only pdfForDocument (no Chromium): uploads a tiny PDF once per document and returns it. */
export function stubPdf(c: Ctx) {
  const ref = c.app.get(RendererRef);
  ref.use(null);
  const real = ref.get();
  const cache = new Map<string, string>();
  const calls: { documentId: string; templateId: string | null; waitMs?: number }[] = [];
  const stub: TemplateRenderer = {
    documentContext: (tx, id) => real.documentContext(tx, id),
    render: (tx, id, ctx) => real.render(tx, id, ctx),
    async pdfForDocument(tx: Tx, documentId: string, templateId: string | null, opts?: { waitMs?: number }) {
      calls.push({ documentId, templateId, waitMs: opts?.waitMs });
      let fileId = cache.get(documentId);
      if (!fileId) {
        const tenantId = (await sql<{ t: string }>`select app.current_tenant_id()::text as t`.execute(tx)).rows[0]!.t;
        const buffer = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
        const meta = await c.app.get(FilesService).upload(tenantId, null, { originalname: 'Order.pdf', buffer, size: buffer.length });
        fileId = meta.id;
        cache.set(documentId, fileId);
      }
      return { id: documentId, fileId };
    },
  };
  ref.use(stub);
  return { calls, restore: () => ref.use(null) };
}

/** Drops jobs this suite left in the notify queues (so later suites that start workers never pick them up). */
export async function cleanQueues(c: Ctx) {
  const q = c.app.get(QueueService);
  for (const n of NOTIFY_QUEUES) await q.queue(n).obliterate({ force: true }).catch(() => undefined);
}

export async function withTx<T>(c: Ctx, tenantId: string, fn: (tx: Tx) => Promise<T>) {
  return c.app.get(DbService).tenantTx(tenantId, fn);
}

/**
 * Tenancy-isolation seed for the notify tables (tenancy-isolation.test.ts seedSide()): trigger_rule, outbound_message,
 * webhook_endpoint and webhook_delivery as the DB owner (the isolation plan has no email / api_access features).
 */
export async function seedNotifyIsolation(c: Ctx, s: { tenantId: string; documentId: string }) {
  const tpl = await c.db.insertInto('app.message_template').values({
    tenant_id: s.tenantId, channel: 'email', doc_type_key: null, key: `iso_${uid(8)}`, name: 'Iso email', subject: 'Iso', body: '<p>iso</p>',
  }).returning('id').executeTakeFirstOrThrow();
  const rule = await c.db.insertInto('app.trigger_rule').values({
    tenant_id: s.tenantId, name: 'Iso rule', event_type: 'document.submitted', channel: 'email', template_id: tpl.id, recipients: JSON.stringify([{ type: 'fixed', address: 'iso@x.test' }]),
  }).returning(['id', 'version']).executeTakeFirstOrThrow();
  const msg = await c.db.insertInto('app.outbound_message').values({
    tenant_id: s.tenantId, channel: 'email', idempotency_key: `iso-${uid(12)}`, trigger_rule_id: rule.id, template_id: tpl.id, document_id: s.documentId,
    recipient: 'iso@x.test', subject: 'Iso', body_preview: '<p>iso</p>', status: 'failed', error: 'iso',
  }).returning('id').executeTakeFirstOrThrow();
  const ep = await c.db.insertInto('app.webhook_endpoint').values({
    tenant_id: s.tenantId, url: 'https://hooks.iso.test/in', events: ['*'], secret: 'v1:x:y:z',
  }).returning('id').executeTakeFirstOrThrow();
  await c.db.insertInto('app.webhook_delivery').values({ tenant_id: s.tenantId, endpoint_id: ep.id, outbox_id: Math.floor(Math.random() * 1e9) + 1, event_type: 'document.submitted' }).execute();
  return { templateId: tpl.id, ruleId: rule.id, ruleVersion: rule.version, messageId: msg.id, endpointId: ep.id };
}

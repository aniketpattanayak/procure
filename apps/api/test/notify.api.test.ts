/**
 * Notify HTTP API: trigger rule CRUD + validation + events catalogue, manual send (preview → edit → send,
 * idempotent), message log + cursor, per-document messages + timeline + suggested sends, permissions,
 * cross-tenant isolation, default rule installer, and the full path through the real workers
 * (outbox relay → events-notify → send-email → log provider writes the email with a real PDF attachment).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/core/db.service';
import { QueueService } from '../src/core/queue.service';
import { DEFAULT_RULE_NAME, installDefaultRules, RendererRef } from '../src/modules/notify';
import { logDir } from '../src/modules/notify/channels/types';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, startWorkers, uid } from './helpers';
import { createRole } from './permissions-helpers';
import {
  cleanQueues, engine, event, makeNotifyDoc, messagesOf, notifyDocType, notifyTenant, NotifyTenant, provider, rule, sendQueued, stubPdf, templates, Templates, vendor, waTemplate,
} from './notify-helpers';
import { DocType, publishWorkflow, submitDoc, wfUser } from './workflow-helpers';

describe('notify: API', () => {
  let c: Ctx;
  let t: NotifyTenant;
  let dt: DocType;
  let tpl: Templates;
  let ven: { id: string; name: string };
  let wa: string;

  beforeAll(async () => {
    c = await bootApp();
    t = await notifyTenant(c);
    dt = await notifyDocType(c, t);
    wa = await waTemplate(c, t, { headerKind: 'document' });
    tpl = await templates(c, t, dt.key, wa);
    ven = await vendor(c, t, { email: 'sales@vendor.test', phone: '9876543210' }, 'Vendor One');
    await provider(c, t, 'email');
    await provider(c, t, 'whatsapp');
  });
  afterAll(async () => {
    c.app.get(RendererRef).use(null);
    await cleanQueues(c);
    await closeApp(c);
  });
  const a = () => api(c, t.token);

  describe('trigger rules', () => {
    const base = () => ({ name: 'R', eventType: 'document.submitted', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }] });

    it('CRUD with version check; delete of a used rule deactivates it', async () => {
      const r = await mustOk(a().post('/config/triggers', { ...base(), condition: "priority = 'Urgent' and total_amount > 10 and doc_status <> 'draft'" }), 201);
      expect(r).toMatchObject({ name: 'R', mode: 'auto', isActive: true, version: 1, condition: "priority = 'Urgent' and total_amount > 10 and doc_status <> 'draft'" });
      const list = await mustOk(a().get(`/config/triggers?docTypeKey=${dt.key}`));
      expect(list.map((x: { id: string }) => x.id)).toContain(r.id);
      const up = await mustOk(a().put(`/config/triggers/${r.id}`, { ...base(), name: 'R2', mode: 'manual', version: 1 }));
      expect(up).toMatchObject({ name: 'R2', mode: 'manual', version: 2 });
      expect(up).not.toHaveProperty('condition');
      expect((await a().put(`/config/triggers/${r.id}`, { ...base(), version: 1 })).status).toBe(409);
      // unused → hard delete
      await mustOk(a().del(`/config/triggers/${r.id}`), 204);
      expect((await a().get(`/config/triggers/${r.id}`)).status).toBe(404);
      // used → deactivated, the message log keeps the reference
      const used = await mustOk(a().post('/config/triggers', { ...base(), eventType: 'po.amended' }), 201);
      const d = await makeNotifyDoc(c, t, dt, { party: ven.id });
      await engine(c).handle(event(t, 'po.amended', d.id));
      await mustOk(a().del(`/config/triggers/${used.id}`), 204);
      expect(await mustOk(a().get(`/config/triggers/${used.id}`))).toMatchObject({ isActive: false });
      const audit = await c.db.selectFrom('app.audit_log').select('action').where('tenant_id', '=', t.tenantId).where('entity', '=', 'trigger_rule').execute();
      expect(audit.map(x => x.action)).toEqual(expect.arrayContaining(['create', 'update', 'delete', 'deactivate']));
    });

    it('validation: event, template channel/doc type, PDF template, recipients, condition, WhatsApp approval, plan', async () => {
      const bad = async (body: Record<string, unknown>, path: string) => {
        const r = await a().post('/config/triggers', { ...base(), ...body });
        expect(r.status, JSON.stringify(r.body)).toBe(400);
        expect(r.body.errors.map((e: { path: string }) => e.path), JSON.stringify(r.body)).toContain(path);
      };
      await bad({ eventType: 'Not An Event' }, 'eventType');
      await bad({ eventType: 'notify.effect_send' }, 'eventType');
      await bad({ docTypeKey: 'nope_type' }, 'docTypeKey');
      await bad({ templateId: tpl.inapp }, 'templateId');
      await bad({ templateId: tpl.pdf }, 'templateId');
      await bad({ attachPdfTemplateId: tpl.email }, 'attachPdfTemplateId');
      await bad({ channel: 'inapp', templateId: tpl.inapp, recipients: [{ type: 'party' }] }, 'recipients.0');
      await bad({ channel: 'inapp', templateId: tpl.inapp, recipients: [{ type: 'users', userIds: [t.adminId] }], attachPdfTemplateId: tpl.pdf }, 'attachPdfTemplateId');
      await bad({ recipients: [{ type: 'role', roleId: '00000000-0000-4000-8000-000000000001' }] }, 'recipients.0.roleId');
      await bad({ recipients: [{ type: 'users', userIds: ['00000000-0000-4000-8000-000000000002'] }] }, 'recipients.0.userIds.0');
      await bad({ recipients: [{ type: 'stage_actors', stage: 'nope' }] }, 'recipients.0.stage');
      await bad({ recipients: [{ type: 'stage_actors', stage: '_current' }] }, 'recipients.0.stage');
      await bad({ recipients: [{ type: 'field', field: 'nope' }] }, 'recipients.0.field');
      await bad({ recipients: [{ type: 'fixed', address: 'not-an-email' }] }, 'recipients.0.address');
      await bad({ channel: 'whatsapp', templateId: tpl.whatsapp, recipients: [{ type: 'fixed', address: '12' }] }, 'recipients.0.address');
      await bad({ docTypeKey: null, recipients: [{ type: 'party' }] }, 'recipients.0');
      await bad({ condition: 'nope_field > 1' }, 'condition');
      await bad({ condition: 'total_amount + 1' }, 'condition');
      await bad({ docTypeKey: null, recipients: [{ type: 'fixed', address: 'a@b.test' }], condition: 'total_amount > 1' }, 'condition');
      // other doc type's template
      const other = await notifyDocType(c, t);
      await bad({ docTypeKey: other.key }, 'templateId');
      // WhatsApp template not (or no longer) approved for the tenant
      const foreign = await c.db.insertInto('app.message_template').values({ tenant_id: t.tenantId, channel: 'whatsapp', doc_type_key: dt.key, key: `wx_${uid(5)}`, name: 'x', body: 'x', whatsapp_template_id: null }).returning('id').executeTakeFirstOrThrow();
      await bad({ channel: 'whatsapp', templateId: foreign.id, recipients: [{ type: 'party' }] }, 'templateId');
      // channel not in plan
      const plain = await notifyTenant(c, { saToken: t.saToken, features: ['indent', 'purchase', 'form_builder'] });
      const pdt = await notifyDocType(c, plain);
      const ptpl = await templates(c, plain, pdt.key);
      const r = await api(c, plain.token).post('/config/triggers', { ...base(), docTypeKey: pdt.key, templateId: ptpl.email });
      expect(r.status).toBe(400);
      expect(r.body.errors[0]).toMatchObject({ path: 'channel', message: 'Email is not included in your plan.' });
      // valid stage_actors once a workflow is published; `_current` with stage events
      const role = await createRole(c, t.token, 'Approver');
      await publishWorkflow(c, t.token, dt.key, { stages: [{ key: 'hod', name: 'HOD', actors: [{ type: 'role', roleId: role.id }] }] });
      await mustOk(a().post('/config/triggers', { ...base(), recipients: [{ type: 'stage_actors', stage: 'hod' }, { type: 'role', roleId: role.id }] }), 201);
      await mustOk(a().post('/config/triggers', { ...base(), eventType: 'workflow.stage_entered', docTypeKey: null, channel: 'inapp', templateId: tpl.inapp, recipients: [{ type: 'stage_actors', stage: '_current' }] }), 201);
      await c.db.updateTable('app.trigger_rule').set({ is_active: false }).where('tenant_id', '=', t.tenantId).execute();
    });

    it('events catalogue: domain + Phase 4 events + `emit` events of published workflows', async () => {
      const role = await createRole(c, t.token, 'Emitter');
      const edt = await notifyDocType(c, t);
      await publishWorkflow(c, t.token, edt.key, { stages: [{ key: 's1', name: 'S1', actors: [{ type: 'role', roleId: role.id }], effects: { onApprove: [{ effect: 'emit', event: 'capex.cleared' }] } }] });
      const ev = await mustOk<{ type: string; label: string; docScoped: boolean }[]>(a().get('/config/triggers/events'));
      const types = ev.map(e => e.type);
      expect(types).toEqual(expect.arrayContaining(['document.status_changed', 'workflow.stage_entered', 'limit.warning', 'po.amended', 'capex.cleared']));
      expect(types.some(x => x.startsWith('notify.'))).toBe(false);
      expect(ev.find(e => e.type === 'limit.warning')!.docScoped).toBe(false);
    });
  });

  describe('manual send + message log', () => {
    let doc: { id: string; lineIds: string[] };
    let pdf: ReturnType<typeof stubPdf>;
    beforeAll(async () => {
      pdf = stubPdf(c);
      doc = await makeNotifyDoc(c, t, dt, { party: ven.id });
      await submitDoc(c, t, doc, t.adminId);
    });
    afterAll(() => pdf.restore());

    it('preview renders for the first recipient, flags invalid addresses, lists the PDF and the quota', async () => {
      const p = await mustOk(a().post(`/docs/${dt.key}/${doc.id}/send/preview`, { channel: 'email', templateId: tpl.email, recipients: ['Sales@Vendor.test', 'bad'], attachPdfTemplateId: tpl.pdf }), 200);
      expect(p.subject).toMatch(/^Order /);
      expect(p.body).toContain('Dear Vendor One');
      expect(p.recipients).toEqual([{ address: 'sales@vendor.test', name: 'Vendor One', valid: true }, { address: 'bad', name: null, valid: false, reason: 'Not a valid email address' }]);
      expect(p.attachments).toHaveLength(1);
      expect(p.attachments[0].name).toMatch(/\.pdf$/);
      expect(p.quota).toEqual({ used: expect.any(Number), limit: 1000 });
      const w = await mustOk(a().post(`/docs/${dt.key}/${doc.id}/send/preview`, { channel: 'whatsapp', templateId: tpl.whatsapp, recipients: ['98765 43210'] }), 200);
      expect(w).toMatchObject({ subject: null, recipients: [{ address: '+919876543210', valid: true }], attachments: [{ name: expect.stringMatching(/\.pdf$/) }] });
      expect(w.body).toMatch(/^Hello Vendor One, order /);
      const edited = await mustOk(a().post(`/docs/${dt.key}/${doc.id}/send/preview`, { channel: 'email', templateId: tpl.email, recipients: ['x@y.test'], subject: 'Custom', body: '<p>Edited</p>' }), 200);
      expect(edited).toMatchObject({ subject: 'Custom', body: '<p>Edited</p>' });
      expect((await a().post(`/docs/${dt.key}/${doc.id}/send/preview`, { channel: 'whatsapp', templateId: tpl.whatsapp, recipients: ['+919876543210'], body: 'x' })).status).toBe(400);
      expect((await a().post(`/docs/${dt.key}/${doc.id}/send/preview`, { channel: 'inapp', templateId: tpl.inapp, recipients: ['x'] })).status).toBe(400);
      expect((await a().post(`/docs/${dt.key}/${doc.id}/send/preview`, { channel: 'email', templateId: tpl.whatsapp, recipients: ['x@y.test'] })).status).toBe(400);
    });

    it('send: edited content, one row per recipient, idempotent on the client key, invalid → 400, then the log', async () => {
      const body = { channel: 'email', templateId: tpl.email, recipients: ['sales@vendor.test', 'buyer@x.test'], subject: 'PO for you', body: '<p>See attached</p>', attachPdfTemplateId: tpl.pdf, idempotencyKey: `k-${uid(10)}` };
      const rows = await mustOk(a().post(`/docs/${dt.key}/${doc.id}/send`, body), 201);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ channel: 'email', subject: 'PO for you', bodyPreview: 'See attached', status: 'queued', manual: true, document: { id: doc.id, docTypeKey: dt.key } });
      const again = await mustOk(a().post(`/docs/${dt.key}/${doc.id}/send`, body), 201);
      expect(again.map((r: { id: string }) => r.id).sort()).toEqual(rows.map((r: { id: string }) => r.id).sort());
      const bad = await a().post(`/docs/${dt.key}/${doc.id}/send`, { ...body, recipients: ['ok@x.test', 'nope'], idempotencyKey: `k-${uid(10)}` });
      expect(bad.status).toBe(400);
      expect(bad.body.errors[0].path).toBe('recipients.1');
      await sendQueued(c, t.tenantId);
      const sent = await messagesOf(c, t.tenantId, doc.id);
      expect(sent.filter(m => m.manual).every(m => m.status === 'sent' && m.attachment_file_ids.length === 1)).toBe(true);
      const file = JSON.parse(readFileSync(join(logDir(), t.tenantId, `${rows[0].id}.json`), 'utf8'));
      expect(file).toMatchObject({ subject: 'PO for you', html: '<p>See attached</p>', attachments: [{ filename: 'Order.pdf', contentType: 'application/pdf' }] });

      // per-document list + timeline
      const docMsgs = await mustOk(a().get(`/docs/${dt.key}/${doc.id}/messages`));
      expect(docMsgs).toHaveLength(2);
      const tl = await mustOk<{ id: string; title: string }[]>(a().get(`/docs/${dt.key}/${doc.id}/timeline`));
      expect(tl.filter(e => e.id.startsWith('msg:')).map(e => e.title)).toEqual(expect.arrayContaining([expect.stringMatching(/^Emailed .*buyer@x\.test.*\(sent\)$/)]));

      // log: filters + cursor paging
      const p1 = await mustOk(a().get(`/messages?documentId=${doc.id}&limit=1`));
      expect(p1.data).toHaveLength(1);
      expect(p1.nextCursor).toBeTruthy();
      const p2 = await mustOk(a().get(`/messages?documentId=${doc.id}&limit=1&cursor=${p1.nextCursor}`));
      expect(p2.data).toHaveLength(1);
      expect(p2.data[0].id).not.toBe(p1.data[0].id);
      expect((await mustOk(a().get(`/messages?documentId=${doc.id}&limit=1&cursor=${p2.nextCursor ?? ''}`))).data.length).toBeLessThanOrEqual(1);
      expect((await mustOk(a().get('/messages?status=sent&channel=email'))).data.every((m: { status: string; channel: string }) => m.status === 'sent' && m.channel === 'email')).toBe(true);
      expect((await a().get('/messages?cursor=garbage')).status).toBe(400);
    });

    it('send options: templates + suggested per channel, PDF templates with the print key, party contact, quota', async () => {
      const r = await rule(c, t, { name: 'WhatsApp vendor', eventType: 'document.status_changed', docTypeKey: dt.key, channel: 'whatsapp', templateId: tpl.whatsapp, recipients: [{ type: 'party' }], mode: 'manual' });
      const o = await mustOk(a().get(`/docs/${dt.key}/${doc.id}/send/options`));
      expect(o.email.templates.map((x: { id: string }) => x.id)).toContain(tpl.email);
      expect(o.whatsapp.templates.map((x: { id: string }) => x.id)).toEqual([tpl.whatsapp]);
      expect(o.whatsapp.suggested).toContainEqual({ ruleId: r.id, name: 'WhatsApp vendor', templateId: tpl.whatsapp, attachPdfTemplateId: null, recipients: ['+919876543210'] });
      expect(o.pdfTemplates.map((x: { id: string }) => x.id)).toContain(tpl.pdf);
      expect(o.party).toEqual({ name: 'Vendor One', email: 'sales@vendor.test', phone: '+919876543210' });
      expect(o.quota.email).toEqual({ used: expect.any(Number), limit: 1000 });
      expect(o.quota.whatsapp).toEqual({ used: expect.any(Number), limit: 1000 });
      const status = (await c.db.selectFrom('app.document').select('status_key').where('id', '=', doc.id).executeTakeFirstOrThrow()).status_key;
      const see = [`doc.${dt.key}:action.view`, `doc.${dt.key}:view.${status}`];
      const emailOnly = await wfUser(c, t, [...see, `doc.${dt.key}:action.send_email`], { scopeNode: null });
      const eo = await mustOk(api(c, emailOnly.token).get(`/docs/${dt.key}/${doc.id}/send/options`));
      expect(eo.whatsapp).toBeNull();
      expect(eo.quota.whatsapp).toBeNull();
      expect(eo.pdfTemplates).toEqual([]); // no print key
      expect(eo.email.templates.length).toBeGreaterThan(0);
      const viewer = await wfUser(c, t, see, { scopeNode: null });
      expect((await api(c, viewer.token).get(`/docs/${dt.key}/${doc.id}/send/options`)).status).toBe(403);
      await c.db.updateTable('app.trigger_rule').set({ is_active: false }).where('id', '=', r.id).execute();
    });

    it('recipient tokens party / submitter resolve server-side; money variables are formatted', async () => {
      const p = await mustOk(a().post(`/docs/${dt.key}/${doc.id}/send/preview`, { channel: 'email', templateId: tpl.email, recipients: ['party', 'submitter', 'sales@vendor.test'] }), 200);
      const admin = await c.db.selectFrom('app.tenant_user').select(['email', 'name']).where('id', '=', t.adminId).executeTakeFirstOrThrow();
      expect(p.recipients).toEqual([
        { address: 'sales@vendor.test', name: 'Vendor One', valid: true },
        { address: admin.email.toLowerCase(), name: admin.name, valid: true },
      ]);
      const noParty = await makeNotifyDoc(c, t, dt);
      await submitDoc(c, t, noParty, t.adminId);
      const np = await mustOk(a().post(`/docs/${dt.key}/${noParty.id}/send/preview`, { channel: 'email', templateId: tpl.email, recipients: ['party'] }), 200);
      expect(np.recipients[0]).toMatchObject({ address: 'party', valid: false });
      expect((await a().post(`/docs/${dt.key}/${noParty.id}/send`, { channel: 'email', templateId: tpl.email, recipients: ['party'], idempotencyKey: `k-${uid(10)}` })).status).toBe(400);
      const sent = await mustOk(a().post(`/docs/${dt.key}/${doc.id}/send`, { channel: 'whatsapp', templateId: tpl.whatsapp, recipients: ['party'], idempotencyKey: `k-${uid(10)}` }), 201);
      expect(sent).toMatchObject([{ recipient: '+919876543210', recipientName: 'Vendor One' }]);
      // a WhatsApp variable mapped to {{document.totalAmount}} shows money, never 1000.0000
      const { formatMoney } = await import('../src/modules/templates');
      const money = await c.db.insertInto('app.message_template').values({
        tenant_id: t.tenantId, channel: 'whatsapp', doc_type_key: dt.key, key: `wm_${uid(5)}`, name: 'money', body: 'wa', whatsapp_template_id: wa,
        whatsapp_variables: JSON.stringify([{ index: 1, expr: '{{document.party.name}}' }, { index: 2, expr: '{{document.totalAmount}}' }]),
      }).returning('id').executeTakeFirstOrThrow();
      const pw = await mustOk(a().post(`/docs/${dt.key}/${doc.id}/send/preview`, { channel: 'whatsapp', templateId: money.id, recipients: ['party'] }), 200);
      expect(pw.body).toBe(`Hello Vendor One, order ${formatMoney('1000', 'INR')} is ready.`);
      expect(pw.body).not.toMatch(/\.0000/);
    });

    it('email images pointing at our files are sent inline (CID), not as expiring signed links', async () => {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const { FilesService } = await import('../src/modules/files');
      const logo = await c.app.get(FilesService).upload(t.tenantId, null, { originalname: 'logo.png', buffer: png, size: png.length });
      const tplImg = await c.db.insertInto('app.message_template').values({
        tenant_id: t.tenantId, channel: 'email', doc_type_key: dt.key, key: `ei_${uid(5)}`, name: 'img', subject: 'Logo',
        body: `<p><img alt="logo" src="/api/v1/files/${logo.id}/content?t=x&exp=1&sig=y"><img src="https://cdn.example.com/x.png"></p>`,
      }).returning('id').executeTakeFirstOrThrow();
      const [m] = await mustOk(a().post(`/docs/${dt.key}/${doc.id}/send`, { channel: 'email', templateId: tplImg.id, recipients: ['img@x.test'], idempotencyKey: `k-${uid(10)}` }), 201);
      await sendQueued(c, t.tenantId);
      const rec = JSON.parse(readFileSync(join(logDir(), t.tenantId, `${m.id}.json`), 'utf8'));
      expect(rec.html).toContain(`src="cid:${logo.id}@procure"`);
      expect(rec.html).toContain('src="https://cdn.example.com/x.png"');
      expect(rec.attachments).toContainEqual(expect.objectContaining({ filename: 'logo.png', contentType: 'image/png', cid: `${logo.id}@procure` }));
    });

    it('suggested sends: manual rules of the doc type with resolved recipients', async () => {
      const r = await rule(c, t, { name: 'Email vendor', eventType: 'document.status_changed', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }], attachPdfTemplateId: tpl.pdf, mode: 'manual' });
      const s = await mustOk(a().get(`/docs/${dt.key}/${doc.id}/send/suggestions`));
      expect(s).toContainEqual({ ruleId: r.id, name: 'Email vendor', channel: 'email', templateId: tpl.email, attachPdfTemplateId: tpl.pdf, recipients: [{ address: 'sales@vendor.test', name: 'Vendor One' }] });
      // a manual rule never sends by itself
      await engine(c).handle(event(t, 'document.status_changed', doc.id, { to: 'approved' }));
      expect((await messagesOf(c, t.tenantId, doc.id)).filter(m => m.trigger_rule_id === r.id)).toHaveLength(0);
    });

    it('permissions: doc send keys, message log keys, rule keys', async () => {
      const status = (await c.db.selectFrom('app.document').select('status_key').where('id', '=', doc.id).executeTakeFirstOrThrow()).status_key;
      const see = [`doc.${dt.key}:action.view`, `doc.${dt.key}:view.${status}`];
      const viewOnly = await wfUser(c, t, see, { scopeNode: null });
      const sendBody = { channel: 'email', templateId: tpl.email, recipients: ['a@b.test'], idempotencyKey: `k-${uid(10)}` };
      expect((await api(c, viewOnly.token).post(`/docs/${dt.key}/${doc.id}/send`, sendBody)).status).toBe(403);
      expect((await api(c, viewOnly.token).post(`/docs/${dt.key}/${doc.id}/send/preview`, sendBody)).status).toBe(403);
      expect(await mustOk(api(c, viewOnly.token).get(`/docs/${dt.key}/${doc.id}/send/suggestions`))).toEqual([]);
      expect((await api(c, viewOnly.token).get(`/docs/${dt.key}/${doc.id}/messages`)).status).toBe(200);
      expect((await api(c, viewOnly.token).get('/messages')).status).toBe(403);
      expect((await api(c, viewOnly.token).get('/config/triggers')).status).toBe(403);
      const sender = await wfUser(c, t, [...see, `doc.${dt.key}:action.send_email`], { scopeNode: null });
      expect((await api(c, sender.token).post(`/docs/${dt.key}/${doc.id}/send`, sendBody)).status).toBe(201);
      expect((await api(c, sender.token).post(`/docs/${dt.key}/${doc.id}/send`, { ...sendBody, channel: 'whatsapp', templateId: tpl.whatsapp, recipients: ['+919000000000'], idempotencyKey: `k-${uid(10)}` })).status).toBe(403);
      // out of data scope → the document does not exist for them
      const outOfScope = await wfUser(c, t, [...see, `doc.${dt.key}:action.send_email`], { scopeNode: t.plantB.id });
      expect((await api(c, outOfScope.token).get(`/docs/${dt.key}/${doc.id}/messages`)).status).toBe(404);
      const logViewer = await wfUser(c, t, ['messages:action.view']);
      expect((await api(c, logViewer.token).get('/messages')).status).toBe(200);
      const [failed] = await messagesOf(c, t.tenantId, doc.id);
      expect((await api(c, logViewer.token).post(`/messages/${failed!.id}/retry`)).status).toBe(403);
      const ruleViewer = await wfUser(c, t, ['config.triggers:action.view']);
      expect((await api(c, ruleViewer.token).get('/config/triggers')).status).toBe(200);
      expect((await api(c, ruleViewer.token).post('/config/triggers', {})).status).toBe(403);
    });
  });

  it('cross-tenant isolation: rules, messages, documents and webhooks of another tenant are invisible', async () => {
    const b = await notifyTenant(c, { saToken: t.saToken });
    const ra = await rule(c, t, { eventType: 'comment.created', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }] });
    const [msg] = await messagesOf(c, t.tenantId);
    const bApi = api(c, b.token);
    expect((await bApi.get(`/config/triggers/${ra.id}`)).status).toBe(404);
    // B only sees its own rules (the default "PO approved → email vendor" installed at creation)
    expect((await mustOk<{ id: string; name: string }[]>(bApi.get('/config/triggers'))).every(x => x.id !== ra.id && x.name === DEFAULT_RULE_NAME)).toBe(true);
    expect((await mustOk(bApi.get('/messages'))).data).toHaveLength(0);
    expect((await bApi.post(`/messages/${msg!.id}/retry`)).status).toBe(404);
    expect((await bApi.put(`/config/triggers/${ra.id}`, { name: 'x', eventType: 'comment.created', channel: 'email', templateId: tpl.email, recipients: [{ type: 'fixed', address: 'a@b.test' }], version: 1 })).status).toBe(404);
    // B cannot point a rule at A's template
    const r = await bApi.post('/config/triggers', { name: 'x', eventType: 'comment.created', channel: 'email', templateId: tpl.email, recipients: [{ type: 'fixed', address: 'a@b.test' }] });
    expect(r.status).toBe(400);
    expect(await mustOk(bApi.get('/config/whatsapp-templates'))).toEqual([]);
    // an event of tenant B never evaluates tenant A's rules
    expect((await engine(c).handle({ ...event(b, 'comment.created', null) })).messages).toBe(0);
  });

  it('default rule installer step: idempotent, manual, only with the starter template', async () => {
    const n = await notifyTenant(c, { saToken: t.saToken });
    const db = c.app.get(DbService);
    expect(await db.tenantTx(n.tenantId, tx => installDefaultRules(tx, n.tenantId))).toEqual({ created: false });
    // the Templates installer (when wired) creates po_approved_vendor; simulate a tenant that lacks it
    const has = await c.db.selectFrom('app.message_template').select('id').where('tenant_id', '=', n.tenantId).where('key', '=', 'po_approved_vendor').executeTakeFirst();
    if (!has) await c.db.insertInto('app.message_template').values({ tenant_id: n.tenantId, channel: 'email', doc_type_key: 'po', key: 'po_approved_vendor', name: 'x', subject: 's', body: 'b' }).execute();
    const first = await db.tenantTx(n.tenantId, tx => installDefaultRules(tx, n.tenantId));
    const second = await db.tenantTx(n.tenantId, tx => installDefaultRules(tx, n.tenantId));
    const rules = await c.db.selectFrom('app.trigger_rule').selectAll().where('tenant_id', '=', n.tenantId).where('name', '=', DEFAULT_RULE_NAME).execute();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ event_type: 'document.status_changed', doc_type_key: 'po', condition: "status_to = 'approved'", mode: 'manual', channel: 'email' });
    expect([first.created, second.created].filter(Boolean).length).toBeLessThanOrEqual(1);
    // registered with the Templates installer when that module is present
    try {
      const { TemplatesInstaller } = await import('../src/modules/templates');
      const steps = c.app.get(TemplatesInstaller, { strict: false }).ordered();
      expect(steps.find(s => s.key === 'notify.default_rules')?.order).toBe(500);
    } catch (e) {
      if (!/Cannot find module/.test(String(e))) throw e;
    }
  });

  it('end to end with workers + real renderer: approve → relay → events-notify → send-email → log email with the PDF', async () => {
    c.app.get(RendererRef).use(null);
    const e2e = await notifyDocType(c, t);
    // real templates rendered by the Templates module (Handlebars) and the doc type's default PDF layout (Chromium)
    const et = await templates(c, t, e2e.key);
    await c.db.updateTable('app.message_template').set({ is_default: true }).where('id', '=', et.pdf).execute();
    const r = await rule(c, t, {
      name: 'PO approved → email vendor', eventType: 'document.status_changed', docTypeKey: e2e.key, condition: "status_to = 'approved'", channel: 'email',
      templateId: et.email, recipients: [{ type: 'party' }], attachPdfTemplateId: et.pdf,
    });
    const role = await createRole(c, t.token, 'E2E approver');
    await publishWorkflow(c, t.token, e2e.key, { stages: [{ key: 'hod', name: 'HOD', actors: [{ type: 'role', roleId: role.id }] }] });
    const approver = await wfUser(c, t, [`doc.${e2e.key}:action.view`, `doc.${e2e.key}:action.stage_hod`, 'approvals:action.view'], { scopeNode: null });
    await c.db.insertInto('app.user_role').values({ tenant_id: t.tenantId, user_id: approver.id, role_id: role.id }).execute();
    const { EntitlementsService } = await import('../src/core/entitlements.service');
    await c.app.get(EntitlementsService).bumpPermissions(t.tenantId);
    const d = await makeNotifyDoc(c, t, e2e, { party: ven.id });
    await submitDoc(c, t, d, t.adminId);
    const dec = await c.http.post(`/api/v1/docs/${e2e.key}/${d.id}/actions`).set({ Authorization: `Bearer ${approver.token}` }).send({ action: 'decide', stageKey: 'hod', outcome: 'approve' });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);

    await startWorkers(c);
    const q = c.app.get(QueueService);
    const until = Date.now() + 90_000;
    let m: Awaited<ReturnType<typeof messagesOf>>[number] | undefined;
    while (Date.now() < until) {
      await q.enqueue('outbox', 'outbox-relay', {});
      m = (await messagesOf(c, t.tenantId, d.id)).find(x => x.trigger_rule_id === r.id);
      if (m && ['sent', 'failed'].includes(m.status)) break;
      await new Promise(res => setTimeout(res, 500));
    }
    expect(m, 'message created').toBeTruthy();
    expect(m!.status, m!.error ?? '').toBe('sent');
    const file = join(logDir(), t.tenantId, `${m!.id}.json`);
    expect(existsSync(file)).toBe(true);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    expect(rec.to).toMatchObject({ address: 'sales@vendor.test' });
    expect(rec.attachments).toHaveLength(1);
    expect(rec.attachments[0]).toMatchObject({ contentType: 'application/pdf' });
    const bytes = readFileSync(join(logDir(), t.tenantId, rec.attachments[0].file));
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(rec.attachments[0].size).toBeGreaterThan(500);
  }, 120_000);
});

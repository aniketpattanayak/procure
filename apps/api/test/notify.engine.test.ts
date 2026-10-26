/**
 * Trigger engine (contract "Trigger engine rules"): rule matching (event, doc type, condition, mode), every
 * recipient type, idempotency, plan limits + 80/100% notifications, blocked_config, in-app, workflow effects.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/core/db.service';
import { EFFECT_REGISTRY, EffectRegistry } from '../src/core/ports';
import { EFFECT_EVENT, SEND_JOB_OPTS } from '../src/modules/notify';
import { QueueService } from '../src/core/queue.service';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import {
  cleanQueues, engine, event, makeNotifyDoc, messagesOf, notifyDocType, notifyTenant, NotifyTenant, outboxEvents, provider, rule, sendQueued, stubPdf, templates,
  Templates, vendor, waTemplate,
} from './notify-helpers';
import { act, DocType, publishWorkflow, submitDoc, wfUser } from './workflow-helpers';
import { createRole } from './permissions-helpers';
import { EntitlementsService } from '../src/core/entitlements.service';

describe('notify: trigger engine', () => {
  let c: Ctx;
  let t: NotifyTenant;
  let dt: DocType;
  let tpl: Templates;
  let ven: { id: string; name: string };
  let pdf: ReturnType<typeof stubPdf>;

  beforeAll(async () => {
    c = await bootApp();
    t = await notifyTenant(c);
    dt = await notifyDocType(c, t);
    const wa = await waTemplate(c, t, { headerKind: 'document' });
    tpl = await templates(c, t, dt.key, wa);
    ven = await vendor(c, t, { email: 'Sales@Vendor.test', phone: '98765 43210' }, 'Vendor One');
    await provider(c, t, 'email');
    await provider(c, t, 'whatsapp');
    pdf = stubPdf(c);
  });
  afterAll(async () => {
    pdf.restore();
    await cleanQueues(c);
    await closeApp(c);
  });

  it('PO approved → email vendor with PDF: matches event + doc type + condition, renders, attaches, sends once', async () => {
    const r = await rule(c, t, {
      eventType: 'document.status_changed', docTypeKey: dt.key, condition: "status_to = 'approved' and total_amount > 100", channel: 'email',
      templateId: tpl.email, recipients: [{ type: 'party' }], attachPdfTemplateId: tpl.pdf,
    });
    const d = await makeNotifyDoc(c, t, dt, { party: ven.id });
    await submitDoc(c, t, d, t.adminId); // no workflow → approved immediately
    const evts = await outboxEvents(c, d.id);
    const changed = evts.filter(e => e.type === 'document.status_changed');
    expect(changed.map(e => e.payload.to)).toContain('approved');
    for (const e of evts) await engine(c).handle(e);
    let rows = await messagesOf(c, t.tenantId, d.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'email', recipient: 'sales@vendor.test', recipient_name: 'Vendor One', status: 'queued', trigger_rule_id: r.id, manual: false });
    expect(rows[0]!.subject).toMatch(/^Order T\//);
    expect(rows[0]!.body_preview).toContain('Dear Vendor One');
    // the job carries the PDF template; contract retry policy
    const job = await c.app.get(QueueService).queue('send-email').getJob(`msg:${rows[0]!.id}`);
    expect(job?.data).toMatchObject({ messageId: rows[0]!.id, attachPdfTemplateId: tpl.pdf });
    expect(job?.opts).toMatchObject({ attempts: SEND_JOB_OPTS.attempts, backoff: { type: 'exponential' } });

    // same events delivered again → no new rows; sending twice → one send
    for (const e of evts) await engine(c).handle(e);
    expect(await messagesOf(c, t.tenantId, d.id)).toHaveLength(1);
    await sendQueued(c, t.tenantId);
    await sendQueued(c, t.tenantId);
    rows = await messagesOf(c, t.tenantId, d.id);
    expect(rows[0]).toMatchObject({ status: 'sent', provider: 'log', provider_message_id: `log-${rows[0]!.id}`, attempts: 1 });
    expect(rows[0]!.attachment_file_ids).toHaveLength(1);
    expect(pdf.calls.some(x => x.documentId === d.id && x.templateId === tpl.pdf && (x.waitMs ?? 0) > 0)).toBe(true);
    await mustOk(api(c, t.token).put(`/config/triggers/${r.id}`, { ...(await mustOk(api(c, t.token).get(`/config/triggers/${r.id}`))), isActive: false }));
  });

  it('condition false / condition error / other doc type / manual / inactive rules send nothing', async () => {
    const other = await notifyDocType(c, t);
    await rule(c, t, { eventType: 'document.submitted', docTypeKey: dt.key, condition: 'total_amount > 999999', channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }] });
    const otpl = await templates(c, t, other.key);
    await rule(c, t, { eventType: 'document.submitted', docTypeKey: other.key, channel: 'email', templateId: otpl.email, recipients: [{ type: 'fixed', address: 'x@y.test' }] });
    await rule(c, t, { eventType: 'document.submitted', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }], mode: 'manual' });
    await rule(c, t, { eventType: 'document.submitted', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }], isActive: false });
    // a condition that compiles but errors at runtime (division by zero) → skipped
    await rule(c, t, { eventType: 'document.submitted', docTypeKey: dt.key, condition: 'total_amount / 0 > 1', channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }] });
    const d = await makeNotifyDoc(c, t, dt, { party: ven.id });
    await submitDoc(c, t, d, t.adminId);
    await engine(c).handle(event(t, 'document.submitted', d.id));
    expect(await messagesOf(c, t.tenantId, d.id)).toHaveLength(0);
    // positive control: the same event with a matching auto rule does send
    const ok = await rule(c, t, { eventType: 'document.submitted', docTypeKey: dt.key, condition: "priority = 'Urgent'", channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }] });
    const urgent = await makeNotifyDoc(c, t, dt, { party: ven.id, values: { priority: 'Urgent' } });
    await submitDoc(c, t, urgent, t.adminId);
    await engine(c).handle(event(t, 'document.submitted', urgent.id));
    expect((await messagesOf(c, t.tenantId, urgent.id)).map(m => m.trigger_rule_id)).toEqual([ok.id]);
    await c.db.updateTable('app.trigger_rule').set({ is_active: false }).where('tenant_id', '=', t.tenantId).where('event_type', '=', 'document.submitted').execute();
  });

  it('recipients: party, submitter, users, role (within scope / any), stage actors (named + current), header fields, fixed', async () => {
    const wdt = await notifyDocType(c, t);
    const tp = await templates(c, t, wdt.key);
    // HOD role (stage key) is scoped to Plant B; the in-scope user also has a Plant A role, the other does not.
    const hod = await createRole(c, t.token, `HOD ${wdt.key}`);
    await publishWorkflow(c, t.token, wdt.key, { stages: [{ key: 'hod', name: 'HOD', actors: [{ type: 'role', roleId: hod.id }] }] });
    await mustOk(api(c, t.token).put(`/roles/${hod.id}/permissions/tabs/doc.${wdt.key}`, { actions: [`doc.${wdt.key}:action.view`, `doc.${wdt.key}:action.stage_hod`], views: [] }));
    await mustOk(api(c, t.token).put(`/roles/${hod.id}/scope`, { entries: [{ nodeId: t.plantB.id }] }));
    const inScope = await wfUser(c, t, [`doc.${wdt.key}:action.view`], { scopeNode: t.plantA.id });
    const outScope = await wfUser(c, t, [`doc.${wdt.key}:action.view`], { scopeNode: t.plantB.id });
    for (const u of [inScope, outScope]) await c.db.insertInto('app.user_role').values({ tenant_id: t.tenantId, user_id: u.id, role_id: hod.id }).execute();
    await c.app.get(EntitlementsService).bumpPermissions(t.tenantId);
    await c.db.updateTable('app.tenant_user').set({ phone: '+919000000001' }).where('id', '=', inScope.id).execute();
    const submitter = await wfUser(c, t, [`doc.${wdt.key}:action.view`, `doc.${wdt.key}:action.submit`]);
    const fieldUser = await wfUser(c, t, [`doc.${wdt.key}:action.view`]);

    const ruleFor = (recipients: unknown[], channel = 'email', eventType = 'workflow.stage_entered') =>
      rule(c, t, { eventType, docTypeKey: wdt.key, channel, templateId: channel === 'email' ? tp.email : tp.inapp, recipients });
    await ruleFor([{ type: 'party' }, { type: 'submitter' }, { type: 'users', userIds: [fieldUser.id] }, { type: 'fixed', address: 'Ops@Acme.test' }]);
    await ruleFor([{ type: 'role', roleId: hod.id, withinScope: true }], 'inapp');
    await ruleFor([{ type: 'role', roleId: hod.id, withinScope: false }]);
    await ruleFor([{ type: 'stage_actors', stage: 'hod' }, { type: 'stage_actors', stage: '_current' }], 'inapp');
    await ruleFor([{ type: 'field', field: 'approver' }, { type: 'field', field: 'contact_email' }]);

    const d = await makeNotifyDoc(c, t, wdt, { party: ven.id, createdBy: submitter.id, values: { approver: fieldUser.id, contact_email: 'Buyer@Partner.test' } });
    await submitDoc(c, t, d, submitter.id);
    for (const e of await outboxEvents(c, d.id, ['workflow.stage_entered'])) await engine(c).handle(e);
    const rows = await messagesOf(c, t.tenantId, d.id);
    const users = await c.db.selectFrom('app.tenant_user').select(['id', 'email']).where('id', 'in', [submitter.id, fieldUser.id, inScope.id, outScope.id]).execute();
    const mail = (id: string) => users.find(u => u.id === id)!.email.toLowerCase();
    const emails = rows.filter(r => r.channel === 'email').map(r => r.recipient).sort();
    expect(emails).toEqual([
      'buyer@partner.test', 'ops@acme.test', 'sales@vendor.test', mail(submitter.id), mail(fieldUser.id), mail(fieldUser.id), mail(inScope.id), mail(outScope.id),
    ].sort());
    const inapp = rows.filter(r => r.channel === 'inapp');
    // role within scope → only the Plant A user; stage actors (hod + current) → the same eligible user, deduped per rule
    expect(inapp.map(r => r.recipient).sort()).toEqual([inScope.id, inScope.id]);
    expect(inapp.every(r => r.status === 'sent')).toBe(true);
    const notes = await c.db.selectFrom('app.notification').select(['user_id', 'kind', 'title', 'link']).where('user_id', '=', inScope.id).where('kind', '=', 'message').execute();
    expect(notes.length).toBe(2);
    expect(notes[0]!.title).toMatch(/^Pending: /);
    expect(notes[0]!.link).toBe(`/docs/${wdt.key}/${d.id}`);

    // the stage approver decides → workflow.decided carries the stage: `_current` resolves for it too
    const decided = await rule(c, t, { eventType: 'workflow.decided', docTypeKey: wdt.key, channel: 'inapp', templateId: tp.inapp, recipients: [{ type: 'stage_actors', stage: '_current' }] });
    const r2 = await act(c, inScope.token, wdt.key, d.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    for (const e of await outboxEvents(c, d.id, ['workflow.decided'])) await engine(c).handle(e);
    expect((await messagesOf(c, t.tenantId, d.id)).filter(m => m.trigger_rule_id === decided.id).map(m => m.recipient)).toEqual([inScope.id]);
  });

  it('WhatsApp: phones normalised to E.164, template variables rendered, document header gets the PDF', async () => {
    const r = await rule(c, t, { eventType: 'document.submitted', docTypeKey: dt.key, channel: 'whatsapp', templateId: tpl.whatsapp, recipients: [{ type: 'party' }, { type: 'field', field: 'contact_phone' }] });
    const d = await makeNotifyDoc(c, t, dt, { party: ven.id, values: { contact_phone: '+44 20 7946 0958' } });
    await submitDoc(c, t, d, t.adminId);
    await engine(c).handle(event(t, 'document.submitted', d.id));
    const rows = (await messagesOf(c, t.tenantId, d.id)).filter(m => m.trigger_rule_id === r.id);
    expect(rows.map(m => m.recipient).sort()).toEqual(['+442079460958', '+919876543210']);
    expect(rows.find(m => m.recipient === '+919876543210')!.body_preview).toMatch(/^Hello Vendor One, order T\/\w+ is ready\.$/);
    await sendQueued(c, t.tenantId);
    const after = (await messagesOf(c, t.tenantId, d.id)).filter(m => m.trigger_rule_id === r.id);
    expect(after.every(m => m.status === 'sent' && m.attachment_file_ids.length === 1)).toBe(true);
    await c.db.updateTable('app.trigger_rule').set({ is_active: false }).where('id', '=', r.id).execute();
  });

  it('limits: WhatsApp 2/month → third is blocked_limit (never sent) + 100% admin notification; email 80% warning', async () => {
    const lt = await notifyTenant(c, { saToken: t.saToken, limits: { whatsapp_per_month: 2, email_per_month: 5 } });
    const ldt = await notifyDocType(c, lt);
    const wa = await waTemplate(c, lt);
    const ltpl = await templates(c, lt, ldt.key, wa);
    await provider(c, lt, 'email');
    await provider(c, lt, 'whatsapp');
    await rule(c, lt, { eventType: 'document.submitted', docTypeKey: ldt.key, channel: 'whatsapp', templateId: ltpl.whatsapp, recipients: [{ type: 'fixed', address: '+919000000001' }, { type: 'fixed', address: '+919000000002' }, { type: 'fixed', address: '+919000000003' }] });
    await rule(c, lt, { eventType: 'document.submitted', docTypeKey: ldt.key, channel: 'email', templateId: ltpl.email, recipients: ['a', 'b', 'c', 'd'].map(x => ({ type: 'fixed', address: `${x}@x.test` })) });
    const d = await makeNotifyDoc(c, lt, ldt);
    await submitDoc(c, lt, d, lt.adminId);
    await engine(c).handle(event(lt, 'document.submitted', d.id));
    const rows = await messagesOf(c, lt.tenantId, d.id);
    const wa3 = rows.filter(r => r.channel === 'whatsapp');
    expect(wa3.map(r => r.status).sort()).toEqual(['blocked_limit', 'queued', 'queued']);
    expect(wa3.find(r => r.status === 'blocked_limit')!.error).toMatch(/limit of 2/);
    expect(rows.filter(r => r.channel === 'email').every(r => r.status === 'queued')).toBe(true);
    const notes = await c.db.selectFrom('app.notification').select(['title', 'data']).where('tenant_id', '=', lt.tenantId).where('kind', '=', 'limit_warning').execute();
    const by = (k: string) => notes.filter(n => (n.data as { limitKey: string }).limitKey === k).map(n => (n.data as { threshold: number }).threshold);
    expect(by('whatsapp_per_month')).toEqual([100]);
    expect(by('email_per_month')).toEqual([80]);
    const ev = await c.db.selectFrom('app.outbox_event').select(['payload']).where('tenant_id', '=', lt.tenantId).where('event_type', '=', 'limit.warning').execute();
    expect(ev.length).toBe(2);
    // a blocked message is never sent
    await sendQueued(c, lt.tenantId);
    expect((await messagesOf(c, lt.tenantId, d.id)).find(r => r.status === 'blocked_limit')!.sent_at).toBeNull();
  });

  it('blocked_config: feature off, no provider, WhatsApp template no longer allowed', async () => {
    const off = await notifyTenant(c, { saToken: t.saToken, features: ['indent', 'purchase', 'form_builder', 'workflow_designer'] });
    const odt = await notifyDocType(c, off);
    const otpl = await templates(c, off, odt.key);
    // the rule API refuses channels outside the plan, so insert as the DB owner (plan downgraded after the rule existed)
    await c.db.insertInto('app.trigger_rule').values({ tenant_id: off.tenantId, name: 'old', event_type: 'document.submitted', doc_type_key: odt.key, channel: 'email', template_id: otpl.email, recipients: JSON.stringify([{ type: 'fixed', address: 'a@x.test' }]) }).execute();
    const d1 = await makeNotifyDoc(c, off, odt);
    await submitDoc(c, off, d1, off.adminId);
    await engine(c).handle(event(off, 'document.submitted', d1.id));
    expect(await messagesOf(c, off.tenantId, d1.id)).toMatchObject([{ status: 'blocked_config', error: 'Email is not included in your plan' }]);

    const np = await notifyTenant(c, { saToken: t.saToken });
    const ndt = await notifyDocType(c, np);
    const ntpl = await templates(c, np, ndt.key);
    await rule(c, np, { eventType: 'document.submitted', docTypeKey: ndt.key, channel: 'email', templateId: ntpl.email, recipients: [{ type: 'fixed', address: 'a@x.test' }] });
    const d2 = await makeNotifyDoc(c, np, ndt);
    await submitDoc(c, np, d2, np.adminId);
    await engine(c).handle(event(np, 'document.submitted', d2.id));
    expect(await messagesOf(c, np.tenantId, d2.id)).toMatchObject([{ status: 'blocked_config', error: 'No email provider is configured' }]);

    // WhatsApp template revoked between rule creation and the event
    const wa = await waTemplate(c, np);
    const wtpl = await templates(c, np, ndt.key, wa);
    await provider(c, np, 'whatsapp');
    await rule(c, np, { eventType: 'document.cancelled', docTypeKey: ndt.key, channel: 'whatsapp', templateId: wtpl.whatsapp, recipients: [{ type: 'fixed', address: '+919000000009' }] });
    await mustOk(c.http.put(`/api/v1/platform/tenants/${np.tenantId}/whatsapp-templates`).set({ Authorization: `Bearer ${np.saToken}` }).send({ templateIds: [] }));
    await engine(c).handle(event(np, 'document.cancelled', d2.id));
    const blocked = (await messagesOf(c, np.tenantId, d2.id)).filter(m => m.channel === 'whatsapp');
    expect(blocked).toMatchObject([{ status: 'blocked_config', error: 'The WhatsApp template is not approved for your company' }]);
  });

  it('send_email / send_whatsapp workflow effects: outbox after commit, party + submitter, idempotent per wfActionId', async () => {
    const registry = c.app.get<EffectRegistry>(EFFECT_REGISTRY);
    expect(registry.available(['email', 'whatsapp'])).toEqual(expect.arrayContaining(['send_email', 'send_whatsapp']));
    expect(registry.available([])).not.toContain('send_email');
    const key = (await c.db.selectFrom('app.message_template').select('key').where('id', '=', tpl.email).executeTakeFirstOrThrow()).key;
    await c.db.updateTable('app.message_template').set({ is_default: true }).where('id', '=', tpl.pdf).execute();
    const d = await makeNotifyDoc(c, t, dt, { party: ven.id });
    await submitDoc(c, t, d, t.adminId);
    const wfActionId = '018f0000-0000-7000-8000-000000000001';
    const run = () => c.app.get(DbService).tenantTx(t.tenantId, tx => registry.run({ effect: 'send_email', template: key }, { tx, tenantId: t.tenantId, documentId: d.id, stageKey: 'hod', wfActionId, actorId: t.adminId }));
    // rolled back action → nothing written, nothing sent
    await expect(c.app.get(DbService).tenantTx(t.tenantId, async tx => {
      await registry.run({ effect: 'send_email', template: key }, { tx, tenantId: t.tenantId, documentId: d.id, stageKey: 'hod', wfActionId, actorId: t.adminId });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await outboxEvents(c, d.id, [EFFECT_EVENT])).toHaveLength(0);
    await run();
    await run(); // the same action applied twice (retry)
    const evts = await outboxEvents(c, d.id, [EFFECT_EVENT]);
    expect(evts).toHaveLength(2);
    for (const e of evts) await engine(c).handle(e);
    const rows = (await messagesOf(c, t.tenantId, d.id)).filter(r => r.channel === 'email' && !r.trigger_rule_id);
    const admin = await c.db.selectFrom('app.tenant_user').select('email').where('id', '=', t.adminId).executeTakeFirstOrThrow();
    expect(rows.map(r => r.recipient).sort()).toEqual([admin.email.toLowerCase(), 'sales@vendor.test'].sort());
    const job = await c.app.get(QueueService).queue('send-email').getJob(`msg:${rows[0]!.id}`);
    expect(job?.data.attachPdfTemplateId).toBe(tpl.pdf);
    // unknown template key → nothing
    await c.app.get(DbService).tenantTx(t.tenantId, tx => registry.run({ effect: 'send_whatsapp', template: 'nope' }, { tx, tenantId: t.tenantId, documentId: d.id, stageKey: null, wfActionId: null, actorId: null }));
    for (const e of await outboxEvents(c, d.id, [EFFECT_EVENT])) await engine(c).handle(e);
    expect((await messagesOf(c, t.tenantId, d.id)).filter(r => r.channel === 'whatsapp' && !r.trigger_rule_id)).toHaveLength(0);
  });

  it('sweeper re-enqueues messages left queued without a job', async () => {
    const d = await makeNotifyDoc(c, t, dt, { party: ven.id });
    const r = await rule(c, t, { eventType: 'document.closed', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }] });
    await engine(c).handle(event(t, 'document.closed', d.id));
    const [m] = (await messagesOf(c, t.tenantId, d.id)).filter(x => x.trigger_rule_id === r.id);
    const q = c.app.get(QueueService).queue('send-email');
    await (await q.getJob(`msg:${m!.id}`))!.remove();
    await c.db.updateTable('app.outbound_message').set({ created_at: new Date(Date.now() - 5 * 60_000) }).where('id', '=', m!.id).execute();
    const s = await engine(c).sweep();
    expect(s.messages).toBeGreaterThanOrEqual(1);
    expect(await q.getJob(`msg:${m!.id}`)).toBeTruthy();
  });
});

/**
 * Sending + providers: retry/backoff on 5xx and fail-fast on 4xx (mocked transports), provider selection (tenant
 * override vs platform default), Meta + SNS inbound webhooks (signature verification, status updates), Super Admin
 * provider / WhatsApp template endpoints with write-only secrets.
 */
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HooksService, ProviderError, ProviderStore, SEND_JOB_OPTS, snsStringToSign } from '../src/modules/notify';
import type { EmailAdapter, WhatsAppAdapter } from '../src/modules/notify/channels/types';
import { MetaWhatsAppAdapter } from '../src/modules/notify';
import { mustOk } from './forms-helpers';
import { API, bearer, bootApp, closeApp, Ctx, superAdmin } from './helpers';
import {
  cleanQueues, engine, event, makeNotifyDoc, messagesOf, notifyDocType, notifyTenant, NotifyTenant, provider, rule, sender, stubPdf, templates, Templates, vendor, waTemplate,
} from './notify-helpers';
import type { DocType } from './workflow-helpers';

describe('notify: channels, providers, inbound webhooks', () => {
  let c: Ctx;
  let t: NotifyTenant;
  let dt: DocType;
  let tpl: Templates;
  let ven: { id: string };
  let pdf: ReturnType<typeof stubPdf>;
  const originals: { email?: EmailAdapter; ses?: EmailAdapter; meta?: WhatsAppAdapter } = {};

  beforeAll(async () => {
    c = await bootApp();
    t = await notifyTenant(c);
    dt = await notifyDocType(c, t);
    const wa = await waTemplate(c, t, { headerKind: 'document' });
    tpl = await templates(c, t, dt.key, wa);
    ven = await vendor(c, t, { email: 'v@vendor.test', phone: '+919876543210' });
    pdf = stubPdf(c);
    originals.email = sender(c).email.log;
    originals.ses = sender(c).email.ses;
    originals.meta = sender(c).whatsapp.meta;
  });
  afterAll(async () => {
    sender(c).email.log = originals.email!;
    sender(c).email.ses = originals.ses!;
    sender(c).whatsapp.meta = originals.meta!;
    pdf.restore();
    await cleanQueues(c);
    await closeApp(c);
  });

  const queuedEmail = async (type = 'document.closed') => {
    const d = await makeNotifyDoc(c, t, dt, { party: ven.id });
    await engine(c).handle(event(t, type, d.id));
    const [m] = await messagesOf(c, t.tenantId, d.id);
    return m!;
  };
  const job = (id: string, attemptsMade: number) => ({ data: { messageId: id, tenantId: t.tenantId, attachPdfTemplateId: null }, attemptsMade, opts: { attempts: SEND_JOB_OPTS.attempts } });

  it('5xx / timeouts are retried (status back to queued, attempts counted) and the last attempt fails; 4xx fails fast', async () => {
    const p = await provider(c, t, 'email');
    await rule(c, t, { eventType: 'document.closed', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }] });
    let mode: 'retry' | 'fatal' | 'ok' = 'retry';
    let calls = 0;
    sender(c).email.log = { send: async () => {
      calls++;
      if (mode === 'retry') throw new ProviderError('HTTP 503', false, 503);
      if (mode === 'fatal') throw new ProviderError('HTTP 400 bad address', true, 400);
      return { providerMessageId: 'ok-1' };
    } };
    const m = await queuedEmail();
    await expect(sender(c).process('email', job(m.id, 0))).rejects.toThrow('HTTP 503');
    let row = (await messagesOf(c, t.tenantId, m.document_id!))[0]!;
    expect(row).toMatchObject({ status: 'queued', attempts: 1, error: 'HTTP 503' });
    await expect(sender(c).process('email', job(m.id, 1))).rejects.not.toBeInstanceOf(UnrecoverableError);
    await expect(sender(c).process('email', job(m.id, 4))).rejects.toBeInstanceOf(UnrecoverableError); // last of 5
    row = (await messagesOf(c, t.tenantId, m.document_id!))[0]!;
    expect(row).toMatchObject({ status: 'failed', attempts: 3 });
    // a failed message is not touched by a stray job
    expect(await sender(c).process('email', job(m.id, 0))).toEqual({ status: 'skipped' });

    mode = 'fatal';
    const m2 = await queuedEmail();
    await expect(sender(c).process('email', job(m2.id, 0))).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await messagesOf(c, t.tenantId, m2.document_id!))[0]).toMatchObject({ status: 'failed', attempts: 1, error: 'HTTP 400 bad address' });

    // retry endpoint: failed → queued → sent (no extra quota)
    mode = 'ok';
    const r = await mustOk(c.http.post(`${API}/messages/${m2.id}/retry`).set(bearer(t.token)));
    expect(r).toMatchObject({ id: m2.id, status: 'queued', error: null });
    expect(await sender(c).process('email', job(m2.id, 0))).toEqual({ status: 'sent' });
    expect((await messagesOf(c, t.tenantId, m2.document_id!))[0]).toMatchObject({ status: 'sent', provider_message_id: 'ok-1' });
    const again = await c.http.post(`${API}/messages/${m2.id}/retry`).set(bearer(t.token));
    expect(again.status).toBe(409);
    expect(calls).toBeGreaterThanOrEqual(5);
    // provider removed between queueing and sending → blocked_config
    const m3 = await queuedEmail();
    await mustOk(c.http.delete(`${API}/platform/providers/${p.id}`).set(bearer(t.saToken)), 204);
    expect(await sender(c).process('email', job(m3.id, 0))).toEqual({ status: 'blocked_config' });
    await provider(c, t, 'email');
  });

  it('PDF not ready yet → retryable; WhatsApp template revoked before send → blocked_config', async () => {
    sender(c).email.log = originals.email!;
    const r = await rule(c, t, { eventType: 'document.cancelled', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }], attachPdfTemplateId: tpl.pdf });
    pdf.restore();
    const { RendererRef } = await import('../src/modules/notify');
    const ref = c.app.get(RendererRef);
    const real = ref.get();
    ref.use({ documentContext: real.documentContext.bind(real), render: real.render.bind(real), pdfForDocument: async () => ({ id: 'x', fileId: null }) });
    const d = await makeNotifyDoc(c, t, dt, { party: ven.id });
    await engine(c).handle(event(t, 'document.cancelled', d.id));
    const [m] = (await messagesOf(c, t.tenantId, d.id)).filter(x => x.trigger_rule_id === r.id);
    await expect(sender(c).process('email', { data: { messageId: m!.id, tenantId: t.tenantId, attachPdfTemplateId: tpl.pdf }, attemptsMade: 0, opts: { attempts: 5 } })).rejects.toThrow(/not ready/);
    expect((await messagesOf(c, t.tenantId, d.id))[0]).toMatchObject({ status: 'queued' });
    pdf = stubPdf(c);
    expect(await sender(c).process('email', { data: { messageId: m!.id, tenantId: t.tenantId, attachPdfTemplateId: tpl.pdf }, attemptsMade: 1, opts: { attempts: 5 } })).toEqual({ status: 'sent' });

    await provider(c, t, 'whatsapp');
    const w = await rule(c, t, { eventType: 'document.cancelled', docTypeKey: dt.key, channel: 'whatsapp', templateId: tpl.whatsapp, recipients: [{ type: 'party' }] });
    const d2 = await makeNotifyDoc(c, t, dt, { party: ven.id });
    await engine(c).handle(event(t, 'document.cancelled', d2.id));
    const [wm] = (await messagesOf(c, t.tenantId, d2.id)).filter(x => x.trigger_rule_id === w.id);
    expect(wm!.status).toBe('queued');
    const allowed = await mustOk(c.http.get(`${API}/platform/tenants/${t.tenantId}/whatsapp-templates`).set(bearer(t.saToken)));
    await mustOk(c.http.put(`${API}/platform/tenants/${t.tenantId}/whatsapp-templates`).set(bearer(t.saToken)).send({ templateIds: [] }));
    expect(await sender(c).process('whatsapp', { data: { messageId: wm!.id, tenantId: t.tenantId, attachPdfTemplateId: null }, attemptsMade: 0, opts: { attempts: 5 } })).toEqual({ status: 'blocked_config' });
    await mustOk(c.http.put(`${API}/platform/tenants/${t.tenantId}/whatsapp-templates`).set(bearer(t.saToken)).send(allowed));
    await c.db.updateTable('app.trigger_rule').set({ is_active: false }).where('id', 'in', [r.id, w.id]).execute();
  });

  it('provider selection: tenant credential overrides the platform default; secrets are decrypted only for sending', async () => {
    const store = c.app.get(ProviderStore);
    const other = await notifyTenant(c, { saToken: t.saToken });
    expect(await store.resolve(other.tenantId, 'email')).toBeNull();
    const plat = await mustOk(c.http.post(`${API}/platform/providers`).set(bearer(t.saToken)).send({ channel: 'email', provider: 'smtp', config: { host: 'smtp.platform.test' }, secret: 'pw-platform' }), 201);
    try {
      expect(await store.resolve(other.tenantId, 'email')).toMatchObject({ provider: 'smtp', tenantId: null, secret: { value: 'pw-platform' } });
      await provider(c, other, 'email', 'ses', { region: 'eu-west-1' }, JSON.stringify({ accessKeyId: 'AK', secretAccessKey: 'SK' }));
      expect(await store.resolve(other.tenantId, 'email')).toMatchObject({ provider: 'ses', tenantId: other.tenantId, secret: { accessKeyId: 'AK', secretAccessKey: 'SK' } });
    } finally {
      await mustOk(c.http.delete(`${API}/platform/providers/${plat.id}`).set(bearer(t.saToken)), 204);
    }
  });

  it('Super Admin providers: owner only, validation, one active per scope, secrets write-only and encrypted at rest', async () => {
    const sa = (p: string) => c.http.get(`${API}${p}`).set(bearer(t.saToken));
    // the tenant already has an active WhatsApp provider (previous test) → one active per (tenant, channel)
    const dup = await c.http.post(`${API}/platform/providers`).set(bearer(t.saToken)).send({
      tenantId: t.tenantId, channel: 'whatsapp', provider: 'meta', config: { phoneNumberId: '555' }, secret: JSON.stringify({ accessToken: 'EAAtoken', appSecret: 'meta-app-secret' }),
    });
    expect(dup.status).toBe(409);
    const list = await mustOk<{ id: string; provider: string; hasSecret: boolean; tenantId: string }[]>(sa(`/platform/providers?tenantId=${t.tenantId}`));
    expect(JSON.stringify(list)).not.toMatch(/EAAtoken|meta-app-secret|pw-/);
    const raw = await c.db.selectFrom('platform.provider_credential').select('secret').where('secret', 'is not', null).execute();
    expect(raw.every(r => r.secret!.startsWith('v1:') && !r.secret!.includes('EAAtoken'))).toBe(true);
    // validation
    const bad = await c.http.post(`${API}/platform/providers`).set(bearer(t.saToken)).send({ channel: 'email', provider: 'meta' });
    expect(bad.status).toBe(400);
    const inConfig = await c.http.post(`${API}/platform/providers`).set(bearer(t.saToken)).send({ tenantId: t.tenantId, channel: 'email', provider: 'smtp', config: { host: 'h', password: 'x' } });
    expect(inConfig.status).toBe(400);
    expect((await c.http.post(`${API}/platform/providers`).set(bearer(t.saToken)).send({ channel: 'whatsapp', provider: 'bsp', config: { url: 'http://x' } })).status).toBe(400);
    expect((await c.http.post(`${API}/platform/providers`).set(bearer(t.saToken)).send({ tenantId: '00000000-0000-4000-8000-000000000000', channel: 'email', provider: 'log' })).status).toBe(400);
    // update keeps the secret when omitted, version checked
    const mine = list.find(p => p.provider === 'log')!;
    const full = await mustOk(sa(`/platform/providers/${mine.id}`));
    expect(full).not.toHaveProperty('secret');
    const up = await mustOk(c.http.put(`${API}/platform/providers/${mine.id}`).set(bearer(t.saToken)).send({ ...full, config: { fromAddress: 'po@acme.test' }, secret: 'smtp-pass' }));
    expect(up).toMatchObject({ hasSecret: true, version: full.version + 1 });
    const stale = await c.http.put(`${API}/platform/providers/${mine.id}`).set(bearer(t.saToken)).send({ ...full });
    expect(stale.status).toBe(409);
    const cleared = await mustOk(c.http.put(`${API}/platform/providers/${mine.id}`).set(bearer(t.saToken)).send({ ...up, secret: '' }));
    expect(cleared.hasSecret).toBe(false);
    // non-owner platform roles and tenants are refused
    const support = await superAdmin(c, 'support');
    expect((await c.http.get(`${API}/platform/providers`).set(bearer(support.token))).status).toBe(403);
    expect((await c.http.get(`${API}/platform/providers`).set(bearer(t.token))).status).toBe(403);
    expect((await c.http.get(`${API}/platform/whatsapp-templates`).set(bearer(t.token))).status).toBe(403);
  });

  it('Super Admin WhatsApp catalogue: placeholders validated, tenant allow-list, tenants see only approved + allowed', async () => {
    const auth = bearer(t.saToken);
    expect((await c.http.post(`${API}/platform/whatsapp-templates`).set(auth).send({ name: 'bad_vars', category: 'utility', body: 'Hi {{1}} {{3}}', variables: [{ index: 1, label: 'a' }, { index: 3, label: 'c' }] })).status).toBe(400);
    expect((await c.http.post(`${API}/platform/whatsapp-templates`).set(auth).send({ name: 'missing_var', category: 'utility', body: 'Hi {{1}}' })).status).toBe(400);
    const pending = await mustOk(c.http.post(`${API}/platform/whatsapp-templates`).set(auth).send({ name: `pend_${Date.now()}`, category: 'utility', body: 'x', metaStatus: 'pending' }), 201);
    const dup = await c.http.post(`${API}/platform/whatsapp-templates`).set(auth).send({ name: pending.name, category: 'utility', body: 'x' });
    expect(dup.status).toBe(409);
    const cur = await mustOk<{ templateIds: string[] }>(c.http.get(`${API}/platform/tenants/${t.tenantId}/whatsapp-templates`).set(auth));
    await mustOk(c.http.put(`${API}/platform/tenants/${t.tenantId}/whatsapp-templates`).set(auth).send({ templateIds: [...cur.templateIds, pending.id] }));
    let mine = await mustOk<{ id: string }[]>(c.http.get(`${API}/config/whatsapp-templates`).set(bearer(t.token)));
    expect(mine.map(x => x.id)).not.toContain(pending.id); // not approved by Meta yet
    await mustOk(c.http.put(`${API}/platform/whatsapp-templates/${pending.id}`).set(auth).send({ name: pending.name, category: 'utility', body: 'x', metaStatus: 'approved' }));
    mine = await mustOk(c.http.get(`${API}/config/whatsapp-templates`).set(bearer(t.token)));
    expect(mine.map(x => x.id)).toContain(pending.id);
    await mustOk(c.http.delete(`${API}/platform/whatsapp-templates/${pending.id}`).set(auth), 204);
    mine = await mustOk(c.http.get(`${API}/config/whatsapp-templates`).set(bearer(t.token)));
    expect(mine.map(x => x.id)).not.toContain(pending.id);
    expect((await c.http.put(`${API}/platform/tenants/${t.tenantId}/whatsapp-templates`).set(auth).send({ templateIds: ['00000000-0000-4000-8000-000000000001'] })).status).toBe(400);
    expect((await c.http.get(`${API}/platform/tenants/00000000-0000-4000-8000-000000000001/whatsapp-templates`).set(auth)).status).toBe(404);
    const audit = await c.db.selectFrom('platform.audit_log').select(['action', 'after']).where('entity', '=', 'provider_credential').execute();
    expect(JSON.stringify(audit)).not.toMatch(/EAAtoken|smtp-pass|pw-platform/);
  });

  describe('Meta webhook', () => {
    const appSecret = 'meta-app-secret-2';
    let wamid: string;
    let docId: string;

    beforeAll(async () => {
      const mt = await notifyTenant(c, { saToken: t.saToken });
      const mdt = await notifyDocType(c, mt);
      const wa = await waTemplate(c, mt);
      const mtpl = await templates(c, mt, mdt.key, wa);
      await provider(c, mt, 'whatsapp', 'meta', { phoneNumberId: '42' }, JSON.stringify({ accessToken: 'tok', appSecret, verifyToken: 'verify-me' }));
      await rule(c, mt, { eventType: 'document.closed', docTypeKey: mdt.key, channel: 'whatsapp', templateId: mtpl.whatsapp, recipients: [{ type: 'fixed', address: '+919811111111' }] });
      const d = await makeNotifyDoc(c, mt, mdt);
      docId = d.id;
      await engine(c).handle(event(mt, 'document.closed', d.id));
      const [m] = await messagesOf(c, mt.tenantId, d.id);
      wamid = `wamid.${m!.id}`;
      const seen: string[] = [];
      sender(c).whatsapp.meta = new MetaWhatsAppAdapter((async (url: string, init: RequestInit) => {
        seen.push(url);
        expect(JSON.parse(String(init.body)).template.components[0].parameters.map((p: { text: string }) => p.text)[0]).toBe('');
        return new Response(JSON.stringify({ messages: [{ id: wamid }] }), { status: 200 });
      }) as typeof fetch);
      expect(await sender(c).process('whatsapp', { data: { messageId: m!.id, tenantId: mt.tenantId, attachPdfTemplateId: null }, attemptsMade: 0, opts: { attempts: 5 } })).toEqual({ status: 'sent' });
      expect(seen).toEqual(['https://graph.facebook.com/v21.0/42/messages']);
    });

    const post = (body: unknown, secret = appSecret) => {
      const raw = JSON.stringify(body);
      return c.http.post(`${API}/hooks/whatsapp`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`).send(raw);
    };
    const statuses = (s: object[]) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { statuses: s } }] }] });
    const row = () => c.db.selectFrom('app.outbound_message').selectAll().where('document_id', '=', docId).executeTakeFirstOrThrow();

    it('GET verification echoes the challenge only for a configured verify token', async () => {
      const ok = await c.http.get(`${API}/hooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1158201444' });
      expect(ok.status).toBe(200);
      expect(ok.text).toBe('1158201444');
      expect((await c.http.get(`${API}/hooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'x' })).status).toBe(403);
    });

    it('rejects bad / missing signatures; applies delivered → read; never regresses; failed only before delivery', async () => {
      const ts = Math.floor(Date.now() / 1000);
      expect((await post(statuses([{ id: wamid, status: 'delivered', timestamp: String(ts) }]), 'wrong')).status).toBe(401);
      expect((await c.http.post(`${API}/hooks/whatsapp`).send(statuses([{ id: wamid, status: 'delivered' }]))).status).toBe(401);
      expect((await row()).status).toBe('sent');
      const r1 = await post(statuses([{ id: wamid, status: 'delivered', timestamp: String(ts) }, { id: 'wamid.unknown', status: 'read' }]));
      expect(r1.status).toBe(200);
      expect(r1.body).toEqual({ ok: true, updated: 1 });
      expect(await row()).toMatchObject({ status: 'delivered' });
      expect((await row()).delivered_at).not.toBeNull();
      await post(statuses([{ id: wamid, status: 'read', timestamp: String(ts + 5) }]));
      await post(statuses([{ id: wamid, status: 'delivered', timestamp: String(ts + 6) }]));
      await post(statuses([{ id: wamid, status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] }]));
      const r = await row();
      expect(r.status).toBe('read');
      expect(r.read_at).not.toBeNull();
    });
  });

  describe('SES via SNS', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certUrl = 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-test.pem';
    let sesId: string;
    let docId: string;
    const confirmed: string[] = [];

    beforeAll(async () => {
      const hooks = c.app.get(HooksService);
      hooks.certFetcher = async url => {
        if (url !== certUrl) throw new Error('unexpected cert url');
        return publicKey.export({ type: 'spki', format: 'pem' }).toString();
      };
      hooks.confirmSubscription = async url => { confirmed.push(url); };
      const st = await notifyTenant(c, { saToken: t.saToken });
      const sdt = await notifyDocType(c, st);
      const stpl = await templates(c, st, sdt.key);
      await provider(c, st, 'email', 'ses', { region: 'ap-south-1', snsTopicArn: 'arn:aws:sns:ap-south-1:1:ses-events' });
      await rule(c, st, { eventType: 'document.closed', docTypeKey: sdt.key, channel: 'email', templateId: stpl.email, recipients: [{ type: 'fixed', address: 'a@b.test' }, { type: 'fixed', address: 'c@d.test' }] });
      const d = await makeNotifyDoc(c, st, sdt);
      docId = d.id;
      await engine(c).handle(event(st, 'document.closed', d.id));
      let n = 0;
      sender(c).email.ses = { send: async () => ({ providerMessageId: `ses-${Date.now()}-${++n}` }) };
      for (const m of await messagesOf(c, st.tenantId, d.id)) {
        expect(await sender(c).process('email', { data: { messageId: m.id, tenantId: st.tenantId, attachPdfTemplateId: null }, attemptsMade: 0, opts: { attempts: 5 } })).toEqual({ status: 'sent' });
      }
      sesId = (await messagesOf(c, st.tenantId, d.id))[0]!.provider_message_id!;
    });

    const sns = (m: Record<string, string>) => {
      const msg = { SignatureVersion: '1', SigningCertURL: certUrl, TopicArn: 'arn:aws:sns:ap-south-1:1:ses-events', MessageId: `m-${Math.random()}`, Timestamp: new Date().toISOString(), ...m };
      return { ...msg, Signature: createSign('RSA-SHA1').update(snsStringToSign(msg as never)).sign(privateKey, 'base64') };
    };
    const post = (body: unknown) => c.http.post(`${API}/hooks/email/ses`).set('Content-Type', 'text/plain; charset=UTF-8').send(JSON.stringify(body));
    const rows = () => c.db.selectFrom('app.outbound_message').select(['provider_message_id', 'status', 'error', 'delivered_at']).where('document_id', '=', docId).execute();

    it('confirms subscriptions, verifies signatures and topic, applies Delivery / Bounce', async () => {
      const sub = await post(sns({ Type: 'SubscriptionConfirmation', Token: 'tok', Message: 'confirm', SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok' }));
      expect(sub.status).toBe(200);
      expect(confirmed).toHaveLength(1);
      const delivery = { Type: 'Notification', Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: sesId }, delivery: { timestamp: new Date().toISOString() } }) };
      const tampered = { ...sns(delivery), Message: JSON.stringify({ eventType: 'Bounce', mail: { messageId: sesId } }) };
      expect((await post(tampered)).status).toBe(401);
      expect((await post({ ...sns(delivery), TopicArn: 'arn:aws:sns:ap-south-1:1:other' })).status).toBe(401);
      expect((await post(sns({ ...delivery, TopicArn: 'arn:aws:sns:ap-south-1:1:other' }))).status).toBe(401); // validly signed, foreign topic
      expect((await post('not json')).status).toBe(401);
      const ok = await post(sns(delivery));
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true, updated: 1 });
      const all = await rows();
      expect(all.find(r => r.provider_message_id === sesId)).toMatchObject({ status: 'delivered' });
      const other = all.find(r => r.provider_message_id !== sesId)!;
      const bounce = { Type: 'Notification', Message: JSON.stringify({ notificationType: 'Bounce', mail: { messageId: other.provider_message_id }, bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'c@d.test', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }] } }) };
      expect((await post(sns(bounce))).body).toEqual({ ok: true, updated: 1 });
      expect((await rows()).find(r => r.provider_message_id === other.provider_message_id)).toMatchObject({ status: 'failed', error: 'Bounced: smtp; 550 5.1.1 user unknown' });
      // a late bounce after delivery does not flip it; transient bounces are ignored; JSON content-type also accepted
      const late = { Type: 'Notification', Message: JSON.stringify({ eventType: 'Bounce', mail: { messageId: sesId }, bounce: { bounceType: 'Permanent' } }) };
      expect((await c.http.post(`${API}/hooks/email/ses`).set('Content-Type', 'application/json').send(JSON.stringify(sns(late)))).body).toEqual({ ok: true, updated: 0 });
      const open = { Type: 'Notification', Message: JSON.stringify({ eventType: 'Open', mail: { messageId: sesId }, open: { timestamp: new Date().toISOString() } }) };
      expect((await post(sns(open))).body.updated).toBe(1);
      expect((await rows()).find(r => r.provider_message_id === sesId)).toMatchObject({ status: 'read' });
    });
  });
});

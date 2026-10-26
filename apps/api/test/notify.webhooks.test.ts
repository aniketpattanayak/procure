/**
 * Outgoing webhooks: CRUD + webhook_endpoints limit + feature gate, SSRF guard at create and at send (DNS rebinding),
 * HMAC signature headers, retries with exponential backoff, auto-disable after 50 consecutive failures, test endpoint,
 * delivery log, secret shown once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueService } from '../src/core/queue.service';
import { RedisService } from '../src/core/redis.service';
import { retryDelayMs, TransportRequest, verifyWebhookSignature, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_QUEUE, WebhooksService } from '../src/modules/notify';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { cleanQueues, engine, event, notifyTenant, NotifyTenant } from './notify-helpers';
import { wfUser } from './workflow-helpers';

describe('notify: outgoing webhooks', () => {
  let c: Ctx;
  let t: NotifyTenant;
  let hooks: WebhooksService;
  let dns: Record<string, string>;
  let reply: (r: TransportRequest) => { status: number; body: string };
  const sent: TransportRequest[] = [];
  let original: { transport: WebhooksService['transport']; resolver: WebhooksService['resolver'] };

  beforeAll(async () => {
    c = await bootApp();
    t = await notifyTenant(c, { limits: { webhook_endpoints: 2 } });
    hooks = c.app.get(WebhooksService);
    original = { transport: hooks.transport, resolver: hooks.resolver };
    dns = { 'hooks.customer.test': '93.184.216.34', 'evil.customer.test': '93.184.216.35' };
    hooks.resolver = async host => (dns[host] ? [{ address: dns[host]!, family: 4 }] : Promise.reject(new Error('ENOTFOUND')));
    reply = () => ({ status: 200, body: 'ok' });
    hooks.transport = async r => { sent.push(r); return reply(r); };
  });
  afterAll(async () => {
    hooks.transport = original.transport;
    hooks.resolver = original.resolver;
    await cleanQueues(c);
    await closeApp(c);
  });

  const a = () => api(c, t.token);

  it('create returns the secret once; list/get never do; SSRF guard and the endpoint limit apply', async () => {
    const ep = await mustOk(a().post('/config/webhooks', { url: 'https://hooks.customer.test/procure', events: ['document.submitted', 'workflow.completed'], description: 'ERP' }), 201);
    expect(ep.secret).toMatch(/^whsec_/);
    const list = await mustOk(a().get('/config/webhooks'));
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('secret');
    expect(await mustOk(a().get(`/config/webhooks/${ep.id}`))).not.toHaveProperty('secret');
    const raw = await c.db.selectFrom('app.webhook_endpoint').select('secret').where('id', '=', ep.id).executeTakeFirstOrThrow();
    expect(raw.secret).not.toContain(ep.secret);

    for (const url of ['https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://localhost/x', 'https://nx.customer.test/x', 'http://hooks.customer.test/x']) {
      const r = await a().post('/config/webhooks', { url, events: ['*'] });
      expect(r.status, url).toBe(400);
    }
    dns['internal.customer.test'] = '192.168.10.5';
    expect((await a().post('/config/webhooks', { url: 'https://internal.customer.test/x', events: ['*'] })).status).toBe(400);
    expect((await a().post('/config/webhooks', { url: 'https://hooks.customer.test/x', events: ['notify.effect_send'] })).status).toBe(400);

    await mustOk(a().post('/config/webhooks', { url: 'https://evil.customer.test/in', events: ['*'] }), 201);
    const third = await a().post('/config/webhooks', { url: 'https://hooks.customer.test/3', events: ['*'] });
    expect(third.status).toBe(403);
    expect(third.body.code).toBe('LIMIT_EXCEEDED.webhook_endpoints');
    (globalThis as Record<string, unknown>).__ep = ep;
  });

  it('delivers signed JSON to subscribed endpoints only (once per event), with event/delivery headers', async () => {
    const ep = (globalThis as Record<string, unknown>).__ep as { id: string; secret: string };
    sent.length = 0;
    const evt = event(t, 'document.submitted', '018f0000-0000-7000-8000-0000000000d1', { docTypeKey: 'po', number: 'PO/1' });
    await c.db.insertInto('app.outbox_event').values({ tenant_id: t.tenantId, event_type: evt.type, aggregate_kind: 'document', aggregate_id: null, payload: JSON.stringify(evt.payload) }).execute();
    const ob = await c.db.selectFrom('app.outbox_event').select(['id', 'created_at']).where('tenant_id', '=', t.tenantId).where('event_type', '=', 'document.submitted').orderBy('id', 'desc').executeTakeFirstOrThrow();
    evt.outboxId = String(ob.id);
    expect((await engine(c).handle(evt)).webhooks).toBe(2); // ERP (subscribed) + evil ('*')
    expect((await engine(c).handle(evt)).webhooks).toBe(2); // redelivery → same pending deliveries, no new rows
    const dels = await c.db.selectFrom('app.webhook_delivery').selectAll().where('outbox_id', '=', evt.outboxId).execute();
    expect(dels).toHaveLength(2);
    const mine = dels.find(d => d.endpoint_id === ep.id)!;
    expect(await hooks.deliver(t.tenantId, mine.id)).toBe('delivered');
    expect(await hooks.deliver(t.tenantId, mine.id)).toBe('skipped');
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.address).toBe('93.184.216.34');
    expect(req.url.href).toBe('https://hooks.customer.test/procure');
    expect(req.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-Procure-Event': 'document.submitted', 'X-Procure-Delivery': mine.id });
    expect(verifyWebhookSignature(ep.secret, req.body, req.headers['X-Procure-Signature']!)).toBe(true);
    expect(JSON.parse(req.body)).toMatchObject({ id: `evt_${evt.outboxId}`, type: 'document.submitted', tenant: { id: t.tenantId, code: t.code }, data: { number: 'PO/1' } });
    expect(req.timeoutMs).toBe(10_000);
    // an event nobody subscribed to (except '*')
    expect((await engine(c).handle(event(t, 'comment.created', null))).webhooks).toBe(1);
    // internal events never go out
    expect((await engine(c).handle(event(t, 'notify.effect_send', null))).webhooks).toBe(0);
    const log = await mustOk(a().get(`/config/webhooks/${ep.id}/deliveries`));
    expect(log[0]).toMatchObject({ id: mine.id, status: 'delivered', attempts: 1, responseCode: 200 });
  });

  it('SSRF re-check at send: DNS rebinding to a private address is blocked before connecting', async () => {
    const evil = (await c.db.selectFrom('app.webhook_endpoint').select('id').where('url', '=', 'https://evil.customer.test/in').executeTakeFirstOrThrow()).id;
    const d = await c.db.selectFrom('app.webhook_delivery').select('id').where('endpoint_id', '=', evil).where('status', '=', 'pending').executeTakeFirstOrThrow();
    dns['evil.customer.test'] = '169.254.169.254';
    sent.length = 0;
    expect(await hooks.deliver(t.tenantId, d.id)).toBe('pending');
    expect(sent).toHaveLength(0);
    const row = await c.db.selectFrom('app.webhook_delivery').selectAll().where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(row.response_body).toMatch(/^Blocked: .*169\.254\.169\.254/);
    expect(row).toMatchObject({ attempts: 1, response_code: null });
    dns['evil.customer.test'] = '93.184.216.35';
  });

  it('retries with exponential backoff (max 6 h), fails after 9 attempts; 50 consecutive failures disable the endpoint', async () => {
    await mustOk(a().del(`/config/webhooks/${((globalThis as Record<string, unknown>).__ep as { id: string }).id}`), 204); // make room (limit 2)
    const ep = await mustOk(a().post('/config/webhooks', { url: 'https://hooks.customer.test/flaky', events: ['po.amended'] }), 201);
    reply = () => ({ status: 503, body: 'down' });
    await engine(c).handle(event(t, 'po.amended', null));
    const d = await c.db.selectFrom('app.webhook_delivery').selectAll().where('endpoint_id', '=', ep.id).executeTakeFirstOrThrow();
    const q = c.app.get(QueueService).queue(WEBHOOK_QUEUE);
    expect(await q.getJob(`whd:${d.id}:0`)).toBeTruthy();
    expect(await hooks.deliver(t.tenantId, d.id)).toBe('pending');
    let row = await c.db.selectFrom('app.webhook_delivery').selectAll().where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'pending', attempts: 1, response_code: 503, response_body: 'down' });
    const next = await q.getJob(`whd:${d.id}:1`);
    expect(next?.opts.delay).toBe(retryDelayMs(1));
    expect(Math.abs(new Date(row.next_attempt_at!).getTime() - Date.now() - retryDelayMs(1))).toBeLessThan(5000);
    for (let i = 2; i <= WEBHOOK_MAX_ATTEMPTS; i++) await hooks.deliver(t.tenantId, d.id);
    row = await c.db.selectFrom('app.webhook_delivery').selectAll().where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'failed', attempts: WEBHOOK_MAX_ATTEMPTS, next_attempt_at: null });
    expect((await q.getJob(`whd:${d.id}:8`))?.opts.delay).toBe(6 * 3600 * 1000);

    // consecutive failures counter: success resets it; 50 in a row disables + notifies admins
    const redis = c.app.get(RedisService);
    expect(Number(await redis.client.get(`wh:fails:${ep.id}`))).toBe(WEBHOOK_MAX_ATTEMPTS);
    await redis.client.set(`wh:fails:${ep.id}`, '49');
    await engine(c).handle(event(t, 'po.amended', null));
    const d2 = await c.db.selectFrom('app.webhook_delivery').select('id').where('endpoint_id', '=', ep.id).where('status', '=', 'pending').executeTakeFirstOrThrow();
    await hooks.deliver(t.tenantId, d2.id);
    const epRow = await c.db.selectFrom('app.webhook_endpoint').select(['is_active']).where('id', '=', ep.id).executeTakeFirstOrThrow();
    expect(epRow.is_active).toBe(false);
    expect((await c.db.selectFrom('app.webhook_delivery').select('status').where('id', '=', d2.id).executeTakeFirstOrThrow()).status).toBe('failed');
    const note = await c.db.selectFrom('app.notification').select(['kind', 'body']).where('tenant_id', '=', t.tenantId).where('kind', '=', 'webhook_disabled').execute();
    expect(note).toHaveLength(1);
    // disabled endpoints get nothing new
    const before = await c.db.selectFrom('app.webhook_delivery').select('id').where('endpoint_id', '=', ep.id).execute();
    await engine(c).handle(event(t, 'po.amended', null));
    expect(await c.db.selectFrom('app.webhook_delivery').select('id').where('endpoint_id', '=', ep.id).execute()).toHaveLength(before.length);
    // re-enable resets the counter
    const cur = await mustOk(a().get(`/config/webhooks/${ep.id}`));
    await mustOk(a().put(`/config/webhooks/${ep.id}`, { url: cur.url, events: cur.events, isActive: true, version: cur.version }));
    expect(await redis.client.get(`wh:fails:${ep.id}`)).toBeNull();
    reply = () => ({ status: 200, body: 'ok' });
  });

  it('test endpoint sends one webhook.test delivery; update / delete with version + audit', async () => {
    const ep = (await mustOk<{ id: string; url: string; events: string[]; version: number }[]>(a().get('/config/webhooks'))).find(e => e.url.endsWith('/flaky'));
    sent.length = 0;
    const d = await mustOk(a().post(`/config/webhooks/${ep!.id}/test`), 200);
    expect(d).toMatchObject({ endpointId: ep!.id, eventType: 'webhook.test', status: 'delivered', attempts: 1, responseCode: 200 });
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ type: 'webhook.test', data: { test: true } });
    reply = () => ({ status: 500, body: 'nope' });
    const f = await mustOk(a().post(`/config/webhooks/${ep!.id}/test`), 200);
    expect(f).toMatchObject({ status: 'failed', attempts: 1, responseCode: 500 });
    reply = () => ({ status: 200, body: 'ok' });
    expect((await a().put(`/config/webhooks/${ep!.id}`, { url: ep!.url, events: ep!.events, version: ep!.version + 5 })).status).toBe(409);
    expect((await a().put(`/config/webhooks/${ep!.id}`, { url: 'https://10.1.1.1/x', events: ep!.events, version: ep!.version })).status).toBe(400);
    await mustOk(a().del(`/config/webhooks/${ep!.id}`), 204);
    expect((await a().get(`/config/webhooks/${ep!.id}`)).status).toBe(404);
    const audit = await c.db.selectFrom('app.audit_log').select('action').where('tenant_id', '=', t.tenantId).where('entity', '=', 'webhook_endpoint').execute();
    expect(audit.map(x => x.action)).toEqual(expect.arrayContaining(['create', 'update', 'delete', 'auto_disable']));
  });

  it('feature api_access and permissions gate the endpoints', async () => {
    const no = await notifyTenant(c, { saToken: t.saToken, features: ['indent', 'purchase', 'email'] });
    const r = await api(c, no.token).get('/config/webhooks');
    expect([403, 404]).toContain(r.status);
    expect((await engine(c).handle(event(no, 'document.submitted', null))).webhooks).toBe(0);
    const viewer = await wfUser(c, t, ['config.webhooks:action.view']);
    expect((await api(c, viewer.token).get('/config/webhooks')).status).toBe(200);
    expect((await api(c, viewer.token).post('/config/webhooks', { url: 'https://hooks.customer.test/v', events: ['*'] })).status).toBe(403);
    const nobody = await wfUser(c, t, ['messages:action.view']);
    expect((await api(c, nobody.token).get('/config/webhooks')).status).toBe(403);
  });
});

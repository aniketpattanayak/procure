import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ErrorCode, WebhookDeliveryRow, WebhookEndpointInput, WebhookEndpointRow } from '@procure/schema';
import { sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import { DbService, Tx } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { AppError } from '../../core/errors';
import { QueueService } from '../../core/queue.service';
import { RedisService } from '../../core/redis.service';
import { INTERNAL_EVENT_PREFIX } from './rules.service';
import { decryptSecret, encryptSecret } from './util/crypto';
import { signWebhook } from './util/signature';
import { Resolver, SsrfError, systemResolver, vetUrl } from './util/ssrf';

type Input = z.infer<typeof WebhookEndpointInput>;
export const WEBHOOK_QUEUE = 'webhook-deliver';
/** First attempt + 8 retries. */
export const WEBHOOK_MAX_ATTEMPTS = 9;
export const WEBHOOK_DISABLE_AFTER = 50;
const TIMEOUT_MS = 10_000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
/** Delay before retry n (1-based): 30 s × 4^(n-1), capped at 6 h → 30 s, 2 m, 8 m, 32 m, 2.1 h, 6 h, 6 h, 6 h. */
export const retryDelayMs = (n: number) => Math.min(30_000 * 4 ** (n - 1), MAX_DELAY_MS);
const failKey = (endpointId: string) => `wh:fails:${endpointId}`;

export interface TransportRequest { url: URL; address: string; family: number; body: string; headers: Record<string, string>; timeoutMs: number }
export type Transport = (r: TransportRequest) => Promise<{ status: number; body: string }>;

/** HTTPS POST pinned to the vetted IP (no second DNS lookup → no rebinding between check and connect). */
export const httpsTransport: Transport = r => new Promise((resolve, reject) => {
  const req = httpsRequest({
    host: r.url.hostname, servername: r.url.hostname.replace(/^\[|\]$/g, ''), port: r.url.port || 443, path: `${r.url.pathname}${r.url.search}`, method: 'POST',
    headers: { ...r.headers, 'Content-Length': Buffer.byteLength(r.body).toString() }, timeout: r.timeoutMs,
    // QA47-BUG-008: Node ≥ 20 (autoSelectFamily) calls lookup with { all: true } and expects an address list;
    // answering (address, family) there fails every connection with "Invalid IP address: undefined".
    lookup: (_h, o, cb) => ((o as { all?: boolean } | undefined)?.all
      ? (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: r.address, family: r.family }])
      : (cb as (e: null, a: string, f: number) => void)(null, r.address, r.family)),
  }, res => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => { if (size < 1024) { chunks.push(c); size += c.length; } });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, 1024) }));
    res.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new Error('timeout after 10 s')));
  req.on('error', reject);
  req.end(r.body);
});

interface EndpointDb { id: string; url: string; description: string | null; events: string[]; secret: string; is_active: boolean; created_at: Date; version: number }
const toEndpoint = (r: EndpointDb, secret?: string): WebhookEndpointRow => ({
  id: r.id, url: r.url, description: r.description, events: r.events, isActive: r.is_active, createdAt: new Date(r.created_at).toISOString(), version: r.version,
  ...(secret ? { secret } : {}),
});
interface DeliveryDb { id: string; endpoint_id: string; event_type: string; status: 'pending' | 'delivered' | 'failed'; attempts: number; response_code: number | null; created_at: Date; delivered_at: Date | null }
const toDelivery = (d: DeliveryDb): WebhookDeliveryRow => ({
  id: d.id, endpointId: d.endpoint_id, eventType: d.event_type, status: d.status, attempts: d.attempts, responseCode: d.response_code,
  createdAt: new Date(d.created_at).toISOString(), deliveredAt: d.delivered_at ? new Date(d.delivered_at).toISOString() : null,
});
const DELIVERY_COLS = ['id', 'endpoint_id', 'event_type', 'status', 'attempts', 'response_code', 'created_at', 'delivered_at'] as const;
const ENDPOINT_COLS = ['id', 'url', 'description', 'events', 'secret', 'is_active', 'created_at', 'version'] as const;

/**
 * Outgoing webhooks (feature api_access, limit webhook_endpoints). Each event fans out to subscribed endpoints as one
 * webhook_delivery row (unique per endpoint + outbox id); deliveries are POSTed with an HMAC signature, retried 8×
 * with exponential backoff (max 6 h), and an endpoint is disabled after 50 consecutive failed attempts.
 */
@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly log = new Logger('Webhooks');
  /** Test seams. */
  transport: Transport = httpsTransport;
  resolver: Resolver = systemResolver;

  constructor(
    private readonly db: DbService,
    private readonly queue: QueueService,
    private readonly ent: EntitlementsService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.queue.registerProcessor(WEBHOOK_QUEUE, job => this.deliver((job.data as { tenantId: string; deliveryId: string }).tenantId, (job.data as { deliveryId: string }).deliveryId), 5);
  }

  // ------------------------------------------------------------------ endpoints
  async list(tx: Tx): Promise<WebhookEndpointRow[]> {
    return (await tx.selectFrom('app.webhook_endpoint').select([...ENDPOINT_COLS]).orderBy('created_at').execute()).map(r => toEndpoint(r as EndpointDb));
  }

  async get(tx: Tx, id: string): Promise<WebhookEndpointRow> {
    return toEndpoint(await this.endpoint(tx, id));
  }

  private async endpoint(tx: Tx, id: string, lock = false): Promise<EndpointDb> {
    let q = tx.selectFrom('app.webhook_endpoint').select([...ENDPOINT_COLS]).where('id', '=', id);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw AppError.notFound('Webhook');
    return r as EndpointDb;
  }

  private async validate(i: Input) {
    i.events.forEach((e, k) => {
      if (e !== '*' && (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(e) || e.startsWith(INTERNAL_EVENT_PREFIX))) {
        throw new AppError(400, ErrorCode.VALIDATION, `Unknown event "${e}".`, undefined, [{ path: `events.${k}`, message: 'Unknown event' }]);
      }
    });
    try {
      await vetUrl(i.url, this.resolver);
    } catch (e) {
      if (e instanceof SsrfError) throw new AppError(400, ErrorCode.VALIDATION, e.message, undefined, [{ path: 'url', message: e.message }]);
      throw e;
    }
  }

  async create(tx: Tx, tenantId: string, userId: string | null, i: Input): Promise<WebhookEndpointRow> {
    await this.validate(i);
    const lim = (await sql<{ lim: string | null }>`select app.lock_tenant_for_limit('webhook_endpoints')::text as lim`.execute(tx)).rows[0]?.lim;
    const limit = lim === null || lim === undefined ? null : Number(lim);
    const used = Number((await tx.selectFrom('app.webhook_endpoint').select(eb => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
    if (limit !== null && used + 1 > limit) throw AppError.limitExceeded('webhook_endpoints', limit, used, 'webhook endpoints');
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const r = await tx.insertInto('app.webhook_endpoint').values({
      tenant_id: tenantId, url: i.url, description: i.description ?? null, events: [...new Set(i.events)], secret: encryptSecret(secret), is_active: i.isActive, created_by: userId,
    }).returning([...ENDPOINT_COLS]).executeTakeFirstOrThrow();
    await this.audit.tenant(tx, { action: 'create', entity: 'webhook_endpoint', entityId: r.id, actorId: userId, after: { url: i.url, events: i.events } });
    return toEndpoint(r as EndpointDb, secret);
  }

  async update(tx: Tx, userId: string | null, id: string, i: Input & { version: number }): Promise<WebhookEndpointRow> {
    const cur = await this.endpoint(tx, id, true);
    if (cur.version !== i.version) throw AppError.versionConflict();
    await this.validate(i);
    const r = await tx.updateTable('app.webhook_endpoint').set({ url: i.url, description: i.description ?? null, events: [...new Set(i.events)], is_active: i.isActive, version: cur.version + 1 })
      .where('id', '=', id).returning([...ENDPOINT_COLS]).executeTakeFirstOrThrow();
    if (i.isActive && !cur.is_active) await this.redis.del(failKey(id));
    await this.audit.tenant(tx, { action: 'update', entity: 'webhook_endpoint', entityId: id, actorId: userId, before: { url: cur.url, events: cur.events, isActive: cur.is_active }, after: { url: i.url, events: i.events, isActive: i.isActive } });
    return toEndpoint(r as EndpointDb);
  }

  async remove(tx: Tx, userId: string | null, id: string): Promise<void> {
    const cur = await this.endpoint(tx, id, true);
    await tx.deleteFrom('app.webhook_delivery').where('endpoint_id', '=', id).execute();
    await tx.deleteFrom('app.webhook_endpoint').where('id', '=', id).execute();
    await this.redis.del(failKey(id));
    await this.audit.tenant(tx, { action: 'delete', entity: 'webhook_endpoint', entityId: id, actorId: userId, before: { url: cur.url } });
  }

  async deliveries(tx: Tx, endpointId: string): Promise<WebhookDeliveryRow[]> {
    await this.endpoint(tx, endpointId);
    const rows = await tx.selectFrom('app.webhook_delivery').select([...DELIVERY_COLS]).where('endpoint_id', '=', endpointId)
      .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(200).execute();
    return rows.map(r => toDelivery(r as DeliveryDb));
  }

  /** Sends a `webhook.test` event now (one attempt, no retries) and returns the delivery. */
  async test(tenantId: string, endpointId: string): Promise<WebhookDeliveryRow> {
    const id = await this.db.tenantTx(tenantId, async tx => {
      await this.endpoint(tx, endpointId);
      // Synthetic negative outbox id keeps (endpoint_id, outbox_id) unique without a real outbox row.
      const r = await tx.insertInto('app.webhook_delivery').values({ tenant_id: tenantId, endpoint_id: endpointId, outbox_id: -Date.now() * 1000 - Math.floor(Math.random() * 1000), event_type: 'webhook.test' })
        .returning('id').executeTakeFirstOrThrow();
      return r.id;
    });
    await this.deliver(tenantId, id, { final: true });
    return this.db.tenantTx(tenantId, async tx => toDelivery(await tx.selectFrom('app.webhook_delivery').select([...DELIVERY_COLS]).where('id', '=', id).executeTakeFirstOrThrow() as DeliveryDb));
  }

  // ------------------------------------------------------------------ fan-out + delivery
  async fanout(evt: { outboxId: string; tenantId: string; type: string }): Promise<number> {
    if (evt.type.startsWith(INTERNAL_EVENT_PREFIX)) return 0;
    if (!(await this.ent.hasFeature(evt.tenantId, 'api_access'))) return 0;
    const pending = await this.db.tenantTx(evt.tenantId, async tx => {
      const eps = await tx.selectFrom('app.webhook_endpoint').select('id').where('is_active', '=', true)
        .where(sql<boolean>`(events @> array[${evt.type}]::text[] or '*' = any(events))`).execute();
      if (!eps.length) return [];
      await tx.insertInto('app.webhook_delivery').values(eps.map(e => ({ tenant_id: evt.tenantId, endpoint_id: e.id, outbox_id: evt.outboxId, event_type: evt.type })))
        .onConflict(oc => oc.columns(['endpoint_id', 'outbox_id']).doNothing()).execute();
      return tx.selectFrom('app.webhook_delivery').select(['id', 'attempts']).where('outbox_id', '=', evt.outboxId)
        .where('endpoint_id', 'in', eps.map(e => e.id)).where('status', '=', 'pending').execute();
    });
    for (const d of pending) await this.schedule(evt.tenantId, d.id, d.attempts, 0);
    return pending.length;
  }

  /** jobId per attempt: a re-run of the same fan-out or sweep never duplicates an attempt. */
  async schedule(tenantId: string, deliveryId: string, attempt: number, delayMs: number) {
    await this.queue.enqueue(WEBHOOK_QUEUE, 'deliver', { tenantId, deliveryId }, { jobId: `whd:${deliveryId}:${attempt}`, delay: delayMs, attempts: 1 });
  }

  /** One delivery attempt (SSRF re-check at send time). Returns the resulting status. */
  async deliver(tenantId: string, deliveryId: string, opts: { final?: boolean } = {}): Promise<'delivered' | 'pending' | 'failed' | 'skipped'> {
    const load = await this.db.tenantTx(tenantId, async tx => {
      const d = await tx.selectFrom('app.webhook_delivery').select(['id', 'endpoint_id', 'outbox_id', 'event_type', 'status', 'attempts', 'created_at'])
        .where('id', '=', deliveryId).executeTakeFirst();
      if (!d || d.status !== 'pending') return null;
      const ep = await tx.selectFrom('app.webhook_endpoint').select(['id', 'url', 'secret', 'is_active']).where('id', '=', d.endpoint_id).executeTakeFirst();
      const ev = Number(d.outbox_id) > 0
        ? await tx.selectFrom('app.outbox_event').select(['payload', 'created_at', 'event_type']).where('id', '=', d.outbox_id).executeTakeFirst()
        : null;
      return { d, ep, ev };
    });
    if (!load) return 'skipped';
    const { d, ep, ev } = load;
    if (!ep || !ep.is_active) {
      await this.finish(tenantId, d.id, { status: 'failed', response_body: 'Endpoint disabled', next_attempt_at: null });
      return 'failed';
    }
    const state = await this.ent.state(tenantId);
    const body = JSON.stringify({
      id: Number(d.outbox_id) > 0 ? `evt_${d.outbox_id}` : `evt_test_${d.id}`, type: d.event_type,
      occurredAt: new Date(ev?.created_at ?? d.created_at).toISOString(), tenant: { id: tenantId, code: state?.code ?? null },
      data: ev ? ev.payload : { test: true, message: 'This is a test event from Procure.' },
    });
    const headers = {
      'Content-Type': 'application/json', 'User-Agent': 'Procure-Webhooks/1.0',
      'X-Procure-Signature': signWebhook(decryptSecret(ep.secret), body), 'X-Procure-Event': d.event_type, 'X-Procure-Delivery': d.id,
    };
    let code: number | null = null;
    let text: string;
    let ok = false;
    try {
      const { url, addresses } = await vetUrl(ep.url, this.resolver);
      const a = addresses[0]!;
      const res = await this.transport({ url, address: a.address, family: a.family, body, headers, timeoutMs: TIMEOUT_MS });
      code = res.status;
      text = res.body.slice(0, 1024);
      ok = res.status >= 200 && res.status < 300;
    } catch (e) {
      text = (e instanceof SsrfError ? `Blocked: ${e.message}` : `Error: ${(e as Error).message}`).slice(0, 1024);
    }
    const attempts = d.attempts + 1;
    if (ok) {
      await this.finish(tenantId, d.id, { status: 'delivered', attempts, response_code: code, response_body: text, delivered_at: new Date(), next_attempt_at: null });
      await this.redis.del(failKey(ep.id));
      return 'delivered';
    }
    const last = opts.final || attempts >= WEBHOOK_MAX_ATTEMPTS;
    const delay = retryDelayMs(attempts);
    await this.finish(tenantId, d.id, {
      status: last ? 'failed' : 'pending', attempts, response_code: code, response_body: text, next_attempt_at: last ? null : new Date(Date.now() + delay),
    });
    const fails = await this.redis.client.incr(failKey(ep.id));
    if (fails >= WEBHOOK_DISABLE_AFTER) {
      await this.disable(tenantId, ep.id, fails);
      return last ? 'failed' : 'pending';
    }
    if (!last) await this.schedule(tenantId, d.id, attempts, delay);
    return last ? 'failed' : 'pending';
  }

  private finish(tenantId: string, id: string, patch: Record<string, unknown>) {
    return this.db.tenantTx(tenantId, tx => tx.updateTable('app.webhook_delivery').set(patch).where('id', '=', id).execute());
  }

  /** Auto-disable after 50 consecutive failed attempts: endpoint off, pending deliveries failed, admins notified. */
  private async disable(tenantId: string, endpointId: string, fails: number) {
    await this.db.tenantTx(tenantId, async tx => {
      const ep = await tx.updateTable('app.webhook_endpoint').set(eb => ({ is_active: false, version: eb('version', '+', 1) }))
        .where('id', '=', endpointId).where('is_active', '=', true).returning(['url']).executeTakeFirst();
      if (!ep) return;
      await tx.updateTable('app.webhook_delivery').set({ status: 'failed', next_attempt_at: null }).where('endpoint_id', '=', endpointId).where('status', '=', 'pending').execute();
      const admins = await tx.selectFrom('app.tenant_user').select('id').where('is_tenant_admin', '=', true).where('is_active', '=', true).where('is_deleted', '=', false).execute();
      if (admins.length) {
        await tx.insertInto('app.notification').values(admins.map(a => ({
          user_id: a.id, kind: 'webhook_disabled', title: 'A webhook was turned off after repeated failures',
          body: `${ep.url} failed ${fails} times in a row. Fix the receiving server, then turn the webhook back on.`, link: '/config/webhooks',
          data: JSON.stringify({ endpointId, failures: fails }),
        }))).execute();
      }
      await this.audit.tenant(tx, { action: 'auto_disable', entity: 'webhook_endpoint', entityId: endpointId, actorId: null, after: { failures: fails } });
    });
    await this.redis.del(failKey(endpointId));
    this.log.warn(`webhook ${endpointId} disabled after ${fails} consecutive failures`);
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from '../../../core/db.service';
import { QueueService } from '../../../core/queue.service';

export const OUTBOX_QUEUE = 'outbox';
export const EVENTS_QUEUE = 'events';
/** Phase 6: trigger engine + outgoing webhooks consume their own copy of every event (same jobId). */
export const EVENTS_NOTIFY_QUEUE = 'events-notify';
/**
 * Fan-out: every published event is enqueued once to each of these queues (BullMQ workers on one queue compete, so
 * each consumer needs its own queue). Append a queue name here to add a consumer (reports, …).
 */
export const EVENT_FANOUT_QUEUES: readonly string[] = [EVENTS_QUEUE, EVENTS_NOTIFY_QUEUE];

export interface OutboxRow {
  id: string; tenant_id: string; event_type: string; aggregate_kind: string; aggregate_id: string | null; payload: Record<string, unknown>; created_at: Date;
}
export type Publisher = (e: OutboxRow) => Promise<void>;

/**
 * Transactional outbox relay (ADR-0012, contract "Outbox & queues"): every 2 s, under the platform role, takes up to
 * 500 unpublished events `FOR UPDATE SKIP LOCKED` (so concurrent relays never take the same row), publishes each to
 * queue `events` with jobId `outbox:<id>`, and marks it published. The `events` consumer only logs in Phase 3.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit {
  private readonly log = new Logger('Outbox');
  constructor(private readonly db: DbService, private readonly queue: QueueService) {}

  onModuleInit() {
    this.queue.registerProcessor(OUTBOX_QUEUE, async job => (job.name === 'outbox-relay' ? this.relayOnce() : undefined), 1);
    this.queue.registerRepeat(OUTBOX_QUEUE, 'outbox-relay', { every: 2000 });
    this.queue.registerProcessor(EVENTS_QUEUE, async job => {
      this.log.debug(`event ${job.name} ${job.id}`);
      return { logged: true };
    });
  }

  private publishToQueue: Publisher = async e => {
    const data = {
      outboxId: e.id, tenantId: e.tenant_id, type: e.event_type, aggregate: { kind: e.aggregate_kind, id: e.aggregate_id }, payload: e.payload,
      at: new Date(e.created_at).toISOString(),
    };
    // Same jobId on every queue: a re-publish after a partial failure is de-duplicated per queue.
    for (const q of EVENT_FANOUT_QUEUES) await this.queue.enqueue(q, e.event_type, data, { jobId: `outbox:${e.id}` });
  };

  /** One relay pass; returns how many events were published. `publish` is replaceable for tests. */
  async relayOnce(publish: Publisher = this.publishToQueue, limit = 500): Promise<number> {
    return this.db.platformTx(async tx => {
      const rows = (await sql<OutboxRow>`
        select id, tenant_id, event_type, aggregate_kind, aggregate_id, payload, created_at from app.outbox_event
         where published_at is null order by id limit ${limit} for update skip locked`.execute(tx)).rows;
      const done: string[] = [];
      for (const r of rows) {
        try {
          await publish(r);
          done.push(r.id);
        } catch (e) {
          await tx.updateTable('app.outbox_event').set(eb => ({ attempts: eb('attempts', '+', 1), last_error: String((e as Error).message ?? e).slice(0, 500) }))
            .where('id', '=', r.id).execute();
        }
      }
      if (done.length) {
        await tx.updateTable('app.outbox_event').set(eb => ({ published_at: new Date(), attempts: eb('attempts', '+', 1) })).where('id', 'in', done).execute();
      }
      return done.length;
    });
  }
}

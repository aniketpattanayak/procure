import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueService } from '../src/core/queue.service';
import { EVENT_FANOUT_QUEUES, EVENTS_NOTIFY_QUEUE, EVENTS_QUEUE, OutboxRelay, OutboxRow } from '../src/modules/documents';
import { mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, drainQueues, startWorkers } from './helpers';
import { capexBody, createCapexType, docsApi, docsTenant, DocsFixture, workflowLink } from './documents-helpers';

describe('outbox relay', () => {
  let c: Ctx;
  let f: DocsFixture;

  beforeAll(async () => {
    c = await bootApp();
    workflowLink(c).override(null);
    f = await docsTenant(c);
    await createCapexType(c, f.token);
  });
  afterAll(async () => {
    workflowLink(c).override(undefined);
    await closeApp(c);
  });

  const insertEvents = async (n: number) => {
    const rows = await c.db.insertInto('app.outbox_event').values(Array.from({ length: n }, (_, i) => ({
      tenant_id: f.tenantId, event_type: 'test.event', aggregate_kind: 'test', aggregate_id: null, payload: JSON.stringify({ i }),
    }))).returning('id').execute();
    return rows.map(r => String(r.id));
  };

  it('concurrent relays publish every event exactly once (FOR UPDATE SKIP LOCKED)', async () => {
    const mine = new Set(await insertEvents(120));
    const relay = c.app.get(OutboxRelay);
    const published: string[] = [];
    const publish = async (e: OutboxRow) => {
      published.push(String(e.id));
      await new Promise(r => setTimeout(r, 2));
    };
    let total = 0;
    for (let round = 0; round < 5 && [...mine].some(id => !published.includes(id)); round++) {
      const counts = await Promise.all([relay.relayOnce(publish, 40), relay.relayOnce(publish, 40), relay.relayOnce(publish, 40), relay.relayOnce(publish, 40)]);
      total += counts.reduce((x, y) => x + y, 0);
    }
    const ours = published.filter(id => mine.has(id));
    expect(ours.length).toBe(120);
    expect(new Set(ours).size).toBe(120);
    expect(total).toBe(published.length);
    const rows = await c.db.selectFrom('app.outbox_event').select(['published_at', 'attempts']).where('id', 'in', [...mine]).execute();
    expect(rows.every(r => r.published_at !== null && r.attempts === 1)).toBe(true);
  });

  it('a failed publish stays unpublished with attempts + last_error and is retried later', async () => {
    const [id] = await insertEvents(1);
    const relay = c.app.get(OutboxRelay);
    await relay.relayOnce(async e => {
      if (String(e.id) === id) throw new Error('redis down');
    });
    const failed = await c.db.selectFrom('app.outbox_event').select(['published_at', 'attempts', 'last_error']).where('id', '=', id!).executeTakeFirstOrThrow();
    expect(failed).toMatchObject({ published_at: null, attempts: 1, last_error: 'redis down' });
    const seen: string[] = [];
    await relay.relayOnce(async e => { seen.push(String(e.id)); });
    expect(seen).toContain(id);
    const ok = await c.db.selectFrom('app.outbox_event').select(['published_at', 'attempts']).where('id', '=', id!).executeTakeFirstOrThrow();
    expect(ok.published_at).not.toBeNull();
    expect(ok.attempts).toBe(2);
  });

  it('fans every event out to each consumer queue (events + events-notify) exactly once, even when re-published', async () => {
    expect(EVENT_FANOUT_QUEUES).toEqual([EVENTS_QUEUE, EVENTS_NOTIFY_QUEUE]);
    const [id] = await insertEvents(1);
    const relay = c.app.get(OutboxRelay);
    const q = c.app.get(QueueService);
    const jobsWithId = async (queue: string) => {
      const jobs = await q.queue(queue).getJobs(['waiting', 'active', 'delayed', 'completed', 'failed', 'paused', 'prioritized']);
      return jobs.filter(j => j?.id === `outbox:${id}`);
    };
    // drain earlier events so this pass definitely includes ours
    for (let i = 0; i < 5 && (await relay.relayOnce()) > 0;) i++;
    // simulate a crash after publishing but before marking published: the relay publishes the same row again
    await c.db.updateTable('app.outbox_event').set({ published_at: null }).where('id', '=', id!).execute();
    await relay.relayOnce();
    for (const name of EVENT_FANOUT_QUEUES) {
      const jobs = await jobsWithId(name);
      expect(jobs, name).toHaveLength(1);
      expect(jobs[0]!.name).toBe('test.event');
      expect(jobs[0]!.data).toMatchObject({ outboxId: id, type: 'test.event', payload: { i: 0 } });
    }
  });

  it('with workers running, business events reach the events queue with jobId outbox:<id>', async () => {
    const doc = await mustOk(docsApi(c, f.token).create(capexBody(f)), 201);
    const ev = await c.db.selectFrom('app.outbox_event').select(['id', 'published_at']).where('aggregate_id', '=', doc.id).executeTakeFirstOrThrow();
    expect(ev.published_at).toBeNull();
    const q = c.app.get(QueueService);
    // the relay job runs inline; push one pass now instead of waiting for the 2 s repeat
    await startWorkers(c);
    await q.enqueue('outbox', 'outbox-relay', {});
    const until = Date.now() + 10000;
    let row = ev;
    while (Date.now() < until) {
      row = await c.db.selectFrom('app.outbox_event').select(['id', 'published_at']).where('id', '=', ev.id).executeTakeFirstOrThrow();
      if (row.published_at) break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(row.published_at).not.toBeNull();
    await drainQueues(c, [EVENTS_QUEUE]);
    const job = await q.queue(EVENTS_QUEUE).getJob(`outbox:${ev.id}`);
    expect(job?.name).toBe('document.created');
    expect(job?.data).toMatchObject({ tenantId: f.tenantId, type: 'document.created', aggregate: { kind: 'document', id: doc.id }, payload: { documentId: doc.id, docTypeKey: 'capex' } });
    // a second publish of the same id is de-duplicated by the queue
    await q.enqueue(EVENTS_QUEUE, 'document.created', { dup: true }, { jobId: `outbox:${ev.id}` });
    expect((await q.queue(EVENTS_QUEUE).getJob(`outbox:${ev.id}`))?.data).not.toHaveProperty('dup');
    const reps = await q.queue('outbox').getRepeatableJobs();
    expect(reps.map(r => [r.name, r.every])).toContainEqual(['outbox-relay', '2000']);
  });
});

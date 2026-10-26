import { Injectable, Logger, BeforeApplicationShutdown } from '@nestjs/common';
import { Job, JobsOptions, Queue, Worker } from 'bullmq';
import { config } from './config';

/**
 * Background jobs (ADR-0012). Modules register processors at startup with `registerProcessor`; producers call
 * `enqueue`. Processors run in the worker process (`dist/worker.js`) — or inside the API process when
 * RUN_WORKERS=inline (default in development and test, so tests and local dev need no second process).
 *
 * Rules: job payloads carry ids, never secrets or large blobs; every processor is idempotent (jobs may run twice);
 * tenant work inside a processor uses DbService.tenantTx(payload.tenantId, …).
 */
export type Processor = (job: Job) => Promise<unknown>;

export interface RepeatSpec { every?: number; pattern?: string } // ms interval or cron pattern (UTC)

@Injectable()
export class QueueService implements BeforeApplicationShutdown {
  private readonly log = new Logger('Queue');
  private readonly queues = new Map<string, Queue>();
  private readonly processors = new Map<string, { fn: Processor; concurrency: number }>();
  private readonly repeats: { queue: string; name: string; spec: RepeatSpec; data: unknown }[] = [];
  private readonly workers: Worker[] = [];
  private started = false;
  private readonly connection = { url: config.redisUrl, maxRetriesPerRequest: null as null };
  private readonly prefix = `procure:${config.env}`;

  queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection, prefix: this.prefix,
        defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 },
      });
      q.on('error', e => this.log.warn(`queue ${name}: ${e.message}`));
      this.queues.set(name, q);
    }
    return q;
  }

  /** Use `jobId` for de-duplication (same jobId while waiting/active = not added twice). */
  async enqueue(queue: string, name: string, data: unknown, opts: JobsOptions = {}): Promise<void> {
    await this.queue(queue).add(name, data, opts);
  }

  registerProcessor(queue: string, fn: Processor, concurrency = 4) {
    if (this.processors.has(queue)) throw new Error(`processor for ${queue} already registered`);
    this.processors.set(queue, { fn, concurrency });
    if (this.started) this.startWorker(queue);
  }

  /** Repeatable job, registered idempotently when workers start (e.g. SLA scan every minute, nightly audit check). */
  registerRepeat(queue: string, name: string, spec: RepeatSpec, data: unknown = {}) {
    this.repeats.push({ queue, name, spec, data });
    // Registered after workers started (e.g. a module initialised late): add it now instead of dropping it.
    if (this.started) {
      void this.queue(queue).add(name, data, { repeat: spec, jobId: `repeat:${queue}:${name}` })
        .catch(e => this.log.warn(`repeat ${queue}/${name}: ${(e as Error).message}`));
    }
  }

  /** Called by worker.ts, or by the API on boot when RUN_WORKERS=inline. */
  async startWorkers() {
    if (this.started) return;
    this.started = true;
    for (const queue of this.processors.keys()) this.startWorker(queue);
    for (const r of this.repeats) {
      await this.queue(r.queue).add(r.name, r.data, { repeat: r.spec, jobId: `repeat:${r.queue}:${r.name}` });
    }
  }

  private startWorker(queue: string) {
    const p = this.processors.get(queue)!;
    const w = new Worker(queue, p.fn, { connection: this.connection, prefix: this.prefix, concurrency: p.concurrency });
    w.on('failed', (job, err) => this.log.warn(`${queue}/${job?.name} failed (attempt ${job?.attemptsMade}): ${err.message}`));
    w.on('error', e => this.log.warn(`worker ${queue}: ${e.message}`));
    this.workers.push(w);
  }

  /** Test helper: wait until the named queues have no waiting/active/delayed jobs (repeatables excluded). */
  async drain(queues: string[], timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      let busy = 0;
      for (const n of queues) {
        const c = await this.queue(n).getJobCounts('waiting', 'active', 'delayed');
        busy += (c.waiting ?? 0) + (c.active ?? 0);
      }
      if (!busy) return;
      if (Date.now() > until) throw new Error(`queues not drained: ${queues.join(',')}`);
      await new Promise(r => setTimeout(r, 50));
    }
  }

  /** Runs before Redis/DB close (they close in onApplicationShutdown), so in-flight jobs finish on live connections. */
  async beforeApplicationShutdown() {
    await Promise.allSettled(this.workers.map(w => w.close()));
    await Promise.allSettled([...this.queues.values()].map(q => q.close()));
  }
}

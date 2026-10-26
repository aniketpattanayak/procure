import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from '../../core/db.service';
import { QueueService } from '../../core/queue.service';
import { RedisService } from '../../core/redis.service';
import { DefinitionsService, RETIRED_TENANTS_KEY } from './definitions.service';
import { EngineService } from './engine.service';

const NIL = '00000000-0000-0000-0000-000000000000';
const BATCH = 100;

/**
 * SLA reminders and one-time escalation (contract §SLA). Repeatable job `workflow-sla` every minute on queue
 * `workflow`. Due rows are claimed with FOR UPDATE SKIP LOCKED inside each tenant's transaction, so two concurrent
 * runs never process the same row, and a processed row is no longer due (next_reminder_at advanced / escalated_at set).
 *
 * Tenant discovery: `app.wf_sla_due_tenants(now)` (migration 0010, SECURITY DEFINER, returns tenant ids only).
 */
@Injectable()
export class SlaService implements OnModuleInit {
  private readonly log = new Logger('WorkflowSla');
  constructor(private readonly db: DbService, private readonly queue: QueueService, private readonly engine: EngineService,
    private readonly defs: DefinitionsService, private readonly redis: RedisService) {}

  onModuleInit() {
    this.queue.registerProcessor('workflow', async job => {
      if (job.name === 'workflow-sla') return this.run(new Date());
      if (job.name === 'workflow-retired-cleanup') return this.cleanupRetired();
      return null;
    }, 1);
    this.queue.registerRepeat('workflow', 'workflow-sla', { every: 60_000 });
    this.queue.registerRepeat('workflow', 'workflow-retired-cleanup', { pattern: '20 3 * * *' });
  }

  async dueTenants(now: Date): Promise<string[]> {
    // No tenant context is needed (the function is SECURITY DEFINER); NIL keeps RLS closed for anything else.
    return this.db.tenantTx(NIL, async tx => {
      const r = await sql<{ tenant_id: string }>`select tenant_id from app.wf_sla_due_tenants(${now})`.execute(tx);
      return r.rows.map(x => x.tenant_id);
    });
  }

  /** One scan at `now` (injectable clock for tests). Returns the number of stage rows processed. */
  async run(now: Date = new Date()): Promise<{ processed: number }> {
    let processed = 0;
    for (const tenantId of await this.dueTenants(now)) {
      try {
        processed += await this.runTenant(tenantId, now);
      } catch (e) {
        this.log.warn(`SLA scan failed for tenant ${tenantId}: ${(e as Error).message}`);
      }
    }
    return { processed };
  }

  async runTenant(tenantId: string, now: Date): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.db.tenantTx(tenantId, async tx => {
        const rows = await sql<{ instance_id: string; stage_key: string; due_at: Date | null; next_reminder_at: Date | null; escalated_at: Date | null; reminders_sent: number }>`
          select instance_id, stage_key, due_at, next_reminder_at, escalated_at, reminders_sent
          from app.wf_stage_state
          where status = 'active'
            and ((next_reminder_at is not null and next_reminder_at <= ${now})
              or (due_at is not null and escalated_at is null and due_at <= ${now}))
          order by coalesce(least(next_reminder_at, due_at), due_at, next_reminder_at), instance_id, stage_key
          limit ${BATCH}
          for update skip locked`.execute(tx);
        for (const r of rows.rows) await this.engine.slaTick(tx, r, now);
        return rows.rows.length;
      });
      total += n;
      if (n < BATCH) return total;
    }
  }

  /**
   * Daily: deletes retired stage keys (stages removed by a publish) that no running instance references any more.
   * Tenants come from the set written at publish; actions also clean up inline, so this is the safety net.
   */
  async cleanupRetired(): Promise<{ tenants: number; remaining: number }> {
    const tenants = await this.redis.client.smembers(RETIRED_TENANTS_KEY);
    let remaining = 0;
    for (const tenantId of tenants) {
      try {
        const left = await this.db.tenantTx(tenantId, tx => this.defs.cleanupRetiredTenant(tx, tenantId));
        remaining += left;
        if (!left) await this.redis.client.srem(RETIRED_TENANTS_KEY, tenantId);
      } catch (e) {
        this.log.warn(`retired-key cleanup failed for tenant ${tenantId}: ${(e as Error).message}`);
      }
    }
    return { tenants: tenants.length, remaining };
  }
}

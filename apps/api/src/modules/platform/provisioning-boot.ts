import { Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { config } from '../../core/config';
import { DbService } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { QueueService } from '../../core/queue.service';
import { ProcurementInstaller } from '../procurement';

export const PROVISIONING_QUEUE = 'provisioning';

/**
 * Startup job (Phase 4): once per boot, re-runs the idempotent system-type installers (procurement) for every
 * active/suspended tenant, so tenants created before a module shipped get its types. Lists tenants under the
 * platform role (this module), installs inside each tenant's own transaction. Not enqueued under NODE_ENV=test.
 */
@Injectable()
export class ProvisioningBoot implements OnModuleInit, OnApplicationBootstrap {
  private readonly log = new Logger('ProvisioningBoot');
  constructor(
    private readonly db: DbService, private readonly queue: QueueService, private readonly procurement: ProcurementInstaller,
    private readonly ent: EntitlementsService,
  ) {}

  onModuleInit() {
    this.queue.registerProcessor(PROVISIONING_QUEUE, async job => (job.name === 'ensure-all' ? this.ensureAll() : undefined), 1);
  }

  async onApplicationBootstrap() {
    if (config.env === 'test') return;
    await this.queue.enqueue(PROVISIONING_QUEUE, 'ensure-all', {}, { jobId: `ensure-all:${Date.now()}`, removeOnComplete: true, removeOnFail: 50 })
      .catch(e => this.log.warn(`could not enqueue provisioning job: ${(e as Error).message}`));
  }

  /** Runs every installer for every non-archived tenant; returns how many tenants were processed without error. */
  async ensureAll(): Promise<number> {
    const tenants = await this.db.platform.selectFrom('platform.tenant').select('id').where('status', '!=', 'archived').execute();
    let ok = 0;
    for (const t of tenants) {
      try {
        await this.db.tenantTx(t.id, tx => this.procurement.ensure(tx, t.id));
        await this.ent.bumpPermissions(t.id);
        ok++;
      } catch (e) {
        this.log.error(`provisioning failed for tenant ${t.id}: ${(e as Error).message}`);
      }
    }
    return ok;
  }
}

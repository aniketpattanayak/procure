import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import type { InstallContext, InstallStep } from './install-steps';

/**
 * Provisions the procurement system types for one tenant: an ordered list of idempotent install steps (A registers
 * department / indent / vendor_selection, B registers tax / po). `ensure` must run in a tenant transaction; it takes
 * a per-tenant advisory lock so the tenant-creation hook, the seed and the boot job never race each other.
 */
@Injectable()
export class ProcurementInstaller {
  private readonly log = new Logger('ProcurementInstaller');
  private readonly steps: InstallStep[] = [];

  /** Registers an install step (re-registering a key replaces it). */
  register(step: InstallStep): void {
    const i = this.steps.findIndex(s => s.key === step.key);
    if (i >= 0) this.steps[i] = step;
    else this.steps.push(step);
  }

  ordered(): InstallStep[] {
    return [...this.steps].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  }

  async ensure(tx: Tx, tenantId: string, opts: Partial<Omit<InstallContext, 'tenantId'>> = {}): Promise<void> {
    const r = await sql<{ t: string | null }>`select app.current_tenant_id()::text as t`.execute(tx);
    if (r.rows[0]?.t !== tenantId) throw new Error('ProcurementInstaller.ensure needs a tenant transaction for that tenant');
    await sql`select pg_advisory_xact_lock(hashtextextended(${`procurement-install:${tenantId}`}, 0))`.execute(tx);
    const ctx: InstallContext = { tenantId, features: opts.features ?? [], actorId: opts.actorId ?? null };
    for (const step of this.ordered()) {
      try {
        await step.run(tx, ctx);
      } catch (e) {
        this.log.error(`install step "${step.key}" failed for tenant ${tenantId}: ${(e as Error).message}`);
        throw e;
      }
    }
  }
}

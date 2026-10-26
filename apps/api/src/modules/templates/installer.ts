import { Injectable } from '@nestjs/common';
import type { Tx } from '../../core/db.service';

/**
 * Per-tenant provisioning steps for the templates/notify area (same pattern as ProcurementInstaller). Steps must be
 * idempotent (insert-if-missing, never overwrite tenant edits) and run inside a tenant transaction.
 * Orders: 100 = starter templates (this module), 500 = Notify default trigger rules (need the templates).
 * Runs at tenant creation (lead wires `ensure` into provisioning), lazily on first templates access per process, and
 * from the demo seed (backfill).
 */
export interface TemplatesInstallContext {
  tenantId: string;
  /** Feature keys of the tenant's plan (+ overrides). */
  features: string[];
  /** User id to attribute created rows to (null = system). */
  actorId: string | null;
}

export interface TemplatesInstallStep {
  key: string;
  order: number;
  run(tx: Tx, ctx: TemplatesInstallContext): Promise<void>;
}

@Injectable()
export class TemplatesInstaller {
  private readonly steps: TemplatesInstallStep[] = [];

  /** Registers (or replaces, by key) an install step. */
  register(step: TemplatesInstallStep): void {
    const i = this.steps.findIndex(s => s.key === step.key);
    if (i >= 0) this.steps[i] = step;
    else this.steps.push(step);
  }

  ordered(): TemplatesInstallStep[] {
    return [...this.steps].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  }

  async ensure(tx: Tx, tenantId: string, opts: Partial<Omit<TemplatesInstallContext, 'tenantId'>> = {}): Promise<void> {
    const ctx: TemplatesInstallContext = { tenantId, features: opts.features ?? [], actorId: opts.actorId ?? null };
    for (const step of this.ordered()) await step.run(tx, ctx);
  }
}

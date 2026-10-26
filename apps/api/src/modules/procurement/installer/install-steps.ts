import type { Tx } from '../../../core/db.service';

/**
 * Ordered install steps for the procurement system types. Each step must be idempotent (create-if-missing, never
 * overwrite tenant edits). Agent A registers `department`, `indent`, `vendor_selection`; agent B registers `po`,
 * `tax_code`, item `tax_code` field, location `state_code` — via `ProcurementInstaller.register(step)` (usually from
 * a provider's `onModuleInit`). Steps run sorted by `order` then `key`.
 */
export interface InstallContext {
  tenantId: string;
  /** Feature keys of the tenant's plan (+ overrides). Steps may skip work for modules not in the plan. */
  features: string[];
  /** User id to attribute created rows to (null = system). */
  actorId: string | null;
}

export interface InstallStep {
  key: string;
  /** Lower runs first. A uses 100 (masters), 200 (indent), 300 (vendor_selection); B e.g. 150 (tax_code), 400 (po). */
  order: number;
  run(tx: Tx, ctx: InstallContext): Promise<void>;
}

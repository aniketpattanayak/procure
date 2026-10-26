import { Injectable } from '@nestjs/common';
import { ErrorCode, Plan, PlanInput } from '@procure/schema';
import { AuditService } from '../../core/audit.service';
import { DbService, Tx } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { AppError } from '../../core/errors';

@Injectable()
export class PlansService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly ent: EntitlementsService) {}

  async catalog() {
    const [features, limits] = await Promise.all([
      this.db.platform.selectFrom('platform.feature_catalog').selectAll().orderBy('sort_order').orderBy('key').execute(),
      this.db.platform.selectFrom('platform.limit_catalog').selectAll().orderBy('sort_order').orderBy('key').execute(),
    ]);
    return {
      features: features.map(f => ({ key: f.key, name: f.name, description: f.description, kind: f.kind, sortOrder: f.sort_order })),
      limits: limits.map(l => ({ key: l.key, name: l.name, unit: l.unit, meter: l.meter, featureKey: l.feature_key, sortOrder: l.sort_order })),
    };
  }

  async list(): Promise<Plan[]> {
    const plans = await this.db.platform.selectFrom('platform.plan').selectAll().orderBy('price').orderBy('code').execute();
    return Promise.all(plans.map(p => this.load(this.db.platform, p.id)));
  }

  async get(id: string): Promise<Plan> {
    return this.load(this.db.platform, id);
  }

  async create(input: PlanInput): Promise<Plan> {
    return this.db.platformTx(async tx => {
      await this.validateKeys(tx, input);
      const exists = await tx.selectFrom('platform.plan').select('id').where('code', '=', input.code).executeTakeFirst();
      if (exists) throw AppError.conflict(`A plan with code "${input.code}" already exists.`, { field: 'code' });
      const row = await tx.insertInto('platform.plan').values({
        code: input.code, name: input.name, description: input.description ?? null, price: input.price, currency: input.currency,
        billing_cycle: input.billingCycle, trial_days: input.trialDays, is_active: input.isActive,
      }).returning('id').executeTakeFirstOrThrow();
      await this.writeChildren(tx, row.id, input);
      const plan = await this.load(tx, row.id);
      await this.audit.platform(tx, { action: 'create', entity: 'plan', entityId: row.id, after: plan });
      return plan;
    });
  }

  async update(id: string, input: PlanInput & { version: number }): Promise<Plan> {
    const plan = await this.db.platformTx(async tx => {
      const before = await this.load(tx, id);
      await this.validateKeys(tx, input);
      const dup = await tx.selectFrom('platform.plan').select('id').where('code', '=', input.code).where('id', '<>', id).executeTakeFirst();
      if (dup) throw AppError.conflict(`A plan with code "${input.code}" already exists.`, { field: 'code' });
      const res = await tx.updateTable('platform.plan').set({
        code: input.code, name: input.name, description: input.description ?? null, price: input.price, currency: input.currency,
        billing_cycle: input.billingCycle, trial_days: input.trialDays, is_active: input.isActive,
      }).where('id', '=', id).where('version', '=', input.version).executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw AppError.versionConflict();
      await tx.deleteFrom('platform.plan_feature').where('plan_id', '=', id).execute();
      await tx.deleteFrom('platform.plan_limit').where('plan_id', '=', id).execute();
      await this.writeChildren(tx, id, input);
      const after = await this.load(tx, id);
      await this.audit.platform(tx, { action: 'update', entity: 'plan', entityId: id, before, after });
      return after;
    });
    await this.ent.invalidateAll();
    return plan;
  }

  private async writeChildren(tx: Tx, planId: string, input: PlanInput) {
    const feats = [...new Set(input.features)];
    if (feats.length) await tx.insertInto('platform.plan_feature').values(feats.map(feature_key => ({ plan_id: planId, feature_key }))).execute();
    const limits = Object.entries(input.limits);
    if (limits.length) await tx.insertInto('platform.plan_limit').values(limits.map(([limit_key, value]) => ({ plan_id: planId, limit_key, value }))).execute();
  }

  private async validateKeys(tx: Tx, input: PlanInput) {
    const errors: { path: string; message: string }[] = [];
    if (input.features.length) {
      const known = new Set((await tx.selectFrom('platform.feature_catalog').select('key').execute()).map(r => r.key));
      input.features.forEach((f, i) => { if (!known.has(f)) errors.push({ path: `features.${i}`, message: `Unknown feature "${f}"` }); });
    }
    const limitKeys = Object.keys(input.limits);
    if (limitKeys.length) {
      const known = new Set((await tx.selectFrom('platform.limit_catalog').select('key').execute()).map(r => r.key));
      limitKeys.forEach(k => { if (!known.has(k)) errors.push({ path: `limits.${k}`, message: `Unknown limit "${k}"` }); });
    }
    if (errors.length) throw new AppError(400, ErrorCode.VALIDATION, 'The plan refers to features or limits that do not exist.', undefined, errors);
  }

  private async load(db: Tx | DbService['platform'], id: string): Promise<Plan> {
    const p = await db.selectFrom('platform.plan').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw AppError.notFound('Plan');
    const [feats, limits, count] = await Promise.all([
      db.selectFrom('platform.plan_feature').select('feature_key').where('plan_id', '=', id).orderBy('feature_key').execute(),
      db.selectFrom('platform.plan_limit').select(['limit_key', 'value']).where('plan_id', '=', id).orderBy('limit_key').execute(),
      db.selectFrom('platform.subscription').select(eb => eb.fn.count<string>('tenant_id').distinct().as('n'))
        .where('plan_id', '=', id).where('effective_to', 'is', null).executeTakeFirstOrThrow(),
    ]);
    return {
      id: p.id, code: p.code, name: p.name, description: p.description ?? undefined, price: Number(p.price), currency: p.currency,
      billingCycle: p.billing_cycle as Plan['billingCycle'], trialDays: p.trial_days, isActive: p.is_active,
      features: feats.map(f => f.feature_key),
      limits: Object.fromEntries(limits.map(l => [l.limit_key, l.value === null ? null : Number(l.value)])),
      version: p.version, tenantCount: Number(count.n),
    };
  }
}

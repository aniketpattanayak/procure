import { Injectable } from '@nestjs/common';
import type { Entitlements } from '@procure/schema';
import { DbService, Tx } from '../../core/db.service';

/** Usage period key for monthly meters, in the tenant's timezone ('YYYY-MM'). */
export function monthPeriod(timezone: string, at = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).formatToParts(at);
    const y = parts.find(p => p.type === 'year')?.value;
    const m = parts.find(p => p.type === 'month')?.value;
    if (y && m) return `${y}-${m}`;
  } catch {
    /* invalid timezone: fall back to UTC */
  }
  return at.toISOString().slice(0, 7);
}

type Reader = DbService['platform'] | Tx;

/**
 * Live counters for `live_count` limits. A module that owns a counted thing registers its counter here
 * (Phase 2: locations, custom forms, templates, webhooks). Keys without a counter report 0.
 */
const LIVE_COUNTERS: Record<string, (db: Reader, tenantId: string) => Promise<number>> = {
  max_users: async (db, tenantId) => {
    const r = await db.selectFrom('app.tenant_user').select(eb => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenantId).where('is_active', '=', true).where('is_deleted', '=', false)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  },
  max_locations: async (db, tenantId) => {
    const r = await db.selectFrom('app.location_node').select(eb => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenantId).where('is_active', '=', true).executeTakeFirstOrThrow();
    return Number(r.n);
  },
  custom_forms: async (db, tenantId) => {
    const r = await db.selectFrom('app.master_def').select(eb => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenantId).where('is_system', '=', false).executeTakeFirstOrThrow();
    const d = await db.selectFrom('app.doc_type').select(eb => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenantId).where('kind', '=', 'custom').executeTakeFirstOrThrow();
    return Number(r.n) + Number(d.n);
  },
};

export async function countLive(db: Reader, key: string, tenantId: string): Promise<number> {
  const counter = LIVE_COUNTERS[key];
  return counter ? counter(db, tenantId) : 0;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

/**
 * Builds the full Entitlements view (plan value, override, effective, used) for one tenant.
 * Reads platform tables with the platform role, always filtered by the tenant id it is given.
 * Callers pass either a Super Admin–chosen tenant id or the tenant id of the signed-in principal.
 */
@Injectable()
export class TenantEntitlementsService {
  constructor(private readonly db: DbService) {}

  async build(tenantId: string): Promise<Entitlements | null> {
    const db = this.db.platform;
    const tenant = await db.selectFrom('platform.tenant').select(['id', 'timezone']).where('id', '=', tenantId).executeTakeFirst();
    if (!tenant) return null;
    const sub = await db.selectFrom('platform.subscription as s').innerJoin('platform.plan as p', 'p.id', 's.plan_id')
      .select(['s.plan_id', 's.status', 'p.name']).where('s.tenant_id', '=', tenantId).where('s.effective_to', 'is', null)
      .executeTakeFirst();
    const [featCat, limitCat, planFeats, planLimits, overrides, meters] = await Promise.all([
      db.selectFrom('platform.feature_catalog').selectAll().orderBy('sort_order').orderBy('key').execute(),
      db.selectFrom('platform.limit_catalog').selectAll().orderBy('sort_order').orderBy('key').execute(),
      sub ? db.selectFrom('platform.plan_feature').select('feature_key').where('plan_id', '=', sub.plan_id).execute() : Promise.resolve([]),
      sub ? db.selectFrom('platform.plan_limit').select(['limit_key', 'value']).where('plan_id', '=', sub.plan_id).execute() : Promise.resolve([]),
      db.selectFrom('platform.tenant_override').select(['kind', 'key', 'value']).where('tenant_id', '=', tenantId).execute(),
      db.selectFrom('platform.usage_meter').select(['limit_key', 'period', 'used']).where('tenant_id', '=', tenantId)
        .where('period', 'in', [monthPeriod(tenant.timezone), 'lifetime']).execute(),
    ]);
    const inPlan = new Set(planFeats.map(f => f.feature_key));
    const planLimit = new Map(planLimits.map(l => [l.limit_key, num(l.value)]));
    const featOv = new Map(overrides.filter(o => o.kind === 'feature').map(o => [o.key, o.value === true]));
    const limitOv = new Map(overrides.filter(o => o.kind === 'limit').map(o => [o.key, o.value === null ? null : Number(o.value)]));
    const month = monthPeriod(tenant.timezone);

    const limits: Entitlements['limits'] = [];
    for (const l of limitCat) {
      const planValue = planLimit.has(l.key) ? planLimit.get(l.key)! : 0;
      const override = limitOv.has(l.key) ? limitOv.get(l.key)! : undefined;
      let used = 0;
      if (l.meter === 'live_count') used = await countLive(db, l.key, tenantId);
      else {
        const period = l.meter === 'monthly' ? month : 'lifetime';
        used = Number(meters.find(m => m.limit_key === l.key && m.period === period)?.used ?? 0);
        // storage_gb meter counts bytes (0006); report GB with 2 decimals to match the limit's unit.
        if (l.key === 'storage_gb') used = Math.round((used / 1073741824) * 100) / 100;
      }
      limits.push({
        key: l.key, name: l.name, unit: l.unit, meter: l.meter, featureKey: l.feature_key, planValue, override,
        effective: override !== undefined ? override : planValue, used,
      });
    }

    return {
      planId: sub?.plan_id ?? null,
      planName: sub?.name ?? null,
      subscriptionStatus: (sub?.status as Entitlements['subscriptionStatus']) ?? null,
      features: featCat.map(f => {
        const ov = featOv.get(f.key);
        return {
          key: f.key, name: f.name,
          enabled: ov !== undefined ? ov : inPlan.has(f.key),
          source: ov !== undefined ? ('override' as const) : inPlan.has(f.key) ? ('plan' as const) : ('none' as const),
        };
      }),
      limits,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from './db.service';
import { RedisService } from './redis.service';

/** Redis counter bumped on every permission input change (ADR-0005). Effective permissions are cached per value. */
export const PERMVER_KEY = (tenantId: string) => `permver:${tenantId}`;

export interface TenantState {
  tenantId: string;
  code: string;
  name: string;
  status: 'active' | 'suspended' | 'archived';
  subscriptionStatus: 'trial' | 'active' | 'grace' | 'expired' | 'suspended' | null;
  timezone: string;
  features: string[];
}

/**
 * Cached view of a tenant's state and effective features (plan ∩/∪ overrides).
 * Any write to plans, overrides, subscriptions or tenant status MUST call invalidate(tenantId)
 * (or invalidateAll() for plan edits). TTL is a safety net, not the mechanism.
 */
@Injectable()
export class EntitlementsService {
  private static readonly TTL = 300;
  constructor(private readonly db: DbService, private readonly redis: RedisService) {}

  async state(tenantId: string): Promise<TenantState | null> {
    const key = `tenant-state:${tenantId}`;
    const cached = await this.redis.getJson<TenantState>(key);
    if (cached) return cached;
    const t = await this.db.platform
      .selectFrom('platform.tenant as t')
      .leftJoin('platform.subscription as s', join => join.onRef('s.tenant_id', '=', 't.id').on('s.effective_to', 'is', null))
      .select(['t.id', 't.code', 't.name', 't.status', 't.timezone', 's.status as sub_status'])
      .where('t.id', '=', tenantId)
      .executeTakeFirst();
    if (!t) return null;
    const feats = await sql<{ feature_key: string }>`select feature_key from platform.effective_features(${tenantId}::uuid)`.execute(this.db.platform);
    const state: TenantState = {
      tenantId: t.id, code: t.code, name: t.name, status: t.status, timezone: t.timezone,
      subscriptionStatus: (t.sub_status as TenantState['subscriptionStatus']) ?? null,
      features: feats.rows.map(r => r.feature_key).sort(),
    };
    await this.redis.setJson(key, state, EntitlementsService.TTL);
    return state;
  }

  async hasFeature(tenantId: string, feature: string): Promise<boolean> {
    return (await this.state(tenantId))?.features.includes(feature) ?? false;
  }

  async invalidate(tenantId: string) {
    await this.redis.del(`tenant-state:${tenantId}`);
    await this.bumpPermissions(tenantId);
  }

  async invalidateAll() {
    const keys = await this.redis.client.keys('tenant-state:*');
    await this.redis.del(...keys);
    // Plan edits can change any tenant's visible permission keys.
    const tenants = await this.db.platform.selectFrom('platform.tenant').select('id').execute();
    if (tenants.length) {
      const multi = this.redis.client.multi();
      for (const t of tenants) multi.incr(PERMVER_KEY(t.id));
      await multi.exec();
    }
  }

  /** Makes every cached effective-permission set of the tenant stale (`INCR permver:<tenant>`). */
  async bumpPermissions(tenantId: string): Promise<number> {
    return this.redis.client.incr(PERMVER_KEY(tenantId));
  }
}

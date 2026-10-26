import { Injectable } from '@nestjs/common';
import { EntitlementsService, PERMVER_KEY } from '../../core/entitlements.service';
import { RedisService } from '../../core/redis.service';
import type { ResolvedPermissions } from './compiler';

/**
 * Effective-permission cache: `perm:<tenant>:<user>:<permver>` (10 min). Any permission input change calls
 * `bump(tenantId)` (Redis INCR permver:<tenant>), so the very next request recompiles. Old entries just expire.
 */
@Injectable()
export class PermissionCache {
  static readonly TTL = 600;
  constructor(private readonly redis: RedisService, private readonly ent: EntitlementsService) {}

  async version(tenantId: string): Promise<number> {
    const v = await this.redis.client.get(PERMVER_KEY(tenantId));
    return v ? Number(v) : 0;
  }

  key(tenantId: string, userId: string, version: number) {
    return `perm:${tenantId}:${userId}:${version}`;
  }

  get(tenantId: string, userId: string, version: number) {
    return this.redis.getJson<ResolvedPermissions>(this.key(tenantId, userId, version));
  }

  set(tenantId: string, userId: string, version: number, value: ResolvedPermissions) {
    return this.redis.setJson(this.key(tenantId, userId, version), value, PermissionCache.TTL);
  }

  /** Call after the transaction that changed a permission input has committed. */
  async bump(tenantId: string): Promise<number> {
    return this.ent.bumpPermissions(tenantId);
  }
}

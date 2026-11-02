import { Injectable } from '@nestjs/common';
import { EntitlementsService } from '../../core/entitlements.service';
import type { ResolvedPermissions } from './compiler';

/**
 * Effective-permission cache: in-process Map keyed by `perm:<tenant>:<user>:<permver>`.
 *
 * Why in-memory instead of Redis?
 *  - Single-pod deployment (Render free tier): no cross-pod invalidation needed.
 *  - Saves 2–3 Redis commands per authenticated request (was: GET permver + GET perm + SET perm).
 *  - Permission version is now a local counter per tenant; bump() increments it so the next
 *    request recompiles (old Map entries are unreachable and GC'd naturally).
 *  - TTL is enforced via a timestamp; entries older than TTL_MS are recompiled even without a bump.
 *
 * If you ever run multiple API pods, switch back to Redis by reverting this file.
 */
@Injectable()
export class PermissionCache {
  static readonly TTL_MS = 10 * 60 * 1000; // 10 minutes

  private readonly versions = new Map<string, number>();           // tenantId → version counter
  private readonly store = new Map<string, { value: ResolvedPermissions; expiresAt: number }>();

  constructor(private readonly ent: EntitlementsService) {}

  version(tenantId: string): number {
    return this.versions.get(tenantId) ?? 0;
  }

  key(tenantId: string, userId: string, version: number) {
    return `${tenantId}:${userId}:${version}`;
  }

  get(tenantId: string, userId: string, version: number): ResolvedPermissions | null {
    const entry = this.store.get(this.key(tenantId, userId, version));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(this.key(tenantId, userId, version));
      return null;
    }
    return entry.value;
  }

  set(tenantId: string, userId: string, version: number, value: ResolvedPermissions): void {
    this.store.set(this.key(tenantId, userId, version), {
      value,
      expiresAt: Date.now() + PermissionCache.TTL_MS,
    });
  }

  /** Call after the transaction that changed a permission input has committed. */
  async bump(tenantId: string): Promise<number> {
    const next = (this.versions.get(tenantId) ?? 0) + 1;
    this.versions.set(tenantId, next);
    // Also bump in Redis so EntitlementsService.bumpPermissions stays in sync (used by platform ops).
    await this.ent.bumpPermissions(tenantId);
    return next;
  }
}

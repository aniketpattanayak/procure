import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { MyPermissions } from '@procure/schema';

/**
 * Core ↔ permissions-module seam (ADR-0005). Core's AuthGuard enforces @Requires on every route; the permissions
 * module provides the implementation under PERMISSION_RESOLVER. If no resolver is registered every @Requires
 * route is denied (fail closed).
 */
export const PERMISSION_RESOLVER = Symbol('PERMISSION_RESOLVER');

export interface PermissionResolver {
  /** Effective permissions for a tenant user (plan ∩ (roles ∪ allow − deny)); tenant admins get every key in plan. */
  resolve(tenantId: string, userId: string, isTenantAdmin: boolean): Promise<MyPermissions>;
}

export const REQUIRES_ALL = 'auth:requiresAll';
export const REQUIRES_ANY = 'auth:requiresAny';

/** Route needs every listed key. Use `perm.*` helpers or literal keys from the registry. */
export const Requires = (...keys: string[]) => SetMetadata(REQUIRES_ALL, keys);
/** Route needs at least one listed key (e.g. a list endpoint reachable from two tabs). */
export const RequiresAny = (...keys: string[]) => SetMetadata(REQUIRES_ANY, keys);

/** Effective permissions of the caller (set by AuthGuard for tenant principals on every request). */
export const CurrentPermissions = createParamDecorator((_d: unknown, c: ExecutionContext): MyPermissions | undefined =>
  c.switchToHttp().getRequest().permissions);

/**
 * For handlers that check keys computed at runtime (e.g. `master.<key>:action.add` where key comes from the URL):
 * call `assertPermission(perms, key)`.
 */
export function hasPermission(perms: MyPermissions | undefined, key: string): boolean {
  return !!perms && perms.keys.includes(key);
}

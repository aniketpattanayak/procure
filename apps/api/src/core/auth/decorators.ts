import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Principal } from '@procure/schema';

export const IS_PUBLIC = 'auth:public';
export const AUDIENCE = 'auth:audience';
export const PLATFORM_ROLES = 'auth:platformRoles';
export const ALLOW_PENDING_PASSWORD = 'auth:allowPendingPassword';
export const TENANT_ADMIN_ONLY = 'auth:tenantAdmin';
export const REQUIRES_FEATURE = 'auth:feature';

/** No authentication (login, refresh, health, inbound webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Only Super Admin team; optionally restricted to platform roles. */
export const PlatformOnly = (...roles: ('owner' | 'support' | 'billing')[]) => (target: object, key?: string | symbol, desc?: PropertyDescriptor) => {
  SetMetadata(AUDIENCE, 'platform')(target, key as string, desc as PropertyDescriptor);
  if (roles.length) SetMetadata(PLATFORM_ROLES, roles)(target, key as string, desc as PropertyDescriptor);
};
/** Only tenant users (including impersonation sessions). */
export const TenantOnly = () => SetMetadata(AUDIENCE, 'tenant');
/**
 * Phase 1 stand-in for the permission engine: tenant admins only.
 * Phase 2 replaces call sites with @Requires('<registry key>'); tenant admins keep full rights within the plan.
 */
export const TenantAdminOnly = () => SetMetadata(TENANT_ADMIN_ONLY, true);
/** Route reachable while the user still must change their password. */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);
/** Route requires a plan feature for the current tenant (hidden = 404-like FEATURE_NOT_IN_PLAN). */
export const RequiresFeature = (feature: string) => SetMetadata(REQUIRES_FEATURE, feature);

export const CurrentPrincipal = createParamDecorator((_d: unknown, c: ExecutionContext): Principal => c.switchToHttp().getRequest().principal);
export const CurrentSession = createParamDecorator((_d: unknown, c: ExecutionContext): string => c.switchToHttp().getRequest().sessionId);

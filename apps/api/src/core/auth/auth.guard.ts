import { CanActivate, ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode, Principal } from '@procure/schema';
import { DbService } from '../db.service';
import { EntitlementsService } from '../entitlements.service';
import { AppError } from '../errors';
import { RedisService } from '../redis.service';
import { ctx } from '../request-context';
import { ALLOW_PENDING_PASSWORD, AUDIENCE, IS_PUBLIC, PLATFORM_ROLES, REQUIRES_FEATURE, TENANT_ADMIN_ONLY } from './decorators';
import { PERMISSION_RESOLVER, PermissionResolver, REQUIRES_ALL, REQUIRES_ANY } from './permissions';
import { TokenService } from './token.service';

/**
 * Global guard. Order of checks (all server-side, every request):
 *  1 token valid + session not revoked
 *  2 audience (platform vs tenant)
 *  3 tenant active + subscription usable
 *  4 password change pending → only allowed routes
 *  5 plan feature (RequiresFeature)
 *  6 platform role / tenant admin
 *  7 @Requires / @RequiresAny permission keys via the PermissionResolver (fail closed if none registered)
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly redis: RedisService,
    private readonly db: DbService,
    private readonly ent: EntitlementsService,
    @Optional() @Inject(PERMISSION_RESOLVER) private readonly resolver?: PermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Please sign in');
    let claims;
    try {
      claims = await this.tokens.verifyAccess(header.slice(7));
    } catch {
      throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Your session has expired. Please sign in again.');
    }
    if (await this.redis.isRevoked(claims.sid)) throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'This session was signed out');

    const audience = this.reflector.getAllAndOverride<'platform' | 'tenant' | undefined>(AUDIENCE, targets);
    if (audience && audience !== claims.typ) throw AppError.forbidden();

    const principal = await this.loadPrincipal(claims.typ, claims.sub, claims.tid, claims.imp);
    if (!principal) throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Account is no longer active');

    if (principal.kind === 'tenant') {
      const state = await this.ent.state(principal.tenantId);
      if (!state || state.status !== 'active') {
        throw new AppError(403, ErrorCode.TENANT_SUSPENDED, 'This company account is suspended. Contact support.');
      }
      if (state.subscriptionStatus === 'expired' || state.subscriptionStatus === 'suspended' || !state.subscriptionStatus) {
        throw new AppError(403, ErrorCode.SUBSCRIPTION_INACTIVE, 'Your subscription is not active. Contact your administrator.');
      }
      const feature = this.reflector.getAllAndOverride<string | undefined>(REQUIRES_FEATURE, targets);
      if (feature && !state.features.includes(feature)) {
        throw new AppError(404, ErrorCode.FEATURE_NOT_IN_PLAN, 'This feature is not part of your plan');
      }
      if (this.reflector.getAllAndOverride<boolean>(TENANT_ADMIN_ONLY, targets) && !principal.isTenantAdmin) throw AppError.forbidden();
      // Permissions are resolved for every tenant request (cached) so handlers can check runtime keys.
      if (this.resolver) req.permissions = await this.resolver.resolve(principal.tenantId, principal.userId, principal.isTenantAdmin);
      const all = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRES_ALL, targets);
      const any = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRES_ANY, targets);
      if (all || any) {
        const keys: string[] = req.permissions?.keys ?? [];
        if (all && !all.every(k => keys.includes(k))) throw AppError.forbidden();
        if (any && !any.some(k => keys.includes(k))) throw AppError.forbidden();
      }
    } else {
      const roles = this.reflector.getAllAndOverride<string[] | undefined>(PLATFORM_ROLES, targets);
      if (roles && !roles.includes(principal.role)) throw AppError.forbidden();
      if (this.reflector.getAllAndOverride<string[] | undefined>(REQUIRES_ALL, targets)
        || this.reflector.getAllAndOverride<string[] | undefined>(REQUIRES_ANY, targets)) throw AppError.forbidden();
    }

    if (claims.pcv && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, targets)) {
      throw new AppError(403, ErrorCode.PASSWORD_CHANGE_REQUIRED, 'Please change your password to continue');
    }

    req.principal = principal;
    req.sessionId = claims.sid;
    const store = ctx();
    if (store) { store.principal = principal; store.sessionId = claims.sid; }
    return true;
  }

  /** Principal cached 60 s per subject; identity module calls invalidatePrincipal() on user changes. */
  private async loadPrincipal(typ: 'platform' | 'tenant', sub: string, tid?: string, imp?: string): Promise<Principal | null> {
    // SEC8-009: the tenant id is part of the key (a cached principal must never answer for a token naming another tenant).
    const key = `principal:${typ}:${sub}:${tid ?? ''}:${imp ?? ''}`;
    const cached = await this.redis.getJson<Principal>(key);
    if (cached) return cached;
    let p: Principal | null = null;
    if (typ === 'platform') {
      const u = await this.db.platform.selectFrom('platform.platform_user').select(['id', 'name', 'email', 'role', 'is_active'])
        .where('id', '=', sub).executeTakeFirst();
      if (u?.is_active) p = { kind: 'platform', userId: u.id, name: u.name, email: u.email, role: u.role };
    } else if (tid) {
      const state = await this.ent.state(tid);
      const u = await this.db.tenantTx(tid, tx => tx.selectFrom('app.tenant_user')
        .select(['id', 'name', 'email', 'is_tenant_admin', 'is_active', 'is_deleted']).where('id', '=', sub).executeTakeFirst());
      let impersonator: { userId: string; name: string } | undefined;
      if (imp) {
        const pu = await this.db.platform.selectFrom('platform.platform_user').select(['id', 'name', 'is_active']).where('id', '=', imp).executeTakeFirst();
        // SEC8-005: an impersonation token dies with its platform user (refresh already checked this; requests did not).
        if (!pu?.is_active) return null;
        impersonator = { userId: pu.id, name: pu.name };
      }
      if (state && u?.is_active && !u.is_deleted) {
        p = {
          kind: 'tenant', userId: u.id, tenantId: tid, tenantCode: state.code, tenantName: state.name,
          name: u.name, email: u.email, isTenantAdmin: u.is_tenant_admin, impersonatedBy: impersonator,
        };
      }
    }
    if (p) await this.redis.setJson(key, p, 60);
    return p;
  }
}

export async function invalidatePrincipal(redis: RedisService, typ: 'platform' | 'tenant', userId: string) {
  const keys = await redis.client.keys(`principal:${typ}:${userId}:*`);
  await redis.del(...keys);
}

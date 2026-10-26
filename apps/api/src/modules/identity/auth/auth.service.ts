import { Injectable } from '@nestjs/common';
import { AuthResult, ErrorCode, Principal, SettingsRegistry } from '@procure/schema';
import { invalidatePrincipal } from '../../../core/auth/auth.guard';
import { TokenService } from '../../../core/auth/token.service';
import { AuditService } from '../../../core/audit.service';
import { config } from '../../../core/config';
import { DbService } from '../../../core/db.service';
import { EntitlementsService } from '../../../core/entitlements.service';
import { AppError } from '../../../core/errors';
import { RedisService } from '../../../core/redis.service';
import { createHash } from 'node:crypto';
import { dummyVerify, hashPassword, verifyPassword } from '../passwords';
import { getTenantSetting } from '../settings';
import { IssuedSession, SessionsService } from './sessions.service';

export interface LoginOutcome {
  result: AuthResult;
  session: IssuedSession;
}

const invalidCredentials = () =>
  new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'The company code, email or password is not correct.');
const invalidPlatformCredentials = () => new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'The email or password is not correct.');
const locked = (until: Date) =>
  new AppError(423, ErrorCode.ACCOUNT_LOCKED, `Too many failed sign-in attempts. Try again after ${until.toISOString()} or ask your administrator to unlock your account.`, {
    lockedUntil: until.toISOString(),
  });

const PLATFORM_MAX_FAILED = 5;
const PLATFORM_LOCK_MINUTES = 15;

type FailOutcome = { kind: 'invalid' } | { kind: 'locked'; until: Date };

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly ent: EntitlementsService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Per-account login throttle (QA-BUG-006): counts every attempt for one account, whatever the source IP.
   * Fails open if Redis is unavailable so an outage does not lock everyone out.
   */
  private async throttleAccount(account: string): Promise<void> {
    if (!config.rateLimit.enabled) return;
    const key = `rl:acct:${createHash('sha256').update(account).digest('hex')}`;
    const n = await this.redis.hit(key, 60).catch(() => 0);
    if (n > config.rateLimit.loginPerAccount) {
      throw new AppError(429, ErrorCode.RATE_LIMITED, 'Too many sign-in attempts for this account. Wait a minute and try again.', { retryAfterSec: 60 });
    }
  }

  // ---------------------------------------------------------------- tenant login
  async tenantLogin(tenantCode: string, email: string, password: string): Promise<LoginOutcome> {
    await this.throttleAccount(`tenant:${tenantCode.toLowerCase()}:${email.toLowerCase()}`);
    const tenant = await this.db.platform.selectFrom('platform.tenant').select(['id', 'code', 'name', 'status'])
      .where('code', '=', tenantCode).executeTakeFirst();
    if (!tenant) {
      await dummyVerify(password);
      throw invalidCredentials();
    }

    const user = await this.db.tenantTx(tenant.id, async tx => {
      const u = await tx.selectFrom('app.tenant_user')
        .select(['id', 'name', 'email', 'password_hash', 'is_tenant_admin', 'is_active', 'is_deleted', 'must_change_password', 'failed_logins', 'locked_until'])
        .where('email', '=', email).executeTakeFirst();
      const maxFailed = await getTenantSetting(tx, 'security.max_failed_logins');
      const lockMinutes = await getTenantSetting(tx, 'security.lockout_minutes');
      const sessionDays = await getTenantSetting(tx, 'security.session_days');
      return { u, maxFailed, lockMinutes, sessionDays };
    });
    const u = user.u;
    if (!u || !u.is_active || u.is_deleted) {
      await dummyVerify(password);
      if (u) await this.tenantAuditOnly(tenant.id, u.id, 'login_failed', { email, reason: 'inactive' });
      throw invalidCredentials();
    }
    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      await dummyVerify(password);
      throw locked(new Date(u.locked_until));
    }

    const ok = await verifyPassword(u.password_hash, password);
    if (!ok) {
      const outcome = await this.db.tenantTx(tenant.id, async (tx): Promise<FailOutcome> => {
        // A lock that has expired starts a fresh count.
        const row = await tx.updateTable('app.tenant_user')
          .set(eb => ({
            failed_logins: eb.case().when('locked_until', 'is not', null).then(1).else(eb('failed_logins', '+', 1)).end(),
            locked_until: null,
          }))
          .where('id', '=', u.id).returning('failed_logins').executeTakeFirstOrThrow();
        await this.audit.tenant(tx, { action: 'login_failed', entity: 'user', entityId: u.id, actorId: u.id, after: { email, failedLogins: row.failed_logins } });
        if (row.failed_logins >= user.maxFailed) {
          const until = new Date(Date.now() + user.lockMinutes * 60_000);
          await tx.updateTable('app.tenant_user').set({ locked_until: until, failed_logins: 0 }).where('id', '=', u.id).execute();
          await this.audit.tenant(tx, { action: 'locked', entity: 'user', entityId: u.id, actorId: u.id, after: { lockedUntil: until.toISOString() } });
          return { kind: 'locked', until };
        }
        return { kind: 'invalid' };
      });
      if (outcome.kind === 'locked') {
        await invalidatePrincipal(this.redis, 'tenant', u.id);
        throw locked(outcome.until);
      }
      throw invalidCredentials();
    }

    // Password is right: now it is fine to say the company account is unusable.
    const state = await this.ent.state(tenant.id);
    if (!state || state.status !== 'active') {
      throw new AppError(403, ErrorCode.TENANT_SUSPENDED, 'This company account is suspended. Contact support.');
    }
    if (!state.subscriptionStatus || state.subscriptionStatus === 'expired' || state.subscriptionStatus === 'suspended') {
      throw new AppError(403, ErrorCode.SUBSCRIPTION_INACTIVE, 'Your subscription is not active. Contact your administrator.');
    }

    await this.db.tenantTx(tenant.id, async tx => {
      await tx.updateTable('app.tenant_user').set({ failed_logins: 0, locked_until: null, last_login_at: new Date() }).where('id', '=', u.id).execute();
      await this.audit.tenant(tx, { action: 'login', entity: 'user', entityId: u.id, actorId: u.id });
    });

    const session = await this.sessions.create({
      subjectType: 'tenant', subjectId: u.id, tenantId: tenant.id,
      expiresAt: new Date(Date.now() + user.sessionDays * 86_400_000),
    });
    const principal: Principal = {
      kind: 'tenant', userId: u.id, tenantId: tenant.id, tenantCode: tenant.code, tenantName: tenant.name,
      name: u.name, email: u.email, isTenantAdmin: u.is_tenant_admin,
    };
    return { session, result: await this.authResult(principal, session.id, u.must_change_password) };
  }

  // ---------------------------------------------------------------- platform login
  async platformLogin(email: string, password: string): Promise<LoginOutcome> {
    await this.throttleAccount(`platform:${email.toLowerCase()}`);
    const u = await this.db.platform.selectFrom('platform.platform_user')
      .select(['id', 'name', 'email', 'role', 'password_hash', 'is_active', 'must_change_password', 'locked_until'])
      .where('email', '=', email).executeTakeFirst();
    if (!u || !u.is_active) {
      await dummyVerify(password);
      throw invalidPlatformCredentials();
    }
    if (u.locked_until && new Date(u.locked_until).getTime() > Date.now()) {
      await dummyVerify(password);
      throw locked(new Date(u.locked_until));
    }
    const ok = await verifyPassword(u.password_hash, password);
    if (!ok) {
      const outcome = await this.db.platformTx(async (tx): Promise<FailOutcome> => {
        const row = await tx.updateTable('platform.platform_user')
          .set(eb => ({
            failed_logins: eb.case().when('locked_until', 'is not', null).then(1).else(eb('failed_logins', '+', 1)).end(),
            locked_until: null,
          }))
          .where('id', '=', u.id).returning('failed_logins').executeTakeFirstOrThrow();
        await this.audit.platform(tx, { action: 'login_failed', entity: 'platform_user', entityId: u.id, actorId: u.id, after: { email, failedLogins: row.failed_logins } });
        if (row.failed_logins >= PLATFORM_MAX_FAILED) {
          const until = new Date(Date.now() + PLATFORM_LOCK_MINUTES * 60_000);
          await tx.updateTable('platform.platform_user').set({ locked_until: until, failed_logins: 0 }).where('id', '=', u.id).execute();
          await this.audit.platform(tx, { action: 'locked', entity: 'platform_user', entityId: u.id, actorId: u.id, after: { lockedUntil: until.toISOString() } });
          return { kind: 'locked', until };
        }
        return { kind: 'invalid' };
      });
      if (outcome.kind === 'locked') throw locked(outcome.until);
      throw invalidPlatformCredentials();
    }
    await this.db.platformTx(async tx => {
      await tx.updateTable('platform.platform_user').set({ failed_logins: 0, locked_until: null, last_login_at: new Date() }).where('id', '=', u.id).execute();
      await this.audit.platform(tx, { action: 'login', entity: 'platform_user', entityId: u.id, actorId: u.id });
    });
    const session = await this.sessions.create({
      subjectType: 'platform', subjectId: u.id, tenantId: null,
      expiresAt: new Date(Date.now() + SettingsRegistry['security.session_days'].default * 86_400_000),
    });
    const principal: Principal = { kind: 'platform', userId: u.id, name: u.name, email: u.email, role: u.role };
    return { session, result: await this.authResult(principal, session.id, u.must_change_password) };
  }

  // ---------------------------------------------------------------- refresh
  async refresh(refreshToken: string | undefined): Promise<LoginOutcome> {
    const expired = () => new AppError(401, ErrorCode.UNAUTHENTICATED, 'Your session has ended. Please sign in again.');
    if (!refreshToken) throw expired();
    const r = await this.sessions.rotate(refreshToken);
    if (!r.ok) {
      if (r.reason === 'reused') {
        throw new AppError(401, ErrorCode.REFRESH_REUSED, 'This sign-in was used from somewhere else, so we signed it out everywhere for safety. Please sign in again.');
      }
      throw expired();
    }
    const fail = async () => {
      await this.sessions.revokeSession(r.session.id, 'subject_inactive');
      return expired();
    };

    if (r.subjectType === 'platform') {
      const u = await this.db.platform.selectFrom('platform.platform_user')
        .select(['id', 'name', 'email', 'role', 'is_active', 'must_change_password']).where('id', '=', r.subjectId).executeTakeFirst();
      if (!u?.is_active) throw await fail();
      const principal: Principal = { kind: 'platform', userId: u.id, name: u.name, email: u.email, role: u.role };
      return { session: r.session, result: await this.authResult(principal, r.session.id, u.must_change_password) };
    }

    const tenantId = r.tenantId!;
    const state = await this.ent.state(tenantId);
    if (!state || state.status !== 'active') throw await fail();
    const u = await this.db.tenantTx(tenantId, tx => tx.selectFrom('app.tenant_user')
      .select(['id', 'name', 'email', 'is_tenant_admin', 'is_active', 'is_deleted', 'must_change_password'])
      .where('id', '=', r.subjectId).executeTakeFirst());
    if (!u || !u.is_active || u.is_deleted) throw await fail();
    let impersonatedBy: { userId: string; name: string } | undefined;
    if (r.impersonatedBy) {
      const pu = await this.db.platform.selectFrom('platform.platform_user').select(['id', 'name', 'is_active']).where('id', '=', r.impersonatedBy).executeTakeFirst();
      if (!pu?.is_active) throw await fail();
      impersonatedBy = { userId: pu.id, name: pu.name };
    }
    const principal: Principal = {
      kind: 'tenant', userId: u.id, tenantId, tenantCode: state.code, tenantName: state.name,
      name: u.name, email: u.email, isTenantAdmin: u.is_tenant_admin, impersonatedBy,
    };
    return { session: r.session, result: await this.authResult(principal, r.session.id, impersonatedBy ? false : u.must_change_password) };
  }

  // ---------------------------------------------------------------- logout / me / password
  async logout(principal: Principal, sessionId: string): Promise<void> {
    await this.sessions.revokeSession(sessionId, 'logout');
    await this.auditAs(principal, { action: 'logout', entity: 'session', entityId: sessionId });
  }

  /** /auth/me extras (Phase 2): tenant label overrides for the user's language + non-sensitive settings. */
  async meExtras(tenantId: string, lang = 'en'): Promise<{ labels: Record<string, string>; settings: Record<string, unknown> }> {
    return this.db.tenantTx(tenantId, async tx => {
      const row = await tx.selectFrom('app.tenant_setting').select('value').where('key', '=', `labels.${lang}`).executeTakeFirst();
      const labels: Record<string, string> = {};
      if (row?.value && typeof row.value === 'object' && !Array.isArray(row.value)) {
        for (const [k, v] of Object.entries(row.value as Record<string, unknown>)) if (typeof v === 'string') labels[k] = v;
      }
      const settings: Record<string, unknown> = { 'labels.location_levels': await getTenantSetting(tx, 'labels.location_levels') };
      for (const key of Object.keys(SettingsRegistry) as (keyof typeof SettingsRegistry)[]) {
        if (key.startsWith('flow.') || key === 'selection.max_over_approval_pct' || key === 'grn.over_receipt_pct') settings[key] = await getTenantSetting(tx, key);
      }
      // Tenant profile values the UI formats with (currency symbol/grouping, "today" in tenant time).
      const tenant = await this.db.platform.selectFrom('platform.tenant').select(['currency', 'timezone', 'fy_start_month'])
        .where('id', '=', tenantId).executeTakeFirst();
      if (tenant) {
        settings['tenant.currency'] = tenant.currency;
        settings['tenant.timezone'] = tenant.timezone;
        settings['tenant.fy_start_month'] = tenant.fy_start_month;
      }
      return { labels, settings };
    });
  }


  async tenantLogoUrl(tenantId: string): Promise<string | null> {
    const row = await this.db.platform.selectFrom('platform.tenant').select('logo_url').where('id', '=', tenantId).executeTakeFirst();
    return row?.logo_url ?? null;
  }

  async mustChangePassword(principal: Principal): Promise<boolean> {
    if (principal.kind === 'platform') {
      const u = await this.db.platform.selectFrom('platform.platform_user').select('must_change_password').where('id', '=', principal.userId).executeTakeFirst();
      return u?.must_change_password ?? false;
    }
    if (principal.impersonatedBy) return false;
    const u = await this.db.tenantTx(principal.tenantId, tx =>
      tx.selectFrom('app.tenant_user').select('must_change_password').where('id', '=', principal.userId).executeTakeFirst());
    return u?.must_change_password ?? false;
  }

  async changePassword(principal: Principal, sessionId: string, currentPassword: string, newPassword: string): Promise<AuthResult> {
    const wrong = () => new AppError(400, ErrorCode.VALIDATION, 'Your current password is not correct.', undefined, [
      { path: 'currentPassword', message: 'Current password is not correct' },
    ]);
    if (principal.kind === 'tenant' && principal.impersonatedBy) {
      throw AppError.forbidden('You cannot change this user\'s password while impersonating. Use the admin password reset instead.');
    }
    if (principal.kind === 'platform') {
      const u = await this.db.platform.selectFrom('platform.platform_user').select('password_hash').where('id', '=', principal.userId).executeTakeFirstOrThrow();
      if (!(await verifyPassword(u.password_hash, currentPassword))) throw wrong();
      const h = await hashPassword(newPassword);
      await this.db.platformTx(async tx => {
        await tx.updateTable('platform.platform_user').set({ password_hash: h, must_change_password: false }).where('id', '=', principal.userId).execute();
        await this.audit.platform(tx, { action: 'password_changed', entity: 'platform_user', entityId: principal.userId });
      });
    } else {
      const { u, minLen } = await this.db.tenantTx(principal.tenantId, async tx => ({
        u: await tx.selectFrom('app.tenant_user').select('password_hash').where('id', '=', principal.userId).executeTakeFirstOrThrow(),
        minLen: await getTenantSetting(tx, 'security.password_min_length'),
      }));
      if (!(await verifyPassword(u.password_hash, currentPassword))) throw wrong();
      if (newPassword.length < minLen) {
        throw new AppError(400, ErrorCode.VALIDATION, `Your company requires passwords of at least ${minLen} characters.`, undefined, [
          { path: 'newPassword', message: `At least ${minLen} characters` },
        ]);
      }
      const h = await hashPassword(newPassword);
      await this.db.tenantTx(principal.tenantId, async tx => {
        await tx.updateTable('app.tenant_user')
          .set({ password_hash: h, must_change_password: false, password_changed_at: new Date(), failed_logins: 0, locked_until: null, updated_by: principal.userId })
          .where('id', '=', principal.userId).execute();
        await this.audit.tenant(tx, { action: 'password_changed', entity: 'user', entityId: principal.userId });
      });
    }
    await this.sessions.revokeSubject(principal.kind, principal.userId, 'password_changed', sessionId);
    await invalidatePrincipal(this.redis, principal.kind, principal.userId);
    return this.authResult(principal, sessionId, false);
  }

  // ---------------------------------------------------------------- helpers
  /** Builds the AuthResult and signs the access token for a session. */
  async authResult(principal: Principal, sessionId: string, mustChangePassword: boolean): Promise<AuthResult> {
    const accessToken = await this.tokens.signAccess({
      sub: principal.userId,
      typ: principal.kind,
      sid: sessionId,
      ...(principal.kind === 'tenant' ? { tid: principal.tenantId } : {}),
      ...(principal.kind === 'tenant' && principal.impersonatedBy ? { imp: principal.impersonatedBy.userId } : {}),
      ...(mustChangePassword ? { pcv: true } : {}),
    });
    return { accessToken, expiresIn: config.accessTtlSec, mustChangePassword, principal };
  }

  /** Audit on the log that belongs to the principal (tenant log for tenant users, platform log otherwise). */
  private async auditAs(principal: Principal, e: { action: string; entity: string; entityId: string }) {
    if (principal.kind === 'tenant') await this.db.tenantTx(principal.tenantId, tx => this.audit.tenant(tx, e));
    else await this.db.platformTx(tx => this.audit.platform(tx, e));
  }

  private tenantAuditOnly(tenantId: string, userId: string, action: string, after: unknown) {
    return this.db.tenantTx(tenantId, tx => this.audit.tenant(tx, { action, entity: 'user', entityId: userId, actorId: userId, after }));
  }

  /** Revoke one of the caller's own sessions. */
  async revokeOwnSession(principal: Principal, sessionId: string): Promise<void> {
    const s = await this.sessions.findOwned(sessionId, principal.kind, principal.userId);
    if (!s) throw AppError.notFound('Session');
    await this.sessions.revokeSession(sessionId, 'revoked_by_user');
    await this.auditAs(principal, { action: 'session_revoked', entity: 'session', entityId: sessionId });
  }
}

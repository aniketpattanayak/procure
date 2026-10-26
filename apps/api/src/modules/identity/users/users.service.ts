import { Inject, Injectable, Optional } from '@nestjs/common';
import { ErrorCode, ListQuery, MyPermissions, UserCreate, UserRow, UserUpdate } from '@procure/schema';
import { sql } from 'kysely';
import { z } from 'zod';
import { invalidatePrincipal } from '../../../core/auth/auth.guard';
import { AuditService } from '../../../core/audit.service';
import { DbService, Tx } from '../../../core/db.service';
import { EntitlementsService } from '../../../core/entitlements.service';
import { AppError } from '../../../core/errors';
import { RedisService } from '../../../core/redis.service';
import { tenantPrincipal } from '../../../core/request-context';
import { SessionsService } from '../auth/sessions.service';
import { decodeCursor, likePattern, toIso, toPage } from '../pagination';
import { generateTempPassword, hashPassword } from '../passwords';
import { countLive } from '../tenant-entitlements.service';
import { UserFieldsService } from '../../forms';
import { assertAdminFlagChange, ROLE_ASSIGNMENT_GUARD, RoleAssignmentGuard } from '../role-assignment';

/** User form custom fields (contract: POST/PUT /users accept `custom`, validated against the `user` form). */
const Custom = z.record(z.string(), z.unknown());
export const UserCreateWithCustom = UserCreate.extend({ custom: Custom.optional() });
export const UserUpdateWithCustom = UserUpdate.extend({ custom: Custom.optional() });
export type UserRowWithCustom = UserRow & { custom: Record<string, unknown> };

export const UserListQuery = ListQuery.extend({
  /** Status view (contract Phase 2): needs admin.users:view.<view>. Default = first permitted view. */
  view: z.enum(['active', 'inactive']).optional(),
  /** Phase 1 alias: active=true → view=active, active=false → view=inactive. */
  active: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
});

const USER_VIEWS = ['active', 'inactive'] as const;

/** Resolves the users list view against the caller's view keys (403 for a view they lack). */
export function resolveUserView(q: { view?: 'active' | 'inactive'; active?: boolean }, perms: MyPermissions | undefined): 'active' | 'inactive' {
  const keys = perms?.keys ?? [];
  const asked = q.view ?? (q.active === undefined ? undefined : q.active ? 'active' : 'inactive');
  const permitted = USER_VIEWS.filter(v => keys.includes(`admin.users:view.${v}`));
  if (asked) {
    if (!permitted.includes(asked)) throw AppError.forbidden(`You do not have access to the ${asked} users view`);
    return asked;
  }
  if (!permitted.length) throw AppError.forbidden('You do not have access to any users view');
  return permitted[0]!;
}

const USER_COLS = ['id', 'name', 'email', 'phone', 'is_tenant_admin', 'is_active', 'locked_until', 'last_login_at', 'version', 'created_at'] as const;
type UserBase = {
  id: string; name: string; email: string; phone: string | null; is_tenant_admin: boolean; is_active: boolean;
  locked_until: Date | null; last_login_at: Date | null; version: number; created_at: Date;
};

/**
 * Enforces a live-count limit inside the caller's tenant transaction.
 * Takes the per-tenant advisory lock first so concurrent creations serialise, then counts live.
 * Returns the usage before and after the change for threshold notifications.
 */
export async function enforceLiveLimit(tx: Tx, key: string, tenantId: string, label: string, adding = 1) {
  const r = await sql<{ lim: string | null }>`select app.lock_tenant_for_limit(${key}) as lim`.execute(tx);
  const lim = r.rows[0]?.lim;
  const limit = lim === null || lim === undefined ? null : Number(lim);
  const used = await countLive(tx, key, tenantId);
  if (limit !== null && used + adding > limit) throw AppError.limitExceeded(key, limit, used, label);
  return { limit, before: used, after: used + adding };
}

/** Notifies every active tenant admin when usage newly crosses 80% or reaches 100% of a limit. */
export async function notifyLimitCrossing(tx: Tx, key: string, label: string, u: { limit: number | null; before: number; after: number }) {
  const { limit, before, after } = u;
  if (limit === null || limit <= 0) return;
  const crossed100 = before < limit && after >= limit;
  const crossed80 = before * 100 < limit * 80 && after * 100 >= limit * 80;
  const level = crossed100 ? 100 : crossed80 ? 80 : null;
  if (!level) return;
  const admins = await tx.selectFrom('app.tenant_user').select('id')
    .where('is_tenant_admin', '=', true).where('is_active', '=', true).where('is_deleted', '=', false).execute();
  if (!admins.length) return;
  const title = level === 100
    ? `You have reached your plan limit of ${limit} ${label}`
    : `You are using ${after} of ${limit} ${label} (${Math.floor((after * 100) / limit)}%)`;
  const body = level === 100
    ? `No more ${label} can be added until you free up capacity or upgrade your plan.`
    : `You are close to your plan limit of ${limit} ${label}. Consider upgrading your plan.`;
  await tx.insertInto('app.notification').values(admins.map(a => ({
    user_id: a.id, kind: 'limit_warning', title, body, link: '/usage',
    data: JSON.stringify({ limitKey: key, threshold: level, limit, used: after }),
  }))).execute();
}

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly sessions: SessionsService,
    private readonly ent: EntitlementsService,
    private readonly userFields: UserFieldsService,
    @Optional() @Inject(ROLE_ASSIGNMENT_GUARD) private readonly roleGuard?: RoleAssignmentGuard,
  ) {}

  /** QA2-BUG-001: admin flag + roleIds go through the same no-escalation rules as PUT /users/:id/roles. */
  private async guardAccess(tx: Tx, targetUserId: string | null, curAdmin: boolean, wantAdmin: boolean | undefined, curRoles: string[], wantRoles: string[] | undefined, perms?: MyPermissions) {
    const p = tenantPrincipal();
    const caller = { userId: p.userId, isTenantAdmin: p.isTenantAdmin, perms };
    assertAdminFlagChange(caller, targetUserId, curAdmin, wantAdmin);
    if (wantRoles === undefined) return;
    const same = new Set(wantRoles).size === new Set(curRoles).size && wantRoles.every(r => curRoles.includes(r));
    if (same || caller.isTenantAdmin) return;
    if (!this.roleGuard) throw AppError.forbidden('Only an administrator can change roles.'); // fail closed
    await this.roleGuard.assertCanAssign(tx, p.tenantId, caller, targetUserId, curRoles, wantRoles);
  }

  async list(q: z.infer<typeof UserListQuery>, perms?: MyPermissions) {
    const p = tenantPrincipal();
    const cur = decodeCursor(q.cursor);
    const view = resolveUserView(q, perms);
    return this.db.tenantTx(p.tenantId, async tx => {
      let qb = tx.selectFrom('app.tenant_user').select([...USER_COLS]).where('is_deleted', '=', false);
      qb = qb.where('is_active', '=', view === 'active');
      if (q.q) {
        const pat = likePattern(q.q);
        qb = qb.where(eb => eb.or([eb('name', 'ilike', pat), eb('email', 'ilike', pat)]));
      }
      if (cur) {
        qb = qb.where(eb => eb.or([
          eb('created_at', '<', new Date(cur.t)),
          eb.and([eb('created_at', '=', new Date(cur.t)), eb('id', '<', cur.id)]),
        ]));
      }
      const rows = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.limit + 1).execute();
      const page = toPage(rows, q.limit, r => ({ t: r.created_at, id: r.id }), r => r);
      const roles = await this.rolesFor(tx, page.data.map(r => r.id));
      return { data: page.data.map(r => toRow(r, roles.get(r.id) ?? [])), nextCursor: page.nextCursor };
    });
  }

  async get(id: string, perms?: MyPermissions): Promise<UserRowWithCustom> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => this.withCustom(tx, await this.load(tx, id), perms));
  }

  /** Adds the user's custom fields (hidden ones removed for the caller). */
  private async withCustom(tx: Tx, row: UserRow, perms?: MyPermissions): Promise<UserRowWithCustom> {
    const r = await tx.selectFrom('app.tenant_user').select('custom').where('id', '=', row.id).executeTakeFirst();
    return { ...row, custom: this.userFields.visibleCustom(perms ?? null, (r?.custom ?? {}) as Record<string, unknown>) };
  }

  async create(input: UserCreate & { custom?: Record<string, unknown> }, perms?: MyPermissions): Promise<{ user: UserRowWithCustom; temporaryPassword: string }> {
    const p = tenantPrincipal();
    const temporaryPassword = generateTempPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const user = await this.db.tenantTx(p.tenantId, async tx => {
      const usage = await enforceLiveLimit(tx, 'max_users', p.tenantId, 'active users');
      const exists = await tx.selectFrom('app.tenant_user').select('id').where('email', '=', input.email).executeTakeFirst();
      if (exists) throw AppError.conflict(`A user with email ${input.email} already exists in your company.`, { field: 'email' });
      await this.checkRefs(tx, input.roleIds, input.reportingManagerId);
      await this.guardAccess(tx, null, false, input.isTenantAdmin, [], input.roleIds, perms);
      const custom = await this.userFields.validate(tx, p.tenantId, perms ?? null, {
        custom: input.custom,
        system: { name: input.name, email: input.email, phone: input.phone ?? null, reporting_manager: input.reportingManagerId ?? null },
      });
      const row = await tx.insertInto('app.tenant_user').values({
        email: input.email, name: input.name, phone: input.phone ?? null, password_hash: passwordHash,
        is_tenant_admin: input.isTenantAdmin, must_change_password: true, reporting_manager_id: input.reportingManagerId ?? null,
        custom: JSON.stringify(custom.custom), created_by: p.userId, updated_by: p.userId,
      }).returning('id').executeTakeFirstOrThrow();
      await this.userFields.finish(tx, p.tenantId, row.id, custom.pending);
      if (input.roleIds.length) {
        await tx.insertInto('app.user_role').values(input.roleIds.map(role_id => ({ user_id: row.id, role_id }))).execute();
      }
      const created = await this.withCustom(tx, await this.load(tx, row.id), perms);
      await this.audit.tenant(tx, { action: 'create', entity: 'user', entityId: row.id, after: created });
      await notifyLimitCrossing(tx, 'max_users', 'active users', usage);
      return created;
    });
    await this.ent.bumpPermissions(p.tenantId);
    return { user, temporaryPassword };
  }

  async update(id: string, input: z.infer<typeof UserUpdate> & { custom?: Record<string, unknown> }, perms?: MyPermissions): Promise<UserRowWithCustom> {
    const p = tenantPrincipal();
    const user = await this.db.tenantTx(p.tenantId, async tx => {
      const before = await this.load(tx, id);
      if (id === p.userId && input.isTenantAdmin === false && before.isTenantAdmin) {
        throw AppError.forbidden('You cannot remove your own administrator rights. Ask another administrator to do it.');
      }
      if (input.reportingManagerId === id) {
        throw new AppError(400, ErrorCode.VALIDATION, 'A user cannot report to themselves.', undefined, [{ path: 'reportingManagerId', message: 'Choose a different person' }]);
      }
      await this.checkRefs(tx, input.roleIds ?? [], input.reportingManagerId);
      await this.guardAccess(tx, id, before.isTenantAdmin, input.isTenantAdmin, before.roles.map(r => r.id), input.roleIds, perms);
      const set: Record<string, unknown> = { updated_by: p.userId };
      if (input.name !== undefined) set.name = input.name;
      if (input.phone !== undefined) set.phone = input.phone;
      if (input.isTenantAdmin !== undefined) set.is_tenant_admin = input.isTenantAdmin;
      if (input.reportingManagerId !== undefined) set.reporting_manager_id = input.reportingManagerId;
      let customPending: Awaited<ReturnType<UserFieldsService['validate']>>['pending'] | null = null;
      if (input.custom !== undefined) {
        const cur = await tx.selectFrom('app.tenant_user').select(['custom', 'name', 'email', 'phone', 'reporting_manager_id'])
          .where('id', '=', id).where('is_deleted', '=', false).executeTakeFirstOrThrow();
        const c = await this.userFields.validate(tx, p.tenantId, perms ?? null, {
          custom: input.custom, prev: (cur.custom ?? {}) as Record<string, unknown>, userId: id,
          system: {
            name: input.name ?? cur.name, email: cur.email, phone: input.phone ?? cur.phone,
            reporting_manager: input.reportingManagerId ?? cur.reporting_manager_id,
          },
        });
        set.custom = JSON.stringify(c.custom);
        customPending = c.pending;
      }
      const res = await tx.updateTable('app.tenant_user').set(set)
        .where('id', '=', id).where('version', '=', input.version).where('is_deleted', '=', false)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw AppError.versionConflict();
      if (input.roleIds) {
        await tx.deleteFrom('app.user_role').where('user_id', '=', id).execute();
        if (input.roleIds.length) await tx.insertInto('app.user_role').values(input.roleIds.map(role_id => ({ user_id: id, role_id }))).execute();
      }
      if (customPending) await this.userFields.finish(tx, p.tenantId, id, customPending);
      const after = await this.withCustom(tx, await this.load(tx, id), perms);
      await this.audit.tenant(tx, { action: 'update', entity: 'user', entityId: id, before, after });
      return after;
    });
    await invalidatePrincipal(this.redis, 'tenant', id);
    await this.ent.bumpPermissions(p.tenantId); // admin flag / roles may have changed
    return user;
  }

  async deactivate(id: string): Promise<UserRow> {
    const p = tenantPrincipal();
    if (id === p.userId) throw AppError.forbidden('You cannot deactivate your own account.');
    const user = await this.db.tenantTx(p.tenantId, async tx => {
      const before = await this.load(tx, id);
      if (!before.isActive) return before;
      await tx.updateTable('app.tenant_user').set({ is_active: false, updated_by: p.userId }).where('id', '=', id).execute();
      const after = await this.load(tx, id);
      await this.audit.tenant(tx, { action: 'deactivate', entity: 'user', entityId: id, before, after });
      return after;
    });
    await this.sessions.revokeSubject('tenant', id, 'user_deactivated');
    await invalidatePrincipal(this.redis, 'tenant', id);
    await this.ent.bumpPermissions(p.tenantId);
    return user;
  }

  async activate(id: string): Promise<UserRow> {
    const p = tenantPrincipal();
    const user = await this.db.tenantTx(p.tenantId, async tx => {
      // Lock order (QA-BUG-002): user row first, then the tenant limit lock. Parallel activates of the same user
      // serialise on the row; the later ones see it active and return without a limit check or audit row.
      // No path takes the limit lock and then a user row lock, so this cannot deadlock with create/deactivate.
      const locked = await tx.selectFrom('app.tenant_user').select('is_active')
        .where('id', '=', id).where('is_deleted', '=', false).forUpdate().executeTakeFirst();
      if (!locked) throw AppError.notFound('User');
      const before = await this.load(tx, id);
      if (locked.is_active) return before;
      const usage = await enforceLiveLimit(tx, 'max_users', p.tenantId, 'active users');
      await tx.updateTable('app.tenant_user').set({ is_active: true, updated_by: p.userId }).where('id', '=', id).execute();
      const after = await this.load(tx, id);
      await this.audit.tenant(tx, { action: 'activate', entity: 'user', entityId: id, before, after });
      await notifyLimitCrossing(tx, 'max_users', 'active users', usage);
      return after;
    });
    await invalidatePrincipal(this.redis, 'tenant', id);
    await this.ent.bumpPermissions(p.tenantId);
    return user;
  }

  async resetPassword(id: string): Promise<{ temporaryPassword: string }> {
    const p = tenantPrincipal();
    const temporaryPassword = generateTempPassword();
    const h = await hashPassword(temporaryPassword);
    await this.db.tenantTx(p.tenantId, async tx => {
      await this.load(tx, id);
      await tx.updateTable('app.tenant_user')
        .set({ password_hash: h, must_change_password: true, failed_logins: 0, locked_until: null, updated_by: p.userId })
        .where('id', '=', id).execute();
      await this.audit.tenant(tx, { action: 'password_reset', entity: 'user', entityId: id });
    });
    await this.sessions.revokeSubject('tenant', id, 'password_reset');
    await invalidatePrincipal(this.redis, 'tenant', id);
    return { temporaryPassword };
  }

  async unlock(id: string): Promise<UserRow> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      const before = await this.load(tx, id);
      await tx.updateTable('app.tenant_user').set({ failed_logins: 0, locked_until: null, updated_by: p.userId }).where('id', '=', id).execute();
      const after = await this.load(tx, id);
      await this.audit.tenant(tx, { action: 'unlock', entity: 'user', entityId: id, before: { lockedUntil: before.lockedUntil }, after: { lockedUntil: null } });
      return after;
    });
  }

  async sessionsOf(id: string) {
    const p = tenantPrincipal();
    await this.db.tenantTx(p.tenantId, tx => this.load(tx, id));
    return this.sessions.list('tenant', id, null, p.tenantId);
  }

  async forceLogout(id: string): Promise<void> {
    const p = tenantPrincipal();
    await this.db.tenantTx(p.tenantId, async tx => {
      await this.load(tx, id);
      await this.audit.tenant(tx, { action: 'force_logout', entity: 'user', entityId: id });
    });
    await this.sessions.revokeSubject('tenant', id, 'force_logout');
    await invalidatePrincipal(this.redis, 'tenant', id);
  }

  // ------------------------------------------------------------------ helpers
  private async load(tx: Tx, id: string): Promise<UserRow> {
    const r = await tx.selectFrom('app.tenant_user').select([...USER_COLS]).where('id', '=', id).where('is_deleted', '=', false).executeTakeFirst();
    if (!r) throw AppError.notFound('User');
    const roles = await this.rolesFor(tx, [id]);
    return toRow(r, roles.get(id) ?? []);
  }

  private async rolesFor(tx: Tx, userIds: string[]) {
    const m = new Map<string, UserRow['roles']>();
    if (!userIds.length) return m;
    const rows = await tx.selectFrom('app.user_role as ur').innerJoin('app.role as r', 'r.id', 'ur.role_id')
      .select(['ur.user_id', 'r.id', 'r.key', 'r.name']).where('ur.user_id', 'in', userIds).where('r.is_deleted', '=', false)
      .orderBy('r.name').execute();
    for (const r of rows) {
      const list = m.get(r.user_id) ?? [];
      list.push({ id: r.id, key: r.key, name: r.name });
      m.set(r.user_id, list);
    }
    return m;
  }

  private async checkRefs(tx: Tx, roleIds: string[], managerId: string | undefined) {
    if (roleIds.length) {
      const found = await tx.selectFrom('app.role').select('id').where('id', 'in', roleIds).where('is_deleted', '=', false).execute();
      if (found.length !== new Set(roleIds).size) {
        throw new AppError(400, ErrorCode.VALIDATION, 'One or more selected roles do not exist.', undefined, [{ path: 'roleIds', message: 'Unknown role' }]);
      }
    }
    if (managerId) {
      const m = await tx.selectFrom('app.tenant_user').select('id').where('id', '=', managerId).where('is_deleted', '=', false).executeTakeFirst();
      if (!m) throw new AppError(400, ErrorCode.VALIDATION, 'The selected reporting manager does not exist.', undefined, [{ path: 'reportingManagerId', message: 'Unknown user' }]);
    }
  }
}

function toRow(r: UserBase, roles: UserRow['roles']): UserRow {
  return {
    id: r.id, name: r.name, email: r.email, phone: r.phone, isTenantAdmin: r.is_tenant_admin, isActive: r.is_active,
    lockedUntil: r.locked_until && new Date(r.locked_until).getTime() > Date.now() ? toIso(r.locked_until) : null,
    lastLoginAt: toIso(r.last_login_at), roles, version: r.version,
  };
}

import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ListQuery, MyPermissions, RoleInput } from '@procure/schema';
import { z } from 'zod';
import { AuditService } from '../../../core/audit.service';
import { TenantOnly } from '../../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../../core/auth/permissions';
import { DbService } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { tenantPrincipal } from '../../../core/request-context';
import { Zod } from '../../../core/zod';
import { decodeCursor, toIso, toPage } from '../pagination';
import { UuidParam } from '../params';
import { TenantEntitlementsService } from '../tenant-entitlements.service';
import { UserCreateWithCustom, UserListQuery, UsersService, UserUpdateWithCustom } from './users.service';

const UserIdParam = new UuidParam('User');

const U = (a: string) => `admin.users:action.${a}`;

@TenantOnly()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Requires(U('view'))
  list(@Query(new Zod(UserListQuery)) q: z.infer<typeof UserListQuery>, @CurrentPermissions() perms: MyPermissions) {
    return this.users.list(q, perms);
  }

  @Post()
  @Requires(U('add'))
  create(@Body(new Zod(UserCreateWithCustom)) body: z.infer<typeof UserCreateWithCustom>, @CurrentPermissions() perms: MyPermissions) {
    return this.users.create(body, perms);
  }

  @Get(':id')
  @Requires(U('view'))
  get(@Param('id', UserIdParam) id: string, @CurrentPermissions() perms: MyPermissions) {
    return this.users.get(id, perms);
  }

  @Put(':id')
  @Requires(U('edit'))
  update(@Param('id', UserIdParam) id: string, @Body(new Zod(UserUpdateWithCustom)) body: z.infer<typeof UserUpdateWithCustom>, @CurrentPermissions() perms: MyPermissions) {
    return this.users.update(id, body, perms);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @Requires(U('deactivate'))
  deactivate(@Param('id', UserIdParam) id: string) {
    return this.users.deactivate(id);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @Requires(U('deactivate'))
  activate(@Param('id', UserIdParam) id: string) {
    return this.users.activate(id);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @Requires(U('reset_password'))
  resetPassword(@Param('id', UserIdParam) id: string) {
    return this.users.resetPassword(id);
  }

  @Post(':id/unlock')
  @HttpCode(200)
  @Requires(U('reset_password'))
  unlock(@Param('id', UserIdParam) id: string) {
    return this.users.unlock(id);
  }

  @Get(':id/sessions')
  @Requires(U('force_logout'))
  sessions(@Param('id', UserIdParam) id: string) {
    return this.users.sessionsOf(id);
  }

  @Post(':id/force-logout')
  @HttpCode(204)
  @Requires(U('force_logout'))
  async forceLogout(@Param('id', UserIdParam) id: string): Promise<void> {
    await this.users.forceLogout(id);
  }
}

@TenantOnly()
@Controller('roles')
export class RolesController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get()
  @Requires('admin.roles:action.view')
  list() {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      const rows = await tx.selectFrom('app.role')
        .select(['id', 'key', 'name', 'description', 'is_system', 'version'])
        .select(eb => eb.selectFrom('app.user_role as ur').innerJoin('app.tenant_user as u', 'u.id', 'ur.user_id')
          .whereRef('ur.role_id', '=', 'app.role.id').where('u.is_deleted', '=', false)
          .select(e => e.fn.countAll<string>().as('n')).as('user_count'))
        .where('is_deleted', '=', false).orderBy('is_system', 'desc').orderBy('name').execute();
      return rows.map(toRole);
    });
  }

  @Post()
  @Requires('admin.roles:action.add')
  create(@Body(new Zod(RoleInput)) body: z.infer<typeof RoleInput>) {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      const exists = await tx.selectFrom('app.role').select('id').where('key', '=', body.key).executeTakeFirst();
      if (exists) throw AppError.conflict(`A role with key "${body.key}" already exists.`, { field: 'key' });
      const row = await tx.insertInto('app.role').values({ key: body.key, name: body.name, description: body.description ?? null })
        .returning(['id', 'key', 'name', 'description', 'is_system', 'version']).executeTakeFirstOrThrow();
      const role = toRole({ ...row, user_count: '0' });
      await this.audit.tenant(tx, { action: 'create', entity: 'role', entityId: row.id, after: role });
      return role;
    });
  }
}

function toRole(r: { id: string; key: string; name: string; description: string | null; is_system: boolean; version: number; user_count: string | null }) {
  return { id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.is_system, version: r.version, userCount: Number(r.user_count ?? 0) };
}

const NotificationQuery = ListQuery.extend({
  unread: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
});

/** Own notifications only (filtered by user id inside the tenant transaction). */
@TenantOnly()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly db: DbService) {}

  @Get()
  list(@Query(new Zod(NotificationQuery)) q: z.infer<typeof NotificationQuery>) {
    const p = tenantPrincipal();
    const cur = decodeCursor(q.cursor);
    return this.db.tenantTx(p.tenantId, async tx => {
      let qb = tx.selectFrom('app.notification').selectAll().where('user_id', '=', p.userId);
      if (q.unread === true) qb = qb.where('read_at', 'is', null);
      if (q.unread === false) qb = qb.where('read_at', 'is not', null);
      if (cur) {
        qb = qb.where(eb => eb.or([
          eb('created_at', '<', new Date(cur.t)),
          eb.and([eb('created_at', '=', new Date(cur.t)), eb('id', '<', cur.id)]),
        ]));
      }
      const rows = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(q.limit + 1).execute();
      return toPage(rows, q.limit, r => ({ t: r.created_at, id: r.id }), r => ({
        id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, data: r.data,
        readAt: toIso(r.read_at), createdAt: toIso(r.created_at)!,
      }));
    });
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@Param('id', new UuidParam('Notification')) id: string): Promise<void> {
    const p = tenantPrincipal();
    await this.db.tenantTx(p.tenantId, async tx => {
      const n = await tx.selectFrom('app.notification').select(['id', 'read_at']).where('id', '=', id).where('user_id', '=', p.userId).executeTakeFirst();
      if (!n) throw AppError.notFound('Notification');
      if (!n.read_at) await tx.updateTable('app.notification').set({ read_at: new Date() }).where('id', '=', id).execute();
    });
  }
}

@TenantOnly()
@Controller('tenant')
export class TenantUsageController {
  constructor(private readonly ent: TenantEntitlementsService) {}

  @Get('usage')
  @Requires('admin.usage:action.view')
  async usage() {
    const p = tenantPrincipal();
    const e = await this.ent.build(p.tenantId);
    if (!e) throw AppError.notFound('Company');
    return e;
  }
}

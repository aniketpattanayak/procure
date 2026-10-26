import { Body, Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import { MyPermissions, PermKey, RoleInput, RoleTabPermissions, ScopeReplace, Uuid, UserTabPermissions } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../core/auth/decorators';
import { CurrentPermissions, Requires, RequiresAny } from '../../core/auth/permissions';
import { AppError } from '../../core/errors';
import { Zod } from '../../core/zod';
import { UuidParam } from '../identity';
import type { ResolvedPermissions } from './compiler';
import { PermissionsAdminService } from './permissions-admin.service';

const RoleId = new UuidParam('Role');
const UserId = new UuidParam('User');
const ROLES_MANAGE = 'admin.roles:action.manage_permissions';
const USERS_MANAGE = 'admin.users:action.manage_permissions';

const RoleUpdate = RoleInput.extend({ version: z.number().int() });
const UserRoles = z.object({ roleIds: z.array(Uuid).max(100) });

/** Tab keys in the URL must at least look like a registry tab key. */
function tabKeyOf(v: string): string {
  if (!PermKey.safeParse(v).success || v.includes(':')) throw AppError.notFound('Permission tab');
  return v;
}

const resolved = (p: MyPermissions | undefined) => p as ResolvedPermissions | undefined;

@TenantOnly()
@Controller()
export class PermissionsController {
  constructor(private readonly svc: PermissionsAdminService) {}

  @Get('permissions/registry')
  @RequiresAny(ROLES_MANAGE, USERS_MANAGE)
  registry() {
    return this.svc.registryTabs();
  }

  // ------------------------------------------------------------------ roles

  @Get('roles/:id/permissions')
  @Requires(ROLES_MANAGE)
  rolePermissions(@Param('id', RoleId) id: string) {
    return this.svc.roleView(id);
  }

  @Put('roles/:id/permissions/tabs/:tabKey')
  @Requires(ROLES_MANAGE)
  putRoleTab(
    @Param('id', RoleId) id: string,
    @Param('tabKey') tabKey: string,
    @Body(new Zod(RoleTabPermissions)) body: z.infer<typeof RoleTabPermissions>,
    @CurrentPermissions() perms?: MyPermissions,
  ) {
    return this.svc.putRoleTab(id, tabKeyOf(tabKey), body, resolved(perms));
  }

  @Put('roles/:id/scope')
  @Requires(ROLES_MANAGE)
  putRoleScope(@Param('id', RoleId) id: string, @Body(new Zod(ScopeReplace)) body: z.infer<typeof ScopeReplace>, @CurrentPermissions() perms?: MyPermissions) {
    return this.svc.putScope({ roleId: id }, body, resolved(perms));
  }

  @Put('roles/:id')
  @Requires('admin.roles:action.edit')
  updateRole(@Param('id', RoleId) id: string, @Body(new Zod(RoleUpdate)) body: z.infer<typeof RoleUpdate>) {
    return this.svc.updateRole(id, body);
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @Requires('admin.roles:action.delete')
  async deleteRole(@Param('id', RoleId) id: string): Promise<void> {
    await this.svc.deleteRole(id);
  }

  // ------------------------------------------------------------------ users

  @Get('users/:id/permissions')
  @Requires(USERS_MANAGE)
  userPermissions(@Param('id', UserId) id: string) {
    return this.svc.userView(id);
  }

  @Put('users/:id/permissions/tabs/:tabKey')
  @Requires(USERS_MANAGE)
  putUserTab(
    @Param('id', UserId) id: string,
    @Param('tabKey') tabKey: string,
    @Body(new Zod(UserTabPermissions)) body: z.infer<typeof UserTabPermissions>,
    @CurrentPermissions() perms?: MyPermissions,
  ) {
    return this.svc.putUserTab(id, tabKeyOf(tabKey), body, resolved(perms));
  }

  @Put('users/:id/scope')
  @Requires(USERS_MANAGE)
  putUserScope(@Param('id', UserId) id: string, @Body(new Zod(ScopeReplace)) body: z.infer<typeof ScopeReplace>, @CurrentPermissions() perms?: MyPermissions) {
    return this.svc.putScope({ userId: id }, body, resolved(perms));
  }

  @Put('users/:id/roles')
  @Requires(USERS_MANAGE)
  putUserRoles(@Param('id', UserId) id: string, @Body(new Zod(UserRoles)) body: z.infer<typeof UserRoles>, @CurrentPermissions() perms?: MyPermissions) {
    return this.svc.putUserRoles(id, body.roleIds, resolved(perms));
  }

  @Get('users/:id/effective-permissions')
  @Requires('admin.users:action.view')
  effective(@Param('id', UserId) id: string) {
    return this.svc.effective(id);
  }
}

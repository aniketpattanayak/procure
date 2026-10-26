import type { MyPermissions } from '@procure/schema';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';

/**
 * Seam for the single "may the caller change this user's roles?" check (QA2-BUG-001/003). The permissions module
 * provides the implementation under this token; identity (POST/PUT /users) and PUT /users/:id/roles both call it.
 * Defined here so identity never imports the permissions module.
 */
export const ROLE_ASSIGNMENT_GUARD = Symbol('ROLE_ASSIGNMENT_GUARD');

export interface RoleAssignmentCaller { userId: string; isTenantAdmin: boolean; perms: MyPermissions | undefined }

export interface RoleAssignmentGuard {
  /**
   * Throws 403 unless the caller may change the roles of `targetUserId` (null = a user being created) from
   * `current` to `wanted`. Tenant admins may assign anything. Non-admins need `admin.users:action.manage_permissions`,
   * may not change their own roles, may not assign system roles, and must hold every visible key and the whole
   * location scope of each added role. No change = always allowed.
   */
  assertCanAssign(tx: Tx, tenantId: string, caller: RoleAssignmentCaller, targetUserId: string | null, current: string[], wanted: string[]): Promise<void>;
}

/** Only tenant admins may set `isTenantAdmin` (to anything other than its current value); nobody may change their own. */
export function assertAdminFlagChange(caller: { userId: string; isTenantAdmin: boolean }, targetUserId: string | null, current: boolean, wanted: boolean | undefined) {
  if (wanted === undefined || wanted === current) return;
  if (targetUserId !== null && targetUserId === caller.userId) {
    throw AppError.forbidden('You cannot change your own administrator rights. Ask another administrator to do it.');
  }
  if (!caller.isTenantAdmin) throw AppError.forbidden('Only an administrator can grant or remove administrator rights.');
}

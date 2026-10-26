import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@procure/schema';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import type { RoleAssignmentCaller, RoleAssignmentGuard } from '../identity';
import type { ResolvedPermissions } from './compiler';
import { PermissionRegistryService } from './registry.service';
import { ScopeService } from './scope.service';

export interface ScopeCandidate { allNodes: boolean; nodeId: string | null; includeDescendants: boolean; tabKey: string | null }

/**
 * The one no-escalation check for role assignment (QA2-BUG-001/003), used by POST/PUT /users (via identity's
 * ROLE_ASSIGNMENT_GUARD token) and PUT /users/:id/roles.
 */
@Injectable()
export class RoleAssignmentService implements RoleAssignmentGuard {
  constructor(private readonly registry: PermissionRegistryService, private readonly scope: ScopeService) {}

  async assertCanAssign(tx: Tx, tenantId: string, caller: RoleAssignmentCaller, targetUserId: string | null, current: string[], wanted: string[]): Promise<void> {
    const added = [...new Set(wanted)].filter(id => !current.includes(id));
    const removed = current.filter(id => !wanted.includes(id));
    if (!added.length && !removed.length) return;
    if (caller.isTenantAdmin) return;
    const perms = caller.perms as ResolvedPermissions | undefined;
    if (!perms?.keys.includes('admin.users:action.manage_permissions')) {
      throw AppError.forbidden('You need the "Set user permissions" right to change roles.');
    }
    if (targetUserId !== null && targetUserId === caller.userId) throw AppError.forbidden('You cannot change your own roles. Ask an administrator.');
    if (!added.length) return; // removing roles from someone else only reduces access

    const roles = await tx.selectFrom('app.role').select(['id', 'is_system']).where('id', 'in', added).where('is_deleted', '=', false).execute();
    if (roles.some(r => r.is_system)) throw AppError.forbidden('Only an administrator can assign the administrator role.');

    const { visibility } = await this.registry.load(tx, tenantId);
    const visible = new Set(visibility.visible.map(e => e.key));
    const grants = await tx.selectFrom('app.permission_grant').select('perm_key').where('role_id', 'in', added).where('effect', '=', 'allow').execute();
    const missing = [...new Set(grants.map(g => g.perm_key))].filter(k => visible.has(k) && !perms.keys.includes(k));
    if (missing.length) throw new AppError(403, ErrorCode.FORBIDDEN, 'You cannot assign a role that has permissions you do not have yourself.', { keys: missing.sort() });

    const scopeRows = await tx.selectFrom('app.scope_grant').select(['all_nodes', 'node_id', 'include_descendants', 'tab_key'])
      .where('role_id', 'in', added).execute();
    const entries = scopeRows.map(r => ({ allNodes: r.all_nodes, nodeId: r.node_id, includeDescendants: r.include_descendants, tabKey: r.tab_key }));
    if (await this.outsideScope(tx, perms, entries)) throw AppError.forbidden('You cannot assign a role that covers locations outside your own access.');
  }

  /** True if any entry grants locations the (non-admin) caller does not cover themselves. */
  async outsideScope(tx: Tx, caller: ResolvedPermissions | undefined, entries: ScopeCandidate[]): Promise<boolean> {
    if (caller?.isTenantAdmin || !entries.length) return false;
    const ids = [...new Set(entries.filter(e => e.nodeId).map(e => e.nodeId!))];
    const nodes = ids.length ? await tx.selectFrom('app.location_node').select(['id', 'path']).where('id', 'in', ids).execute() : [];
    const pathOf = new Map(nodes.map(n => [n.id, String(n.path)]));
    return entries.some(e => {
      const f = this.scope.nodeFilter(caller, e.tabKey);
      if ('all' in f) return false;
      if (e.allNodes) return true;
      const path = pathOf.get(e.nodeId!);
      if (!path) return false; // dangling node: grants nothing
      return e.includeDescendants ? !f.paths.some(sp => path === sp || path.startsWith(`${sp}.`)) : !this.scope.contains(f, path);
    });
  }
}

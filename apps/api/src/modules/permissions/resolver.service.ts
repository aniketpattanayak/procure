import { Injectable } from '@nestjs/common';
import { DbService, Tx } from '../../core/db.service';
import type { PermissionResolver } from '../../core/auth/permissions';
import { PermissionCache } from './cache';
import { compile, CompileInput, FieldAccessRow, Grant, ResolvedPermissions, ScopeNode, ScopeRow } from './compiler';
import { PermissionRegistryService } from './registry.service';

/**
 * Implements core's PermissionResolver (registered under PERMISSION_RESOLVER by PermissionsModule).
 * Loads the compiler inputs in one tenant transaction and caches the result per permver.
 */
@Injectable()
export class PermissionResolverService implements PermissionResolver {
  constructor(
    private readonly db: DbService,
    private readonly cache: PermissionCache,
    private readonly registry: PermissionRegistryService,
  ) {}

  async resolve(tenantId: string, userId: string, isTenantAdmin: boolean): Promise<ResolvedPermissions> {
    const version = await this.cache.version(tenantId);
    const hit = await this.cache.get(tenantId, userId, version);
    if (hit && hit.isTenantAdmin === isTenantAdmin) return hit;
    const { perms } = await this.db.tenantTx(tenantId, async tx => compile(await this.inputs(tx, tenantId, userId, isTenantAdmin, version)));
    await this.cache.set(tenantId, userId, version, perms);
    return perms;
  }

  /** Full compile (with explanation) inside an existing tenant transaction; never cached. */
  async explain(tx: Tx, tenantId: string, userId: string, isTenantAdmin: boolean) {
    const version = await this.cache.version(tenantId);
    return compile(await this.inputs(tx, tenantId, userId, isTenantAdmin, version));
  }

  async inputs(tx: Tx, tenantId: string, userId: string, isTenantAdmin: boolean, version: number): Promise<CompileInput> {
    const reg = await this.registry.load(tx, tenantId);
    const roles = await tx.selectFrom('app.user_role as ur').innerJoin('app.role as r', 'r.id', 'ur.role_id')
      .select(['r.id', 'r.name']).where('ur.user_id', '=', userId).where('r.is_deleted', '=', false).execute();
    const roleIds = roles.map(r => r.id);
    const roleName = new Map(roles.map(r => [r.id, r.name]));

    const grants = await tx.selectFrom('app.permission_grant').select(['role_id', 'user_id', 'perm_key', 'effect'])
      .where(eb => eb.or([eb('user_id', '=', userId), ...(roleIds.length ? [eb('role_id', 'in', roleIds)] : [])])).execute();
    const roleGrants: Grant[] = [];
    const userGrants: Grant[] = [];
    for (const g of grants) {
      const grant: Grant = { key: g.perm_key, effect: g.effect as Grant['effect'], roleId: g.role_id, roleName: g.role_id ? roleName.get(g.role_id) ?? null : null };
      (g.role_id ? roleGrants : userGrants).push(grant);
    }

    let roleFieldAccess: FieldAccessRow[] = [];
    let userFieldAccess: FieldAccessRow[] = [];
    let scopeRows: ScopeRow[] = [];
    let nodes: ScopeNode[] = [];
    if (!isTenantAdmin) {
      const fa = await tx.selectFrom('app.field_access').select(['form_key', 'field_key', 'mode', 'role_id', 'user_id'])
        .where(eb => eb.or([eb('user_id', '=', userId), ...(roleIds.length ? [eb('role_id', 'in', roleIds)] : [])])).execute();
      const toRow = (r: (typeof fa)[number]): FieldAccessRow => ({ formKey: r.form_key, fieldKey: r.field_key, mode: r.mode as FieldAccessRow['mode'], roleId: r.role_id });
      roleFieldAccess = fa.filter(r => r.role_id).map(toRow);
      userFieldAccess = fa.filter(r => r.user_id).map(toRow);

      const sg = await tx.selectFrom('app.scope_grant').select(['all_nodes', 'node_id', 'include_descendants', 'tab_key'])
        .where(eb => eb.or([eb('user_id', '=', userId), ...(roleIds.length ? [eb('role_id', 'in', roleIds)] : [])])).execute();
      scopeRows = sg.map(r => ({ allNodes: r.all_nodes, nodeId: r.node_id, includeDescendants: r.include_descendants, tabKey: r.tab_key }));
      const nodeIds = [...new Set(scopeRows.filter(r => r.nodeId).map(r => r.nodeId!))];
      if (nodeIds.length && !scopeRows.some(r => r.allNodes)) nodes = await loadSubtrees(tx, nodeIds);
    }

    return {
      isTenantAdmin, registry: reg.entries, features: reg.features, settings: reg.settings,
      roleGrants, userGrants, roleFieldAccess, userFieldAccess, scopeRows, nodes, version,
    };
  }
}

/** The given nodes and all their descendants. */
export async function loadSubtrees(tx: Tx, nodeIds: string[]): Promise<ScopeNode[]> {
  if (!nodeIds.length) return [];
  const rows = await tx.selectFrom('app.location_node as n')
    .innerJoin('app.location_node as g', join => join.on(eb => eb(eb.ref('n.path'), '<@', eb.ref('g.path'))))
    .select(['n.id', 'n.parent_id', 'n.path', 'n.is_active'])
    .where('g.id', 'in', nodeIds).distinct().execute();
  return rows.map(r => ({ id: r.id, parentId: r.parent_id, path: String(r.path), isActive: r.is_active }));
}

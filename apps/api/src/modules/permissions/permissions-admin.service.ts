import { Injectable } from '@nestjs/common';
import {
  EffectivePermissions, ErrorCode, PermissionSetView, RegistryTab, RoleInput, RoleTabPermissions, ScopeEntry, ScopeReplace,
  UserRow, UserTabPermissions,
} from '@procure/schema';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { tenantPrincipal } from '../../core/request-context';
import { toIso } from '../identity';
import { PermissionCache } from './cache';
import type { RegistryEntry, ResolvedPermissions, Visibility } from './compiler';
import { isScopedTab, PermissionRegistryService } from './registry.service';
import { PermissionResolverService } from './resolver.service';
import { RoleAssignmentService } from './role-assignment.service';

type Subject = { roleId: string } | { userId: string };
type FieldAccessIn = { formKey: string; fieldKey: string; mode: 'hidden' | 'readonly' | 'editable' };

const invalid = (message: string, errors: { path: string; message: string }[]) => new AppError(400, ErrorCode.VALIDATION, message, undefined, errors);
const notInPlan = (keys: string[]) =>
  new AppError(403, ErrorCode.FEATURE_NOT_IN_PLAN, 'Some of these permissions belong to features that are not in your plan.', { keys });

interface TabContext {
  tab: RegistryEntry;
  /** All registry entries of the tab (visible or not). */
  entries: RegistryEntry[];
  hidden: Set<string>;
  forms: RegistryTab['forms'];
  visibility: Visibility;
}

/**
 * Role / user permission editing (contract § Permissions). Every mutation: validate → write → audit in one tenant
 * transaction, then bump permver so the next request of every user recompiles.
 */
@Injectable()
export class PermissionsAdminService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly cache: PermissionCache,
    private readonly registry: PermissionRegistryService,
    private readonly resolver: PermissionResolverService,
    private readonly roleAssign: RoleAssignmentService,
  ) {}

  registryTabs(): Promise<RegistryTab[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.registry.tabs(tx, p.tenantId));
  }

  // ------------------------------------------------------------------ views

  async roleView(roleId: string): Promise<PermissionSetView> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      await this.loadRole(tx, roleId);
      return this.setView(tx, { roleId });
    });
  }

  async userView(userId: string): Promise<PermissionSetView> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      await this.loadUser(tx, userId);
      return this.setView(tx, { userId });
    });
  }

  // ------------------------------------------------------------------ role tab / user tab

  async putRoleTab(roleId: string, tabKey: string, body: z.infer<typeof RoleTabPermissions>, caller: ResolvedPermissions | undefined) {
    const p = tenantPrincipal();
    const view = await this.db.tenantTx(p.tenantId, async tx => {
      const role = await this.loadRole(tx, roleId);
      if (role.is_system) throw AppError.conflict('The administrator role always has every permission; it cannot be edited.');
      const t = await this.tabContext(tx, p.tenantId, tabKey);
      const errors = [
        ...this.checkKeys(t, body.actions, 'actions', ['action']),
        ...this.checkKeys(t, body.views, 'views', ['view']),
        ...this.checkFields(t, body.fieldAccess),
      ];
      if (errors.length) throw invalid('Some permissions are not valid for this tab.', errors);
      this.checkPlan(t, [...body.actions, ...body.views]);

      const desired = [...new Set([...body.actions, ...body.views])];
      const before = await this.tabSnapshot(tx, { roleId }, t);
      this.checkEscalation(caller, desired.filter(k => !before.allow.includes(k)));
      await this.replaceTabGrants(tx, { roleId }, t, desired.map(key => ({ key, effect: 'allow' as const })));
      await this.replaceTabFieldAccess(tx, { roleId }, t, body.fieldAccess);
      const after = await this.tabSnapshot(tx, { roleId }, t);
      await this.audit.tenant(tx, { action: 'update', entity: 'role_permissions', entityId: roleId, before: { tab: tabKey, ...before }, after: { tab: tabKey, ...after } });
      return this.setView(tx, { roleId });
    });
    await this.cache.bump(p.tenantId);
    return view;
  }

  async putUserTab(userId: string, tabKey: string, body: z.infer<typeof UserTabPermissions>, caller: ResolvedPermissions | undefined) {
    const p = tenantPrincipal();
    this.assertNotSelf(userId, caller);
    const view = await this.db.tenantTx(p.tenantId, async tx => {
      await this.loadUser(tx, userId);
      const t = await this.tabContext(tx, p.tenantId, tabKey);
      const errors = [
        ...this.checkKeys(t, body.allow, 'allow', ['action', 'view']),
        ...this.checkKeys(t, body.deny, 'deny', ['action', 'view']),
        ...this.checkFields(t, body.fieldAccess),
      ];
      body.allow.forEach((k, i) => { if (body.deny.includes(k)) errors.push({ path: `allow.${i}`, message: 'A permission cannot be both allowed and denied' }); });
      if (errors.length) throw invalid('Some permissions are not valid for this tab.', errors);
      this.checkPlan(t, [...body.allow, ...body.deny]);

      const before = await this.tabSnapshot(tx, { userId }, t);
      this.checkEscalation(caller, body.allow.filter(k => !before.allow.includes(k)));
      await this.replaceTabGrants(tx, { userId }, t, [
        ...[...new Set(body.allow)].map(key => ({ key, effect: 'allow' as const })),
        ...[...new Set(body.deny)].map(key => ({ key, effect: 'deny' as const })),
      ]);
      await this.replaceTabFieldAccess(tx, { userId }, t, body.fieldAccess);
      const after = await this.tabSnapshot(tx, { userId }, t);
      await this.audit.tenant(tx, { action: 'update', entity: 'user_permissions', entityId: userId, before: { tab: tabKey, ...before }, after: { tab: tabKey, ...after } });
      return this.setView(tx, { userId });
    });
    await this.cache.bump(p.tenantId);
    return view;
  }

  // ------------------------------------------------------------------ scope

  async putScope(subject: Subject, body: z.infer<typeof ScopeReplace>, caller: ResolvedPermissions | undefined) {
    const p = tenantPrincipal();
    if ('userId' in subject) this.assertNotSelf(subject.userId, caller);
    const view = await this.db.tenantTx(p.tenantId, async tx => {
      if ('roleId' in subject) {
        const role = await this.loadRole(tx, subject.roleId);
        if (role.is_system) throw AppError.conflict('The administrator role always covers every location; it cannot be edited.');
      } else await this.loadUser(tx, subject.userId);

      const entries = body.entries;
      const errors: { path: string; message: string }[] = [];
      const nodeIds = [...new Set(entries.filter(e => e.nodeId).map(e => e.nodeId!))];
      const nodes = nodeIds.length
        ? await tx.selectFrom('app.location_node').select(['id', 'path']).where('id', 'in', nodeIds).execute()
        : [];
      const pathOf = new Map(nodes.map(n => [n.id, String(n.path)]));
      const { visibility } = await this.registry.load(tx, p.tenantId);
      const visibleTabs = new Set(visibility.visible.filter(e => e.kind === 'tab').map(e => e.key));
      entries.forEach((e, i) => {
        if (e.nodeId && !pathOf.has(e.nodeId)) errors.push({ path: `entries.${i}.nodeId`, message: 'Location not found' });
        if (e.tabKey !== null && (!visibleTabs.has(e.tabKey) || !isScopedTab(e.tabKey))) {
          errors.push({ path: `entries.${i}.tabKey`, message: 'Location scope does not apply to this tab' });
        }
      });
      if (errors.length) throw invalid('Some locations are not valid.', errors);

      const before = await this.scopeRows(tx, subject);
      const sig = (e: { allNodes: boolean; nodeId: string | null; includeDescendants: boolean; tabKey: string | null }) =>
        `${e.allNodes}|${e.nodeId}|${e.allNodes ? true : e.includeDescendants}|${e.tabKey}`;
      const existing = new Set(before.map(sig));
      const unique = new Map(entries.map(e => [sig(e), e]));
      if (await this.roleAssign.outsideScope(tx, caller, [...unique.values()].filter(e => !existing.has(sig(e))))) {
        throw AppError.forbidden('You can only grant locations that are within your own access.');
      }

      const where = 'roleId' in subject ? { col: 'role_id' as const, id: subject.roleId } : { col: 'user_id' as const, id: subject.userId };
      await tx.deleteFrom('app.scope_grant').where(where.col, '=', where.id).execute();
      if (unique.size) {
        await tx.insertInto('app.scope_grant').values([...unique.values()].map(e => ({
          role_id: 'roleId' in subject ? subject.roleId : null,
          user_id: 'userId' in subject ? subject.userId : null,
          tab_key: e.tabKey, all_nodes: e.allNodes, node_id: e.nodeId,
          include_descendants: e.allNodes ? true : e.includeDescendants, created_by: p.userId,
        }))).execute();
      }
      const after = await this.scopeRows(tx, subject);
      await this.audit.tenant(tx, {
        action: 'update', entity: 'roleId' in subject ? 'role_scope' : 'user_scope', entityId: where.id,
        before: before.map(stripId), after: after.map(stripId),
      });
      return this.setView(tx, subject);
    });
    await this.cache.bump(p.tenantId);
    return view;
  }

  // ------------------------------------------------------------------ user roles

  async putUserRoles(userId: string, roleIds: string[], caller: ResolvedPermissions | undefined): Promise<UserRow> {
    const p = tenantPrincipal();
    const row = await this.db.tenantTx(p.tenantId, async tx => {
      const before = await this.userRow(tx, userId);
      const wanted = [...new Set(roleIds)];
      const roles = wanted.length
        ? await tx.selectFrom('app.role').select(['id', 'is_system']).where('id', 'in', wanted).where('is_deleted', '=', false).execute()
        : [];
      if (roles.length !== wanted.length) throw invalid('One or more selected roles do not exist.', [{ path: 'roleIds', message: 'Unknown role' }]);
      await this.roleAssign.assertCanAssign(tx, p.tenantId, { userId: p.userId, isTenantAdmin: p.isTenantAdmin, perms: caller },
        userId, before.roles.map(r => r.id), wanted);
      await tx.deleteFrom('app.user_role').where('user_id', '=', userId).execute();
      if (wanted.length) await tx.insertInto('app.user_role').values(wanted.map(role_id => ({ user_id: userId, role_id }))).execute();
      const after = await this.userRow(tx, userId);
      await this.audit.tenant(tx, { action: 'update', entity: 'user_roles', entityId: userId, before: { roles: before.roles }, after: { roles: after.roles } });
      return after;
    });
    await this.cache.bump(p.tenantId);
    return row;
  }

  // ------------------------------------------------------------------ effective

  async effective(userId: string): Promise<EffectivePermissions> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      const u = await this.loadUser(tx, userId);
      const res = await this.resolver.explain(tx, p.tenantId, userId, u.is_tenant_admin);
      const tabLabel = new Map((await this.registry.entries(tx)).filter(e => e.kind === 'tab').map(e => [e.key, e.label]));
      let nodes: EffectivePermissions['scope']['nodes'] = [];
      if (!u.is_tenant_admin) {
        const roleIds = (await tx.selectFrom('app.user_role as ur').innerJoin('app.role as r', 'r.id', 'ur.role_id')
          .select('r.id').where('ur.user_id', '=', userId).where('r.is_deleted', '=', false).execute()).map(r => r.id);
        const rows = await tx.selectFrom('app.scope_grant as s').leftJoin('app.location_node as n', 'n.id', 's.node_id')
          .select(['s.node_id', 's.include_descendants', 's.tab_key', 'n.name'])
          .where(eb => eb.or([eb('s.user_id', '=', userId), ...(roleIds.length ? [eb('s.role_id', 'in', roleIds)] : [])]))
          .where('s.all_nodes', '=', false).execute();
        nodes = rows.map(r => ({ id: r.node_id!, name: r.name ?? '', includeDescendants: r.include_descendants, tabKey: r.tab_key }));
      }
      return {
        userId,
        isTenantAdmin: u.is_tenant_admin,
        keys: res.explain,
        scope: { allNodes: res.perms.scope.allNodes, nodes },
        hiddenByPlan: res.visibility.hiddenTabs.map(key => ({ key, label: tabLabel.get(key) ?? key })),
      };
    });
  }

  // ------------------------------------------------------------------ roles edit / delete

  async updateRole(id: string, body: z.infer<typeof RoleInput> & { version: number }) {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      const before = await this.loadRole(tx, id);
      if (before.is_system && body.key !== before.key) throw AppError.conflict('The key of a system role cannot be changed.', { field: 'key' });
      if (body.key !== before.key) {
        const clash = await tx.selectFrom('app.role').select('id').where('key', '=', body.key).where('id', '<>', id).executeTakeFirst();
        if (clash) throw AppError.conflict(`A role with key "${body.key}" already exists.`, { field: 'key' });
      }
      const res = await tx.updateTable('app.role')
        .set({ key: body.key, name: body.name, description: body.description ?? null })
        .where('id', '=', id).where('version', '=', body.version).where('is_deleted', '=', false).executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw AppError.versionConflict();
      const after = await this.loadRole(tx, id);
      const role = toRole(after, await this.roleUserCount(tx, id));
      await this.audit.tenant(tx, { action: 'update', entity: 'role', entityId: id, before: toRole(before, role.userCount), after: role });
      return role;
    });
  }

  async deleteRole(id: string): Promise<void> {
    const p = tenantPrincipal();
    await this.db.tenantTx(p.tenantId, async tx => {
      const role = await this.loadRole(tx, id);
      if (role.is_system) throw AppError.conflict('System roles cannot be deleted.');
      const n = await this.roleUserCount(tx, id);
      if (n > 0) {
        throw AppError.conflict(`This role is assigned to ${n} user${n === 1 ? '' : 's'}. Remove it from them first.`, {
          usedBy: [{ kind: 'tenant_user', label: 'Users', count: n }],
        });
      }
      await tx.deleteFrom('app.user_role').where('role_id', '=', id).execute(); // deleted users only
      await tx.deleteFrom('app.permission_grant').where('role_id', '=', id).execute();
      await tx.deleteFrom('app.field_access').where('role_id', '=', id).execute();
      await tx.deleteFrom('app.scope_grant').where('role_id', '=', id).execute();
      // Soft delete; free the key for reuse (the original key stays in the audit log).
      await tx.updateTable('app.role')
        .set({ is_deleted: true, key: sql`'x' || substr(replace(id::text, '-', ''), 1, 20)` })
        .where('id', '=', id).execute();
      await this.audit.tenant(tx, { action: 'delete', entity: 'role', entityId: id, before: toRole(role, 0) });
    });
    await this.cache.bump(p.tenantId);
  }

  // ------------------------------------------------------------------ helpers

  private async loadRole(tx: Tx, id: string) {
    const r = await tx.selectFrom('app.role').select(['id', 'key', 'name', 'description', 'is_system', 'version'])
      .where('id', '=', id).where('is_deleted', '=', false).executeTakeFirst();
    if (!r) throw AppError.notFound('Role');
    return r;
  }

  private async loadUser(tx: Tx, id: string) {
    const u = await tx.selectFrom('app.tenant_user').select(['id', 'is_tenant_admin']).where('id', '=', id).where('is_deleted', '=', false).executeTakeFirst();
    if (!u) throw AppError.notFound('User');
    return u;
  }

  private async roleUserCount(tx: Tx, roleId: string) {
    const r = await tx.selectFrom('app.user_role as ur').innerJoin('app.tenant_user as u', 'u.id', 'ur.user_id')
      .select(eb => eb.fn.countAll<string>().as('n')).where('ur.role_id', '=', roleId).where('u.is_deleted', '=', false).executeTakeFirstOrThrow();
    return Number(r.n);
  }

  private async userRow(tx: Tx, id: string): Promise<UserRow> {
    const r = await tx.selectFrom('app.tenant_user')
      .select(['id', 'name', 'email', 'phone', 'is_tenant_admin', 'is_active', 'locked_until', 'last_login_at', 'version'])
      .where('id', '=', id).where('is_deleted', '=', false).executeTakeFirst();
    if (!r) throw AppError.notFound('User');
    const roles = await tx.selectFrom('app.user_role as ur').innerJoin('app.role as rl', 'rl.id', 'ur.role_id')
      .select(['rl.id', 'rl.key', 'rl.name']).where('ur.user_id', '=', id).where('rl.is_deleted', '=', false).orderBy('rl.name').execute();
    return {
      id: r.id, name: r.name, email: r.email, phone: r.phone, isTenantAdmin: r.is_tenant_admin, isActive: r.is_active,
      lockedUntil: r.locked_until && new Date(r.locked_until).getTime() > Date.now() ? toIso(r.locked_until) : null,
      lastLoginAt: toIso(r.last_login_at), roles, version: r.version,
    };
  }

  private async tabContext(tx: Tx, tenantId: string, tabKey: string): Promise<TabContext> {
    const { entries, visibility } = await this.registry.load(tx, tenantId);
    const tab = entries.find(e => e.kind === 'tab' && e.key === tabKey);
    if (!tab) throw AppError.notFound('Permission tab');
    if (visibility.hiddenByFeature.has(tabKey)) throw notInPlan([tabKey]);
    if (visibility.hiddenBySetting.has(tabKey)) {
      throw invalid('This module is switched off in settings.', [{ path: 'tabKey', message: 'Turned off in settings' }]);
    }
    const forms = (await this.registry.tabForms(tx)).get(tabKey) ?? [];
    const tabEntries = entries.filter(e => e.tabKey === tabKey);
    const hidden = new Set(tabEntries.filter(e => visibility.hiddenByFeature.has(e.key) || visibility.hiddenBySetting.has(e.key)).map(e => e.key));
    return { tab, entries: tabEntries, hidden, forms, visibility };
  }

  private checkKeys(t: TabContext, keys: string[], path: string, kinds: RegistryEntry['kind'][]) {
    const errors: { path: string; message: string }[] = [];
    keys.forEach((k, i) => {
      const e = t.entries.find(x => x.key === k);
      if (!e || !kinds.includes(e.kind)) errors.push({ path: `${path}.${i}`, message: `"${k}" is not a ${kinds.join(' or ')} of this tab` });
      else if (t.visibility.hiddenBySetting.has(k)) errors.push({ path: `${path}.${i}`, message: `"${k}" is switched off in settings` });
    });
    return errors;
  }

  private checkFields(t: TabContext, rows: FieldAccessIn[]) {
    const errors: { path: string; message: string }[] = [];
    rows.forEach((r, i) => {
      const form = t.forms.find(f => f.formKey === r.formKey);
      if (!form) errors.push({ path: `fieldAccess.${i}.formKey`, message: 'This form is not part of the tab' });
      else if (!form.fields.some(f => f.key === r.fieldKey)) errors.push({ path: `fieldAccess.${i}.fieldKey`, message: 'Unknown field' });
    });
    return errors;
  }

  private checkPlan(t: TabContext, keys: string[]) {
    const out = keys.filter(k => t.visibility.hiddenByFeature.has(k));
    if (out.length) throw notInPlan([...new Set(out)]);
  }

  /** QA2-BUG-002: non-admins can never change their own user-level permissions, scope, roles or field access. */
  private assertNotSelf(userId: string, caller: ResolvedPermissions | undefined) {
    const p = tenantPrincipal();
    if (userId === p.userId && !p.isTenantAdmin && !caller?.isTenantAdmin) {
      throw AppError.forbidden('You cannot change your own permissions. Ask an administrator.');
    }
  }

  /** No privilege escalation: a non-admin may only newly grant keys they hold themselves. */
  private checkEscalation(caller: ResolvedPermissions | undefined, newKeys: string[]) {
    if (caller?.isTenantAdmin) return;
    const missing = newKeys.filter(k => !caller?.keys.includes(k));
    if (missing.length) {
      throw new AppError(403, ErrorCode.FORBIDDEN, 'You can only grant permissions that you have yourself.', { keys: [...new Set(missing)].sort() });
    }
  }

  private subjectWhere(s: Subject) {
    return 'roleId' in s ? { col: 'role_id' as const, id: s.roleId } : { col: 'user_id' as const, id: s.userId };
  }

  /** Grants of the subject on this tab (keys hidden by plan/settings are preserved, never shown or replaced). */
  private async tabSnapshot(tx: Tx, s: Subject, t: TabContext) {
    const w = this.subjectWhere(s);
    const grants = await tx.selectFrom('app.permission_grant').select(['perm_key', 'effect']).where(w.col, '=', w.id)
      .where(sql<boolean>`starts_with(perm_key, ${`${t.tab.key}:`})`).orderBy('perm_key').execute();
    const formKeys = t.forms.map(f => f.formKey);
    const fa = formKeys.length
      ? await tx.selectFrom('app.field_access').select(['form_key', 'field_key', 'mode']).where(w.col, '=', w.id)
        .where('form_key', 'in', formKeys).orderBy('form_key').orderBy('field_key').execute()
      : [];
    return {
      allow: grants.filter(g => g.effect === 'allow').map(g => g.perm_key),
      deny: grants.filter(g => g.effect === 'deny').map(g => g.perm_key),
      fieldAccess: fa.map(f => ({ formKey: f.form_key, fieldKey: f.field_key, mode: f.mode })),
    };
  }

  private async replaceTabGrants(tx: Tx, s: Subject, t: TabContext, grants: { key: string; effect: 'allow' | 'deny' }[]) {
    const w = this.subjectWhere(s);
    let del = tx.deleteFrom('app.permission_grant').where(w.col, '=', w.id).where(sql<boolean>`starts_with(perm_key, ${`${t.tab.key}:`})`);
    if (t.hidden.size) del = del.where('perm_key', 'not in', [...t.hidden]);
    await del.execute();
    const p = tenantPrincipal();
    if (grants.length) {
      await tx.insertInto('app.permission_grant').values(grants.map(g => ({
        role_id: 'roleId' in s ? s.roleId : null, user_id: 'userId' in s ? s.userId : null,
        perm_key: g.key, effect: g.effect, created_by: p.userId,
      }))).execute();
    }
  }

  private async replaceTabFieldAccess(tx: Tx, s: Subject, t: TabContext, rows: FieldAccessIn[]) {
    const w = this.subjectWhere(s);
    const formKeys = t.forms.map(f => f.formKey);
    if (formKeys.length) await tx.deleteFrom('app.field_access').where(w.col, '=', w.id).where('form_key', 'in', formKeys).execute();
    const unique = new Map(rows.map(r => [`${r.formKey}\u0000${r.fieldKey}`, r]));
    const p = tenantPrincipal();
    if (unique.size) {
      await tx.insertInto('app.field_access').values([...unique.values()].map(r => ({
        role_id: 'roleId' in s ? s.roleId : null, user_id: 'userId' in s ? s.userId : null,
        form_key: r.formKey, field_key: r.fieldKey, mode: r.mode, created_by: p.userId,
      }))).execute();
    }
  }

  private async scopeRows(tx: Tx, s: Subject) {
    const w = this.subjectWhere(s);
    const rows = await tx.selectFrom('app.scope_grant as g').leftJoin('app.location_node as n', 'n.id', 'g.node_id')
      .select(['g.id', 'g.all_nodes', 'g.node_id', 'g.include_descendants', 'g.tab_key', 'n.name', 'n.path'])
      .where(`g.${w.col}`, '=', w.id).orderBy('g.created_at').orderBy('g.id').execute();
    const ancestorIds = new Set<string>();
    for (const r of rows) if (r.path) for (const id of labelIds(String(r.path))) ancestorIds.add(id);
    const names = ancestorIds.size
      ? new Map((await tx.selectFrom('app.location_node').select(['id', 'name']).where('id', 'in', [...ancestorIds]).execute()).map(n => [n.id, n.name]))
      : new Map<string, string>();
    return rows.map(r => ({
      id: r.id, allNodes: r.all_nodes, nodeId: r.node_id, includeDescendants: r.include_descendants, tabKey: r.tab_key,
      ...(r.name ? { nodeName: r.name } : {}),
      ...(r.path ? { nodePath: labelIds(String(r.path)).map(id => names.get(id) ?? '?').join(' › ') } : {}),
    }));
  }

  private async setView(tx: Tx, s: Subject): Promise<PermissionSetView> {
    const w = this.subjectWhere(s);
    const grants = await tx.selectFrom('app.permission_grant').select(['perm_key', 'effect']).where(w.col, '=', w.id).orderBy('perm_key').execute();
    const fa = await tx.selectFrom('app.field_access').select(['id', 'form_key', 'field_key', 'mode']).where(w.col, '=', w.id)
      .orderBy('form_key').orderBy('field_key').execute();
    const scope = await this.scopeRows(tx, s);
    return {
      grants: grants.map(g => ({ key: g.perm_key, effect: g.effect as 'allow' | 'deny' })),
      scope: scope as (ScopeEntry & { id: string; nodeName?: string; nodePath?: string })[],
      fieldAccess: fa.map(f => ({ id: f.id, formKey: f.form_key, fieldKey: f.field_key, mode: f.mode })),
    };
  }
}

/** Node ids from an ltree path of `n<hex>` labels (root first). */
export function labelIds(path: string): string[] {
  return path.split('.').map(l => {
    const h = l.slice(1);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  });
}

function stripId<T extends { id: string }>(r: T): Omit<T, 'id'> {
  const { id: _id, ...rest } = r;
  return rest;
}

function toRole(r: { id: string; key: string; name: string; description: string | null; is_system: boolean; version: number }, userCount: number) {
  return { id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.is_system, version: r.version, userCount };
}

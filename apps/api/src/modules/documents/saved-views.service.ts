import { Injectable } from '@nestjs/common';
import { ErrorCode, SavedViewConfig, SavedViewInput, SavedViewRow } from '@procure/schema';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import type { DocActor } from './types';
import { has } from './types';

interface ViewDb {
  id: string; scope_key: string; name: string; owner_user_id: string | null; shared_role_ids: string[]; config: unknown; is_default: boolean; version: number; created_by: string | null;
}
const COLS = ['id', 'scope_key', 'name', 'owner_user_id', 'shared_role_ids', 'config', 'is_default', 'version', 'created_by'] as const;
const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);

/** The permission tab a list scope belongs to: 'doc.capex:document' -> 'doc.capex', 'master.item' -> 'master.item'. */
export const tabOfScope = (scopeKey: string) => scopeKey.split(':')[0]!;

/**
 * Saved list views. Personal views: any user, visible to the owner only. Shared views (owner NULL): visible to holders
 * of the tab's view key (and, when `sharedRoleIds` is set, members of those roles); created/changed only by tenant
 * admins or holders of `admin.roles:action.edit`.
 */
@Injectable()
export class SavedViewsService {
  constructor(private readonly audit: AuditService) {}

  private isSharer(actor: DocActor): boolean {
    const admin = !actor.perms || (actor.perms as { isTenantAdmin?: boolean }).isTenantAdmin === true;
    return admin || has(actor, 'admin.roles:action.edit');
  }

  private async myRoles(tx: Tx, actor: DocActor): Promise<string[]> {
    if (!actor.userId) return [];
    return (await tx.selectFrom('app.user_role').select('role_id').where('tenant_id', '=', actor.tenantId).where('user_id', '=', actor.userId).execute()).map(r => r.role_id);
  }

  private visible(v: ViewDb, actor: DocActor, roles: string[]): boolean {
    if (v.owner_user_id) return v.owner_user_id === actor.userId;
    if (!has(actor, `${tabOfScope(v.scope_key)}:action.view`)) return false;
    return !v.shared_role_ids.length || v.shared_role_ids.some(r => roles.includes(r)) || this.isSharer(actor);
  }

  private toRow(v: ViewDb, actor: DocActor): SavedViewRow {
    return {
      id: v.id, scopeKey: v.scope_key, name: v.name, config: SavedViewConfig.parse(v.config ?? {}), shared: v.owner_user_id === null,
      sharedRoleIds: v.shared_role_ids, isDefault: v.is_default, isMine: v.owner_user_id === actor.userId || (v.owner_user_id === null && v.created_by === actor.userId), version: v.version,
    };
  }

  async list(tx: Tx, actor: DocActor, scopeKey?: string): Promise<SavedViewRow[]> {
    let q = tx.selectFrom('app.saved_view').select([...COLS]).where('tenant_id', '=', actor.tenantId)
      .where(eb => eb.or([eb('owner_user_id', 'is', null), ...(actor.userId ? [eb('owner_user_id', '=', actor.userId)] : [])]));
    if (scopeKey) q = q.where('scope_key', '=', scopeKey);
    const rows = (await q.orderBy('scope_key').orderBy('name').orderBy('id').execute()) as ViewDb[];
    const roles = await this.myRoles(tx, actor);
    return rows.filter(v => this.visible(v, actor, roles)).map(v => this.toRow(v, actor));
  }

  private async load(tx: Tx, actor: DocActor, id: string, lock = false): Promise<ViewDb> {
    let q = tx.selectFrom('app.saved_view').select([...COLS]).where('tenant_id', '=', actor.tenantId).where('id', '=', id);
    if (lock) q = q.forUpdate();
    const v = (await q.executeTakeFirst()) as ViewDb | undefined;
    if (!v || !this.visible(v, actor, await this.myRoles(tx, actor))) throw AppError.notFound('Saved view');
    return v;
  }

  private async checkInput(tx: Tx, actor: DocActor, input: z.infer<typeof SavedViewInput>) {
    if (input.shared) {
      if (!has(actor, `${tabOfScope(input.scopeKey)}:action.view`)) throw AppError.forbidden('You cannot share views of a list you cannot see.');
      if (!this.isSharer(actor)) throw AppError.forbidden('Only administrators can share views.');
      if (input.sharedRoleIds.length) {
        const n = await tx.selectFrom('app.role').select('id').where('tenant_id', '=', actor.tenantId).where('id', 'in', input.sharedRoleIds).where('is_deleted', '=', false).execute();
        if (n.length !== new Set(input.sharedRoleIds).size) throw bad('sharedRoleIds', 'Some roles do not exist.');
      }
    } else if (input.sharedRoleIds.length) {
      throw bad('sharedRoleIds', 'Personal views cannot be shared with roles.');
    }
  }

  private async clearDefaults(tx: Tx, actor: DocActor, v: { scope_key: string; owner_user_id: string | null; id: string }) {
    let q = tx.updateTable('app.saved_view').set({ is_default: false }).where('tenant_id', '=', actor.tenantId).where('scope_key', '=', v.scope_key).where('id', '<>', v.id).where('is_default', '=', true);
    q = v.owner_user_id ? q.where('owner_user_id', '=', v.owner_user_id) : q.where('owner_user_id', 'is', null);
    await q.execute();
  }

  async create(tx: Tx, actor: DocActor, input: z.infer<typeof SavedViewInput>): Promise<SavedViewRow> {
    if (!actor.userId) throw AppError.forbidden();
    await this.checkInput(tx, actor, input);
    const v = (await tx.insertInto('app.saved_view').values({
      scope_key: input.scopeKey, name: input.name, owner_user_id: input.shared ? null : actor.userId, shared_role_ids: input.shared ? input.sharedRoleIds : [],
      config: JSON.stringify(input.config), is_default: input.isDefault, created_by: actor.userId,
    }).returning([...COLS]).executeTakeFirstOrThrow()) as ViewDb;
    if (v.is_default) await this.clearDefaults(tx, actor, v);
    await this.audit.tenant(tx, { action: 'create', entity: 'saved_view', entityId: v.id, actorId: actor.userId, after: { scopeKey: v.scope_key, name: v.name, shared: input.shared } });
    return this.toRow(v, actor);
  }

  private assertCanChange(v: ViewDb, actor: DocActor) {
    if (v.owner_user_id ? v.owner_user_id !== actor.userId : !this.isSharer(actor)) throw AppError.forbidden('You cannot change this view.');
  }

  async update(tx: Tx, actor: DocActor, id: string, input: z.infer<typeof SavedViewInput> & { version: number }): Promise<SavedViewRow> {
    const before = await this.load(tx, actor, id, true);
    this.assertCanChange(before, actor);
    if (before.version !== input.version) throw AppError.versionConflict();
    await this.checkInput(tx, actor, input);
    const v = (await tx.updateTable('app.saved_view').set({
      scope_key: input.scopeKey, name: input.name, owner_user_id: input.shared ? null : before.owner_user_id ?? actor.userId,
      shared_role_ids: input.shared ? input.sharedRoleIds : [], config: JSON.stringify(input.config), is_default: input.isDefault,
    }).where('tenant_id', '=', actor.tenantId).where('id', '=', id).returning([...COLS]).executeTakeFirstOrThrow()) as ViewDb;
    if (v.is_default) await this.clearDefaults(tx, actor, v);
    await this.audit.tenant(tx, { action: 'update', entity: 'saved_view', entityId: id, actorId: actor.userId, before: { name: before.name, config: before.config }, after: { name: v.name, config: input.config } });
    return this.toRow(v, actor);
  }

  async remove(tx: Tx, actor: DocActor, id: string): Promise<void> {
    const v = await this.load(tx, actor, id, true);
    this.assertCanChange(v, actor);
    await tx.deleteFrom('app.saved_view').where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    await this.audit.tenant(tx, { action: 'delete', entity: 'saved_view', entityId: id, actorId: actor.userId, before: { name: v.name, scopeKey: v.scope_key } });
  }
}

import { Injectable } from '@nestjs/common';
import { ReportDefinition, ReportInput, ReportResult, ReportRunInput } from '@procure/schema';
import type { MyPermissions } from '@procure/schema';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { RedisService } from '../../core/redis.service';
import { BUILTINS_VERSION, installReportBuiltins } from './builtins';
import { execute } from './compiler';
import { ReportsCatalogue } from './catalogue.service';
import { ReportRunner } from './runner.service';
import type { RunActor } from './types';

export interface ReportRow {
  id: string; key: string; name: string; description: string | null; kind: 'builtin' | 'custom';
  definition: ReportDefinition; ownerUserId: string | null; sharedRoleIds: string[];
  isMine: boolean; canEdit: boolean; version: number; createdAt: string; updatedAt: string;
}

type DbRow = {
  id: string; key: string; name: string; description: string | null; kind: 'builtin' | 'custom'; definition: unknown; owner_user_id: string | null;
  shared_role_ids: string[]; version: number; created_at: Date; updated_at: Date;
};
const COLS = ['id', 'key', 'name', 'description', 'kind', 'definition', 'owner_user_id', 'shared_role_ids', 'version', 'created_at', 'updated_at'] as const;

export const isAdmin = (perms: MyPermissions | null) => !perms || !!(perms as { isTenantAdmin?: boolean }).isTenantAdmin;
const holds = (perms: MyPermissions | null, key: string) => !perms || perms.keys.includes(key);

/** Report definitions: built-ins (read-only), the caller's own and those shared with their roles. */
@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DbService, private readonly runner: ReportRunner, private readonly audit: AuditService, private readonly redis: RedisService,
    private readonly catalogue: ReportsCatalogue,
  ) {}

  /** System reports are shown only when the tenant has the source's feature and the viewer may read the source. */
  async builtinAvailable(tx: Tx, actor: RunActor, r: { kind: string; definition: unknown }, cache?: Map<string, boolean>): Promise<boolean> {
    if (r.kind !== 'builtin') return true;
    const src = (r.definition as { source?: { kind?: string; key?: string } } | null)?.source;
    if (!src?.kind || !src.key) return false;
    return this.catalogue.available(tx, actor, src as { kind: 'doc' | 'doc_line' | 'master' | 'engine'; key: string }, cache);
  }

  /** Installs/refreshes the built-ins once per tenant and BUILTINS_VERSION (own transaction; cached flag in Redis). */
  async ensureBuiltins(tenantId: string) {
    const flag = `reports:builtins:${tenantId}`;
    if ((await this.redis.client.get(flag)) === String(BUILTINS_VERSION)) return;
    await this.db.tenantTx(tenantId, tx => installReportBuiltins(tx, tenantId));
    await this.redis.client.set(flag, String(BUILTINS_VERSION), 'EX', 86_400);
  }

  async roleIds(tx: Tx, userId: string | null): Promise<string[]> {
    if (!userId) return [];
    return (await tx.selectFrom('app.user_role').select('role_id').where('user_id', '=', userId).execute()).map(r => r.role_id);
  }

  private toRow(r: DbRow, actor: RunActor): ReportRow {
    const mine = !!actor.userId && r.owner_user_id === actor.userId;
    return {
      id: r.id, key: r.key, name: r.name, description: r.description, kind: r.kind, definition: ReportDefinition.parse(r.definition),
      ownerUserId: r.owner_user_id, sharedRoleIds: r.shared_role_ids ?? [], isMine: mine,
      canEdit: r.kind === 'custom' && (mine || isAdmin(actor.perms)) && holds(actor.perms, 'reports:action.build'),
      version: r.version, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  async list(tx: Tx, actor: RunActor): Promise<ReportRow[]> {
    await this.ensureBuiltins(actor.tenantId);
    const roles = await this.roleIds(tx, actor.userId);
    let q = tx.selectFrom('app.report_def').select([...COLS]).where('tenant_id', '=', actor.tenantId).where('is_active', '=', true);
    if (!isAdmin(actor.perms)) {
      q = q.where(eb => eb.or([
        eb('kind', '=', 'builtin'),
        ...(actor.userId ? [eb('owner_user_id', '=', actor.userId)] : []),
        ...(roles.length ? [eb(sql<string[]>`shared_role_ids`, '&&', sql<string[]>`${roles}::uuid[]`)] : []),
      ]));
    }
    const rows = (await q.orderBy('kind').orderBy('name').execute()) as DbRow[];
    const cache = new Map<string, boolean>();
    const out: ReportRow[] = [];
    for (const r of rows) if (await this.builtinAvailable(tx, actor, r, cache)) out.push(this.toRow(r, actor));
    return out;
  }

  /** A report the caller can see (404 otherwise). */
  async get(tx: Tx, actor: RunActor, id: string, lock = false): Promise<ReportRow> {
    await this.ensureBuiltins(actor.tenantId);
    let q = tx.selectFrom('app.report_def').select([...COLS]).where('tenant_id', '=', actor.tenantId).where('id', '=', id).where('is_active', '=', true);
    if (lock) q = q.forUpdate();
    const r = (await q.executeTakeFirst()) as DbRow | undefined;
    if (!r) throw AppError.notFound('Report');
    if (!(await this.builtinAvailable(tx, actor, r))) throw AppError.notFound('Report');
    if (r.kind !== 'builtin' && !isAdmin(actor.perms) && r.owner_user_id !== actor.userId) {
      const roles = await this.roleIds(tx, actor.userId);
      if (!(r.shared_role_ids ?? []).some(x => roles.includes(x))) throw AppError.notFound('Report');
    }
    return this.toRow(r, actor);
  }

  /** Builder checks: the definition must compile for this user (fields exist and are visible), roles must exist. */
  private async validate(tx: Tx, actor: RunActor, input: z.infer<typeof ReportInput>) {
    await this.runner.prepare(tx, actor, input.definition);
    if (input.sharedRoleIds.length) {
      if (!holds(actor.perms, 'reports:action.share')) throw AppError.forbidden('You cannot share reports with roles.');
      const found = await tx.selectFrom('app.role').select('id').where('tenant_id', '=', actor.tenantId).where('id', 'in', input.sharedRoleIds)
        .where('is_deleted', '=', false).execute();
      if (found.length !== new Set(input.sharedRoleIds).size) throw new AppError(400, 'VALIDATION_FAILED', 'Unknown role.', undefined, [{ path: 'sharedRoleIds', message: 'Unknown role' }]);
    }
  }

  async create(tx: Tx, actor: RunActor, input: z.infer<typeof ReportInput>): Promise<ReportRow> {
    await this.ensureBuiltins(actor.tenantId);
    if (input.key.startsWith('builtin_')) throw new AppError(400, 'VALIDATION_FAILED', 'Keys starting with "builtin_" are reserved.', undefined, [{ path: 'key', message: 'Reserved prefix' }]);
    await this.validate(tx, actor, input);
    const row = await tx.insertInto('app.report_def').values({
      key: input.key, name: input.name, description: input.description ?? null, kind: 'custom', definition: JSON.stringify(input.definition),
      owner_user_id: actor.userId, shared_role_ids: input.sharedRoleIds, created_by: actor.userId, updated_by: actor.userId,
    }).returning([...COLS]).executeTakeFirstOrThrow();
    await this.audit.tenant(tx, { action: 'create', entity: 'report', entityId: row.id, actorId: actor.userId, after: { key: input.key, name: input.name, source: input.definition.source, sharedRoleIds: input.sharedRoleIds } });
    return this.toRow(row as DbRow, actor);
  }

  private async editable(tx: Tx, actor: RunActor, id: string): Promise<ReportRow> {
    const r = await this.get(tx, actor, id, true);
    if (r.kind === 'builtin') throw AppError.conflict('Built-in reports are read-only. Save a copy to customise it.');
    if (!r.isMine && !isAdmin(actor.perms)) throw AppError.forbidden('Only the owner can change this report.');
    return r;
  }

  async update(tx: Tx, actor: RunActor, id: string, input: z.infer<typeof ReportInput>): Promise<ReportRow> {
    const before = await this.editable(tx, actor, id);
    await this.validate(tx, actor, input);
    const row = await tx.updateTable('app.report_def').set({
      key: input.key, name: input.name, description: input.description ?? null, definition: JSON.stringify(input.definition),
      shared_role_ids: input.sharedRoleIds, updated_by: actor.userId, version: sql<number>`version + 1`,
    }).where('tenant_id', '=', actor.tenantId).where('id', '=', id).returning([...COLS]).executeTakeFirstOrThrow();
    await this.audit.tenant(tx, {
      action: 'update', entity: 'report', entityId: id, actorId: actor.userId,
      before: { key: before.key, name: before.name, definition: before.definition, sharedRoleIds: before.sharedRoleIds },
      after: { key: input.key, name: input.name, definition: input.definition, sharedRoleIds: input.sharedRoleIds },
    });
    return this.toRow(row as DbRow, actor);
  }

  async remove(tx: Tx, actor: RunActor, id: string): Promise<void> {
    const r = await this.editable(tx, actor, id);
    await tx.deleteFrom('app.report_schedule').where('tenant_id', '=', actor.tenantId).where('report_id', '=', id).execute();
    await tx.deleteFrom('app.report_def').where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    await this.audit.tenant(tx, { action: 'delete', entity: 'report', entityId: id, actorId: actor.userId, before: { key: r.key, name: r.name } });
  }

  async run(tx: Tx, actor: RunActor, id: string, input: z.infer<typeof ReportRunInput>): Promise<ReportResult> {
    const r = await this.get(tx, actor, id);
    return this.runner.run(tx, actor, r.definition, { params: input.params, cursor: input.page.cursor, limit: input.page.limit, adapt: r.kind === 'builtin' });
  }

  async preview(tx: Tx, actor: RunActor, definition: ReportDefinition, params: Record<string, unknown>): Promise<ReportResult> {
    const { compiled } = await this.runner.prepare(tx, actor, definition, { params });
    return execute(tx, compiled, { params, limit: 200 });
  }
}

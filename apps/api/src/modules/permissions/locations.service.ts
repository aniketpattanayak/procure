import { Injectable } from '@nestjs/common';
import { ErrorCode, LocationCreate, LocationMove, LocationNode, LocationUpdate } from '@procure/schema';
import { Expression, sql, SqlBool } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { tenantPrincipal } from '../../core/request-context';
import { enforceLiveLimit, likePattern, notifyLimitCrossing } from '../identity';
import { PermissionCache } from './cache';
import { NodeFilter, scopeCondition } from './scope.service';
import { levelLabel, loadSettings } from './settings.util';

export const LocationListQuery = z.object({
  parentId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(200).optional(),
  view: z.enum(['active', 'inactive', 'all']).optional(),
  scope: z.enum(['all', 'mine']).default('all'),
});
export const LocationTreeQuery = LocationListQuery.pick({ view: true, scope: true });

export type LocationView = 'active' | 'inactive' | 'all';
const TREE_LIMIT = 5000;
const ALL: NodeFilter = { all: true };
const LIMIT_KEY = 'max_locations';
const LIMIT_LABEL = 'active locations';

interface NodeRow {
  id: string; parent_id: string | null; code: string; name: string; depth: number; is_active: boolean;
  sort_order: number; version: number; path: string; child_count: string; path_names: string[] | null;
}

@Injectable()
export class LocationsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly cache: PermissionCache) {}

  // ------------------------------------------------------------------ reads

  async list(q: z.infer<typeof LocationListQuery>, view: LocationView, filter: NodeFilter): Promise<LocationNode[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      const conds: Expression<SqlBool>[] = [viewCond(view), scopeCondition(sql.ref('n.path'), filter)];
      if (q.parentId) conds.push(sql<SqlBool>`n.parent_id = ${q.parentId}`);
      else if (q.q) {
        const pat = likePattern(q.q);
        conds.push(sql<SqlBool>`(n.name ilike ${pat} or n.code::text ilike ${pat})`);
      } else if ('all' in filter) conds.push(sql<SqlBool>`n.parent_id is null`);
      else {
        // Top of the caller's own subtree(s): nodes in scope whose parent is not in scope.
        conds.push(sql<SqlBool>`not exists (select 1 from app.location_node pp where pp.id = n.parent_id and ${scopeCondition(sql.ref('pp.path'), filter)})`);
      }
      return this.select(tx, conds, view, sql`n.sort_order, n.name, n.id`);
    });
  }

  async tree(view: LocationView, filter: NodeFilter): Promise<LocationNode[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.select(tx, [viewCond(view), scopeCondition(sql.ref('n.path'), filter)], view, sql`n.path`));
  }

  async get(id: string, filter: NodeFilter = ALL): Promise<LocationNode> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      await this.assertInScope(tx, id, filter);
      return this.load(tx, id);
    });
  }

  // ------------------------------------------------------------------ writes

  async create(input: z.infer<typeof LocationCreate>, filter: NodeFilter = ALL): Promise<LocationNode> {
    const p = tenantPrincipal();
    const node = await this.db.tenantTx(p.tenantId, async tx => {
      if (input.parentId) await lockTree(tx);
      if (!input.parentId && !('all' in filter)) throw AppError.forbidden('Only users who cover all locations can add a top-level location.');
      if (input.parentId) {
        await this.assertInScope(tx, input.parentId, filter, () => invalid('parentId', 'Parent location not found'));
        const parent = await tx.selectFrom('app.location_node').select(['id', 'is_active']).where('id', '=', input.parentId).executeTakeFirst();
        if (!parent) throw invalid('parentId', 'Parent location not found');
        if (!parent.is_active) throw AppError.conflict('The parent location is inactive. Activate it first.', { field: 'parentId' });
      }
      await this.assertCodeFree(tx, input.code);
      const usage = await enforceLiveLimit(tx, LIMIT_KEY, p.tenantId, LIMIT_LABEL);
      const row = await tx.insertInto('app.location_node').values({
        parent_id: input.parentId, code: input.code, name: input.name, sort_order: input.sortOrder,
        custom: JSON.stringify(input.custom), created_by: p.userId, updated_by: p.userId,
      }).returning('id').executeTakeFirstOrThrow();
      const created = await this.load(tx, row.id);
      await this.audit.tenant(tx, { action: 'create', entity: 'location', entityId: row.id, after: created });
      await notifyLimitCrossing(tx, LIMIT_KEY, LIMIT_LABEL, usage);
      return created;
    });
    await this.cache.bump(p.tenantId); // descendants-included scopes now cover the new node
    return node;
  }

  async update(id: string, input: z.infer<typeof LocationUpdate>, filter: NodeFilter = ALL): Promise<LocationNode> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      await this.assertInScope(tx, id, filter);
      const before = await this.load(tx, id);
      if (input.code !== undefined && input.code.toLowerCase() !== before.code.toLowerCase()) await this.assertCodeFree(tx, input.code, id);
      const set: Record<string, unknown> = { updated_by: p.userId };
      if (input.code !== undefined) set.code = input.code;
      if (input.name !== undefined) set.name = input.name;
      if (input.sortOrder !== undefined) set.sort_order = input.sortOrder;
      if (input.custom !== undefined) set.custom = JSON.stringify(input.custom);
      const res = await tx.updateTable('app.location_node').set(set).where('id', '=', id).where('version', '=', input.version).executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw AppError.versionConflict();
      const after = await this.load(tx, id);
      await this.audit.tenant(tx, { action: 'update', entity: 'location', entityId: id, before, after });
      return after;
    });
  }

  async move(id: string, input: z.infer<typeof LocationMove>, filter: NodeFilter = ALL): Promise<LocationNode> {
    const p = tenantPrincipal();
    const node = await this.db.tenantTx(p.tenantId, async tx => {
      // QA2-BUG-005: serialise tree reshaping per tenant; every path below is read after the lock (fresh snapshot
      // per statement under READ COMMITTED), so the cycle check sees the other move's committed result.
      await lockTree(tx);
      await this.assertInScope(tx, id, filter, undefined, true);
      if (input.parentId) await this.assertInScope(tx, input.parentId, filter, () => invalid('parentId', 'Target location not found'));
      else if (!('all' in filter)) throw AppError.forbidden('Only users who cover all locations can move a location to the top level.');
      const cur = await tx.selectFrom('app.location_node').select(['id', 'path', 'is_active', 'version', 'parent_id']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw AppError.notFound('Location');
      if (cur.version !== input.version) throw AppError.versionConflict();
      const before = await this.load(tx, id);
      if ((cur.parent_id ?? null) === input.parentId) return before;
      if (input.parentId) {
        const parent = await tx.selectFrom('app.location_node').select(['id', 'path', 'is_active']).where('id', '=', input.parentId).executeTakeFirst();
        if (!parent) throw invalid('parentId', 'Target location not found');
        const pp = String(parent.path);
        const np = String(cur.path);
        if (pp === np || pp.startsWith(`${np}.`)) throw AppError.conflict('A location cannot be moved under itself or one of its own sub-locations.');
        if (cur.is_active && !parent.is_active) throw AppError.conflict('The target location is inactive. Activate it first.', { field: 'parentId' });
      }
      try {
        await tx.updateTable('app.location_node').set({ parent_id: input.parentId, updated_by: p.userId }).where('id', '=', id).execute();
      } catch (e) {
        if ((e as { code?: string }).code === '23514') throw AppError.conflict('A location cannot be moved under itself or one of its own sub-locations.');
        throw e;
      }
      const after = await this.load(tx, id);
      await this.audit.tenant(tx, { action: 'move', entity: 'location', entityId: id, before: { parentId: before.parentId, pathNames: before.pathNames }, after: { parentId: after.parentId, pathNames: after.pathNames } });
      return after;
    });
    await this.cache.bump(p.tenantId);
    return node;
  }

  async deactivate(id: string, filter: NodeFilter = ALL): Promise<LocationNode> {
    const p = tenantPrincipal();
    const node = await this.db.tenantTx(p.tenantId, async tx => {
      await this.assertInScope(tx, id, filter, undefined, true);
      const cur = await tx.selectFrom('app.location_node').select(['id', 'path', 'is_active']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw AppError.notFound('Location');
      const before = await this.load(tx, id);
      if (!cur.is_active) return before;
      const changed = await tx.updateTable('app.location_node').set({ is_active: false, updated_by: p.userId })
        .where(sql<SqlBool>`path <@ ${String(cur.path)}::ltree`).where('is_active', '=', true).returning('id').execute();
      const after = await this.load(tx, id);
      await this.audit.tenant(tx, { action: 'deactivate', entity: 'location', entityId: id, before: { isActive: true }, after: { isActive: false, cascaded: changed.map(r => r.id).filter(x => x !== id) } });
      return after;
    });
    await this.cache.bump(p.tenantId);
    return node;
  }

  async activate(id: string, filter: NodeFilter = ALL): Promise<LocationNode> {
    const p = tenantPrincipal();
    const node = await this.db.tenantTx(p.tenantId, async tx => {
      await this.assertInScope(tx, id, filter);
      // Lock order as in users.activate: row first, then the tenant limit lock.
      const cur = await tx.selectFrom('app.location_node').select(['id', 'parent_id', 'is_active']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw AppError.notFound('Location');
      const before = await this.load(tx, id);
      if (cur.is_active) return before;
      if (cur.parent_id) {
        const parent = await tx.selectFrom('app.location_node').select('is_active').where('id', '=', cur.parent_id).executeTakeFirst();
        if (!parent?.is_active) throw AppError.conflict('The parent location is inactive. Activate it first.', { field: 'parentId' });
      }
      const usage = await enforceLiveLimit(tx, LIMIT_KEY, p.tenantId, LIMIT_LABEL);
      await tx.updateTable('app.location_node').set({ is_active: true, updated_by: p.userId }).where('id', '=', id).execute();
      const after = await this.load(tx, id);
      await this.audit.tenant(tx, { action: 'activate', entity: 'location', entityId: id, before: { isActive: false }, after: { isActive: true } });
      await notifyLimitCrossing(tx, LIMIT_KEY, LIMIT_LABEL, usage);
      return after;
    });
    await this.cache.bump(p.tenantId);
    return node;
  }

  async remove(id: string, filter: NodeFilter = ALL): Promise<void> {
    const p = tenantPrincipal();
    await this.db.tenantTx(p.tenantId, async tx => {
      await this.assertInScope(tx, id, filter);
      const cur = await tx.selectFrom('app.location_node').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw AppError.notFound('Location');
      const before = await this.load(tx, id);
      const count = async (q: Promise<{ n: string } | undefined>) => Number((await q)?.n ?? 0);
      const children = await count(tx.selectFrom('app.location_node').select(eb => eb.fn.countAll<string>().as('n')).where('parent_id', '=', id).executeTakeFirst());
      const refs = await count(tx.selectFrom('app.record_ref').select(eb => eb.fn.countAll<string>().as('n'))
        .where('to_kind', '=', 'location_node').where('to_id', '=', id).executeTakeFirst());
      const scopes = await count(tx.selectFrom('app.scope_grant').select(eb => eb.fn.countAll<string>().as('n')).where('node_id', '=', id).executeTakeFirst());
      const usedBy = [
        ...(children ? [{ kind: 'location_node', label: 'Sub-locations', count: children }] : []),
        ...(refs ? [{ kind: 'record_ref', label: 'Records', count: refs }] : []),
        ...(scopes ? [{ kind: 'scope_grant', label: 'Permission scopes', count: scopes }] : []),
      ];
      if (usedBy.length) {
        throw AppError.conflict('This location is in use and cannot be deleted. Deactivate it instead.', { code: 'RECORD_IN_USE', usedBy });
      }
      await tx.deleteFrom('app.record_ref').where('from_kind', '=', 'location_node').where('from_id', '=', id).execute();
      await tx.deleteFrom('app.location_node').where('id', '=', id).execute();
      await this.audit.tenant(tx, { action: 'delete', entity: 'location', entityId: id, before });
    });
    await this.cache.bump(p.tenantId);
  }

  // ------------------------------------------------------------------ helpers

  /** Out-of-scope nodes behave as if they did not exist (404, or `notFound()` for body references). */
  private async assertInScope(tx: Tx, id: string, filter: NodeFilter, notFound: () => AppError = () => AppError.notFound('Location'), wholeSubtree = false) {
    // wholeSubtree (move / deactivate cascade to descendants): a node granted without descendants qualifies only if it is a leaf.
    const cond = wholeSubtree && !('all' in filter)
      ? sql`(${scopeCondition(sql.ref('n.path'), { paths: filter.paths })} or (${scopeCondition(sql.ref('n.path'), filter)} and not exists (select 1 from app.location_node c where c.parent_id = n.id)))`
      : scopeCondition(sql.ref('n.path'), filter);
    const r = await sql<{ id: string }>`select n.id from app.location_node n where n.id = ${id} and ${cond}`.execute(tx);
    if (!r.rows.length) throw notFound();
  }

  private async assertCodeFree(tx: Tx, code: string, exceptId?: string) {
    let q = tx.selectFrom('app.location_node').select('id').where('code', '=', code);
    if (exceptId) q = q.where('id', '<>', exceptId);
    if (await q.executeTakeFirst()) throw AppError.conflict(`A location with code "${code}" already exists.`, { field: 'code' });
  }

  async load(tx: Tx, id: string): Promise<LocationNode> {
    const rows = await this.select(tx, [sql<SqlBool>`n.id = ${id}`], 'all', sql`n.id`);
    if (!rows[0]) throw AppError.notFound('Location');
    return rows[0];
  }

  private async select(tx: Tx, conds: Expression<SqlBool>[], view: LocationView, orderBy: ReturnType<typeof sql>): Promise<LocationNode[]> {
    const levels = (await loadSettings(tx)).values['labels.location_levels'] as string[];
    const childCond = view === 'active' ? sql`and c.is_active` : view === 'inactive' ? sql`and not c.is_active` : sql``;
    const r = await sql<NodeRow>`
      select n.id, n.parent_id, n.code::text as code, n.name, n.depth, n.is_active, n.sort_order, n.version, n.path::text as path,
        (select count(*) from app.location_node c where c.parent_id = n.id ${childCond})::text as child_count,
        (select array_agg(a.name order by a.depth) from app.location_node a where a.path @> n.path and a.id <> n.id) as path_names
      from app.location_node n
      where ${sql.join(conds, sql` and `)}
      order by ${orderBy}
      limit ${TREE_LIMIT}`.execute(tx);
    return r.rows.map(n => ({
      id: n.id, parentId: n.parent_id, code: n.code, name: n.name, depth: n.depth, levelLabel: levelLabel(levels, n.depth),
      isActive: n.is_active, sortOrder: n.sort_order, childCount: Number(n.child_count), pathNames: n.path_names ?? [], version: n.version,
    }));
  }
}

/** Per-tenant advisory lock for moves and creates under a parent (`location-tree:<tenant>`). */
async function lockTree(tx: Tx) {
  await sql`select pg_advisory_xact_lock(hashtextextended('location-tree:' || app.current_tenant_id()::text, 0))`.execute(tx);
}

function viewCond(view: LocationView): Expression<SqlBool> {
  return view === 'active' ? sql<SqlBool>`n.is_active` : view === 'inactive' ? sql<SqlBool>`not n.is_active` : sql<SqlBool>`true`;
}

function invalid(path: string, message: string) {
  return new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);
}

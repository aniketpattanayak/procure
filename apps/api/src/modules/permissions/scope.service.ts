import { Injectable } from '@nestjs/common';
import type { MyPermissions } from '@procure/schema';
import { Expression, ExpressionBuilder, sql, SqlBool } from 'kysely';
import type { ResolvedPermissions, ScopeSet } from './compiler';

/**
 * Result of `ScopeService.nodeFilter`. `paths` are ltree paths whose whole subtree is in scope
 * (`path <@ ANY(paths)`); `exactPaths` (optional) are single nodes granted without descendants (`path = ANY(...)`).
 * Use `ScopeService.where()` / `scopeCondition()` to apply both correctly.
 */
export type NodeFilter = { all: true } | { paths: string[]; exactPaths?: string[]; nodeIds?: string[] };

const NONE: ScopeSet = { all: false, nodeIds: [], subtreePaths: [], exactPaths: [] };

function scopeFor(perms: MyPermissions | undefined, tabKey: string | null): ScopeSet {
  if (!perms) return NONE;
  const r = perms as Partial<ResolvedPermissions>;
  if (r.scopes) return (tabKey && r.scopes[tabKey]) || r.scopes['*'] || NONE;
  // A bare MyPermissions (no paths): only "all" can be honoured; node ids are exposed for id-based filters.
  return perms.scope.allNodes ? { all: true, nodeIds: [], subtreePaths: [], exactPaths: [] } : { ...NONE, nodeIds: perms.scope.nodeIds };
}

/** Builds the SQL condition for a location `path` column (ltree). No grants → always false (fail closed). */
export function scopeCondition(pathColumn: Expression<unknown> | string, filter: NodeFilter): Expression<SqlBool> {
  if ('all' in filter) return sql<SqlBool>`true`;
  const col = typeof pathColumn === 'string' ? sql.ref(pathColumn) : pathColumn;
  const parts: Expression<SqlBool>[] = [];
  if (filter.paths.length) parts.push(sql<SqlBool>`${col} <@ ANY(${sql.val(filter.paths)}::ltree[])`);
  if (filter.exactPaths?.length) parts.push(sql<SqlBool>`${col} = ANY(${sql.val(filter.exactPaths)}::ltree[])`);
  if (!parts.length) return sql<SqlBool>`false`;
  return parts.length === 1 ? parts[0]! : sql<SqlBool>`(${parts[0]!} OR ${parts[1]!})`;
}

/**
 * Data scope (ADR-0005). `nodeFilter(perms, tabKey)` gives the caller's location filter for one tab; tabs with
 * their own scope rows use those, every other tab uses the default rows.
 *
 *   const f = scope.nodeFilter(perms, 'indent');
 *   qb.innerJoin('app.location_node as loc', 'loc.id', 'd.location_id').where(scope.where('loc.path', f))
 */
@Injectable()
export class ScopeService {
  nodeFilter(perms: MyPermissions | undefined, tabKey: string | null): NodeFilter {
    const s = scopeFor(perms, tabKey);
    if (s.all) return { all: true };
    return { paths: s.subtreePaths, exactPaths: s.exactPaths, nodeIds: s.nodeIds };
  }

  /** Active node ids in scope (descendants expanded), or 'all'. */
  nodeIds(perms: MyPermissions | undefined, tabKey: string | null): 'all' | string[] {
    const s = scopeFor(perms, tabKey);
    return s.all ? 'all' : s.nodeIds;
  }

  /** `.where(scope.where('loc.path', filter))` — the Kysely helper for a joined location path column. */
  where(pathColumn: string, filter: NodeFilter) {
    return <DB, TB extends keyof DB>(_eb: ExpressionBuilder<DB, TB>): Expression<SqlBool> => scopeCondition(pathColumn, filter);
  }

  /** True if the node (by ltree path) is inside the filter. */
  contains(filter: NodeFilter, path: string): boolean {
    if ('all' in filter) return true;
    return filter.paths.some(p => path === p || path.startsWith(`${p}.`)) || (filter.exactPaths ?? []).includes(path);
  }
}

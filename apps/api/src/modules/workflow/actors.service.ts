import { Injectable } from '@nestjs/common';
import type { MyPermissions, WorkflowActor } from '@procure/schema';
import { RawBuilder, sql } from 'kysely';
import type { Tx } from '../../core/db.service';
import { PermissionRegistryService, ScopeService } from '../permissions';
import { docTab, stageKeyPerm, StageDef } from './model';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What actor resolution needs to know about a document. */
export interface ActorDoc {
  docTypeKey: string;
  locationPath: string;
  submittedBy: string | null;
  /** Header values keyed by form field keys (user lookup fields hold user ids). */
  values: Record<string, unknown>;
}

export interface Caller { userId: string; perms: MyPermissions | undefined; roleIds: string[] }

export const FAN_OUT_CAP = 200;

/**
 * "Who can act" (contract §Workflow): holds `doc.<type>:action.stage_<key>`, has the document location in scope for
 * `doc.<type>`, matches any actor rule (or the stage has none), and is not the submitter unless allowSelfApproval.
 * The same rule is evaluated in memory for the caller (canAct) and in one SQL query for "everyone eligible"
 * (notifications, quorum, ifNoActor, actor names) — never per-user permission compiles.
 */
@Injectable()
export class ActorsService {
  private readonly visibleCache = new WeakMap<object, Promise<Set<string>>>();
  constructor(private readonly registry: PermissionRegistryService, private readonly scope: ScopeService) {}

  /** Visible registry keys for this tenant (plan + flow settings), memoised per transaction. */
  visibleKeys(tx: Tx, tenantId: string): Promise<Set<string>> {
    let p = this.visibleCache.get(tx);
    if (!p) {
      p = this.registry.load(tx, tenantId).then(r => new Set(r.visibility.visible.map(e => e.key)));
      this.visibleCache.set(tx, p);
    }
    return p;
  }

  async roleIdsOf(tx: Tx, userId: string): Promise<string[]> {
    const rows = await tx.selectFrom('app.user_role as ur').innerJoin('app.role as r', 'r.id', 'ur.role_id')
      .select('ur.role_id').where('ur.user_id', '=', userId).where('r.is_deleted', '=', false).execute();
    return rows.map(r => r.role_id);
  }

  /** In-memory actor-rule match for one user. `managerOfSubmitter` must be loaded when a reporting_manager rule exists. */
  matchesRules(userId: string, roleIds: string[], actors: WorkflowActor[], doc: ActorDoc, managerOfSubmitter: string | null): boolean {
    if (!actors.length) return true;
    return actors.some(a => {
      switch (a.type) {
        case 'role': return roleIds.includes(a.roleId);
        case 'users': return a.userIds.includes(userId);
        case 'reporting_manager': return !!managerOfSubmitter && managerOfSubmitter === userId;
        case 'field': return doc.values[a.field] === userId;
      }
      return false;
    });
  }

  async managerOf(tx: Tx, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const r = await tx.selectFrom('app.tenant_user').select('reporting_manager_id').where('id', '=', userId).executeTakeFirst();
    return r?.reporting_manager_id ?? null;
  }

  /** Rule-based eligibility of the caller (permission key + scope + actor rules + self-approval). */
  async callerMatches(tx: Tx, caller: Caller, stage: StageDef, doc: ActorDoc): Promise<{ ok: boolean; reason?: 'no_key' | 'scope' | 'actor' | 'self' }> {
    if (!caller.perms?.keys.includes(stageKeyPerm(doc.docTypeKey, stage.key))) return { ok: false, reason: 'no_key' };
    if (!this.inScope(caller.perms, doc)) return { ok: false, reason: 'scope' };
    const mgr = stage.actors.some(a => a.type === 'reporting_manager') ? await this.managerOf(tx, doc.submittedBy) : null;
    if (!this.matchesRules(caller.userId, caller.roleIds, stage.actors, doc, mgr)) return { ok: false, reason: 'actor' };
    if (!stage.allowSelfApproval && doc.submittedBy === caller.userId) return { ok: false, reason: 'self' };
    return { ok: true };
  }

  inScope(perms: MyPermissions | undefined, doc: Pick<ActorDoc, 'docTypeKey' | 'locationPath'>): boolean {
    return this.scope.contains(this.scope.nodeFilter(perms, docTab(doc.docTypeKey)), doc.locationPath);
  }

  /** SQL condition: user `u` holds `key` (admin, or allowed and not denied via role/user grants). */
  private holdsKeySql(key: string): RawBuilder<boolean> {
    const roles = sql`(select ur.role_id from app.user_role ur join app.role r on r.id = ur.role_id and not r.is_deleted where ur.user_id = u.id)`;
    return sql<boolean>`(u.is_tenant_admin or (
      exists (select 1 from app.permission_grant g where g.perm_key = ${key} and g.effect = 'allow' and (g.user_id = u.id or g.role_id in ${roles}))
      and not exists (select 1 from app.permission_grant g where g.perm_key = ${key} and g.effect = 'deny' and (g.user_id = u.id or g.role_id in ${roles}))))`;
  }

  /** SQL condition: location `path` is in u's data scope for `tab` (tab rows replace the default rows). */
  private inScopeSql(tab: string, path: string): RawBuilder<boolean> {
    const mine = sql`(sg.user_id = u.id or sg.role_id in (select ur.role_id from app.user_role ur join app.role r on r.id = ur.role_id and not r.is_deleted where ur.user_id = u.id))`;
    const mine2 = sql`(sg2.user_id = u.id or sg2.role_id in (select ur.role_id from app.user_role ur join app.role r on r.id = ur.role_id and not r.is_deleted where ur.user_id = u.id))`;
    return sql<boolean>`(u.is_tenant_admin or exists (
      select 1 from app.scope_grant sg left join app.location_node n on n.id = sg.node_id
      where ${mine}
        and sg.tab_key is not distinct from (case when exists (select 1 from app.scope_grant sg2 where ${mine2} and sg2.tab_key = ${tab}) then ${tab} else null end)
        and (sg.all_nodes or (sg.include_descendants and ${path}::ltree <@ n.path) or (not sg.include_descendants and n.path = ${path}::ltree))))`;
  }

  private rulesSql(actors: WorkflowActor[], doc: ActorDoc): RawBuilder<boolean> {
    if (!actors.length) return sql<boolean>`true`;
    const parts = actors.map(a => {
      switch (a.type) {
        case 'role': return sql<boolean>`exists (select 1 from app.user_role ur where ur.user_id = u.id and ur.role_id = ${a.roleId})`;
        case 'users': return sql<boolean>`u.id = any(${sql.val(a.userIds)}::uuid[])`;
        case 'reporting_manager':
          return doc.submittedBy ? sql<boolean>`u.id = (select s.reporting_manager_id from app.tenant_user s where s.id = ${doc.submittedBy})` : sql<boolean>`false`;
        case 'field': {
          const v = doc.values[a.field];
          return typeof v === 'string' && UUID_RE.test(v) ? sql<boolean>`u.id = ${v}` : sql<boolean>`false`;
        }
      }
      return sql<boolean>`false`;
    });
    return sql<boolean>`(${sql.join(parts, sql` or `)})`;
  }

  /**
   * Every user who may act on `stage` of this document by rule (not counting wf_assignment), capped.
   * `excludeSelf` false lists the submitter too (used for display only).
   */
  async eligibleUsers(tx: Tx, tenantId: string, stage: StageDef, doc: ActorDoc, opts: { limit?: number } = {}): Promise<{ id: string; name: string }[]> {
    const key = stageKeyPerm(doc.docTypeKey, stage.key);
    const visible = await this.visibleKeys(tx, tenantId);
    if (!visible.has(key)) return [];
    const self = !stage.allowSelfApproval && doc.submittedBy ? sql<boolean>`u.id <> ${doc.submittedBy}` : sql<boolean>`true`;
    const r = await sql<{ id: string; name: string }>`
      select u.id, u.name from app.tenant_user u
      where u.is_active and not u.is_deleted
        and ${this.holdsKeySql(key)}
        and ${this.inScopeSql(docTab(doc.docTypeKey), doc.locationPath)}
        and ${this.rulesSql(stage.actors, doc)}
        and ${self}
      order by u.name, u.id limit ${opts.limit ?? FAN_OUT_CAP}`.execute(tx);
    return r.rows;
  }

  /** Users named by actor rules alone (escalation targets, notify effect) — no permission requirement. */
  async usersOfActors(tx: Tx, actors: WorkflowActor[], doc: ActorDoc, limit = FAN_OUT_CAP): Promise<{ id: string; name: string }[]> {
    if (!actors.length) return [];
    const r = await sql<{ id: string; name: string }>`
      select u.id, u.name from app.tenant_user u
      where u.is_active and not u.is_deleted and ${this.rulesSql(actors, doc)}
      order by u.name, u.id limit ${limit}`.execute(tx);
    return r.rows;
  }

  /** Can this user see documents of the type at this location (forward target check)? */
  async userCanView(tx: Tx, tenantId: string, userId: string, doc: ActorDoc): Promise<boolean> {
    const key = `${docTab(doc.docTypeKey)}:action.view`;
    const visible = await this.visibleKeys(tx, tenantId);
    if (!visible.has(key)) return false;
    const r = await sql<{ ok: boolean }>`
      select (${this.holdsKeySql(key)} and ${this.inScopeSql(docTab(doc.docTypeKey), doc.locationPath)}) as ok
      from app.tenant_user u where u.id = ${userId} and u.is_active and not u.is_deleted`.execute(tx);
    return r.rows[0]?.ok === true;
  }

  async activeAdmins(tx: Tx): Promise<{ id: string; name: string }[]> {
    return tx.selectFrom('app.tenant_user').select(['id', 'name']).where('is_tenant_admin', '=', true)
      .where('is_active', '=', true).where('is_deleted', '=', false).orderBy('name').limit(FAN_OUT_CAP).execute();
  }

  /** Human description of actor rules (for "waiting for …" when nobody is resolved yet). */
  async describe(tx: Tx, actors: WorkflowActor[]): Promise<string[]> {
    const out: string[] = [];
    const roleIds = actors.flatMap(a => (a.type === 'role' ? [a.roleId] : []));
    const userIds = actors.flatMap(a => (a.type === 'users' ? a.userIds : []));
    const roles = roleIds.length ? await tx.selectFrom('app.role').select(['id', 'name']).where('id', 'in', roleIds).execute() : [];
    const users = userIds.length ? await tx.selectFrom('app.tenant_user').select(['id', 'name']).where('id', 'in', userIds).execute() : [];
    for (const a of actors) {
      if (a.type === 'role') out.push(roles.find(r => r.id === a.roleId)?.name ?? 'Unknown role');
      if (a.type === 'users') for (const id of a.userIds) out.push(users.find(u => u.id === id)?.name ?? 'Unknown user');
      if (a.type === 'reporting_manager') out.push("Submitter's reporting manager");
      if (a.type === 'field') out.push(`User in "${a.field}"`);
    }
    return out;
  }
}

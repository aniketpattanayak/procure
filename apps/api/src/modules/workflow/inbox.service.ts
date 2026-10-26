import { Injectable } from '@nestjs/common';
import type { InboxCounts, InboxItem, MyPermissions } from '@procure/schema';
import { RawBuilder, sql } from 'kysely';
import type { Tx } from '../../core/db.service';
import { decodeCursor, getTenantSetting, toPage } from '../identity';
import { ScopeService, scopeCondition } from '../permissions';
import { ActorsService } from './actors.service';
import { Def, docTab, FIXED_STATUS_LABELS, parseDefinition, statusLabelOf } from './model';

const STAGE_KEY_RE = /^doc\.([a-z][a-z0-9_]{1,40}):action\.stage_([a-z][a-z0-9_]{0,30})$/;

export interface InboxQuery { docType?: string; stage?: string; overdue?: boolean; cursor?: string; limit: number }

interface Row {
  instance_id: string; stage_key: string; because: 'rule' | 'forward' | 'escalation'; entered_at: Date; due_at: Date | null;
  document_id: string; workflow_version_id: string; number: string | null; status_key: string; submitted_at: Date | null;
  total_amount: string | null; doc_type_key: string; doc_type_name: string; location_name: string; submitted_by_name: string | null;
  pending_lines: string; held_lines: string; sort_id: string;
}

/**
 * Approvals inbox. The caller's actionable set — (doc type, version, stage) pairs from the stage keys they hold,
 * with their data scope and actor rules turned into SQL — is derived once; then one query returns the documents
 * at those active stages ∪ active wf_assignments. No per-document permission checks.
 */
@Injectable()
export class InboxService {
  constructor(private readonly scope: ScopeService, private readonly actors: ActorsService) {}

  /**
   * The caller's actionable condition on an active stage row `ss` (QA3-BUG-018): `rule` (stage keys + scope + actor
   * rules, evaluated against the instance `i`, document `d` and location `loc`) and `assigned` (an active
   * forward/escalation assignment; never the submitter unless the stage allows self-approval).
   */
  private async base(tx: Tx, userId: string, perms: MyPermissions | undefined): Promise<{ rule: RawBuilder<boolean>; assigned: RawBuilder<boolean>; defs: Map<string, Def> }> {
    const held = new Map<string, Set<string>>();
    for (const k of perms?.keys ?? []) {
      const m = STAGE_KEY_RE.exec(k);
      if (m) { const s = held.get(m[1]!) ?? new Set<string>(); s.add(m[2]!); held.set(m[1]!, s); }
    }
    const defs = new Map<string, Def>();
    const rules: RawBuilder<boolean>[] = [];
    if (held.size) {
      const roleIds = await this.actors.roleIdsOf(tx, userId);
      const versions = await sql<{ id: string; definition: unknown; key: string }>`
        select v.id, v.definition, dt.key from app.workflow_version v
        join app.workflow_def w on w.id = v.workflow_id join app.doc_type dt on dt.id = w.doc_type_id
        where dt.key = any(${sql.val([...held.keys()])}::text[])
          and v.id in (select distinct workflow_version_id from app.wf_instance where status = 'running')`.execute(tx);
      for (const v of versions.rows) {
        const def = parseDefinition(v.definition);
        defs.set(v.id, def);
        const stages = held.get(v.key)!;
        const scope = scopeCondition(sql.ref('loc.path'), this.scope.nodeFilter(perms, docTab(v.key)));
        for (const s of def.stages) {
          if (!stages.has(s.key)) continue;
          const actor = this.actorSql(s.actors, userId, roleIds);
          if (!actor) continue;
          const self = s.allowSelfApproval ? sql<boolean>`true` : sql<boolean>`d.submitted_by is distinct from ${userId}::uuid`;
          rules.push(sql<boolean>`(i.workflow_version_id = ${v.id} and ss.stage_key = ${s.key} and ${actor} and ${self} and ${scope})`);
        }
      }
    }
    const ruleSql = rules.length ? sql<boolean>`(${sql.join(rules, sql` or `)})` : sql<boolean>`false`;
    const rule = sql<boolean>`(not d.is_deleted and ${ruleSql})`;
    // With `workflow.block_self_approval` (QA3-BUG-004) an assignment of the submitter is not actionable for them.
    const blockSelf = await getTenantSetting(tx, 'workflow.block_self_approval');
    const assigned = sql<boolean>`exists (select 1 from app.wf_assignment a where a.instance_id = ss.instance_id and a.stage_key = ss.stage_key
      and a.user_id = ${userId} and a.is_active and (${sql.lit(!blockSelf)} or d.submitted_by is distinct from ${userId}::uuid or exists (
        select 1 from app.workflow_version v where v.id = i.workflow_version_id
          and v.definition -> 'stages' @> jsonb_build_array(jsonb_build_object('key', a.stage_key, 'allowSelfApproval', true)))))`;
    return { rule, assigned, defs };
  }

  /** Actor rules as SQL for one caller; null when no rule can match (pair dropped). */
  private actorSql(actors: Def['stages'][number]['actors'], userId: string, roleIds: string[]): RawBuilder<boolean> | null {
    if (!actors.length) return sql<boolean>`true`;
    const parts: RawBuilder<boolean>[] = [];
    for (const a of actors) {
      if (a.type === 'role' && roleIds.includes(a.roleId)) return sql<boolean>`true`;
      if (a.type === 'users' && a.userIds.includes(userId)) return sql<boolean>`true`;
      if (a.type === 'reporting_manager') parts.push(sql<boolean>`exists (select 1 from app.tenant_user su where su.id = d.submitted_by and su.reporting_manager_id = ${userId})`);
      if (a.type === 'field') parts.push(sql<boolean>`(d.custom ->> ${a.field}) = ${userId}`);
    }
    return parts.length ? sql<boolean>`(${sql.join(parts, sql` or `)})` : null;
  }

  async list(tx: Tx, userId: string, perms: MyPermissions | undefined, q: InboxQuery) {
    const { rule, assigned, defs } = await this.base(tx, userId, perms);
    const cur = decodeCursor(q.cursor);
    const now = new Date();
    const filters: RawBuilder<boolean>[] = [sql<boolean>`true`];
    if (q.stage) filters.push(sql<boolean>`ss.stage_key = ${q.stage}`);
    if (q.overdue) filters.push(sql<boolean>`ss.due_at < ${now}`);
    if (cur) filters.push(sql<boolean>`(ss.entered_at, ss.instance_id::text || ':' || ss.stage_key) < (${cur.t}::timestamptz, ${cur.id})`);
    const docType = q.docType ? sql<boolean>`d.doc_type_id = (select t.id from app.doc_type t where t.key = ${q.docType})` : sql<boolean>`true`;
    // QA3-BUG-018: one page walks active stages newest-first (wf_stage_state_active) and checks "may I act" per row
    // (OFFSET 0 keeps it a per-row check instead of a join over every waiting document); details for the page only.
    const page = await sql<{ instance_id: string; stage_key: string }>`
      select ss.instance_id, ss.stage_key from app.wf_stage_state ss
      where ss.status = 'active' and ${sql.join(filters, sql` and `)}
        and exists (select 1 from app.wf_instance i join app.document d on d.id = i.document_id join app.location_node loc on loc.id = d.location_node_id
          where i.id = ss.instance_id and i.status = 'running' and ${docType} and (${rule} or ${assigned}) offset 0)
      order by ss.entered_at desc, ss.instance_id::text || ':' || ss.stage_key desc
      limit ${q.limit + 1}`.execute(tx);
    const keys = page.rows.map(r => `${r.instance_id}:${r.stage_key}`);
    const rows = keys.length ? await sql<Row>`
      select ss.instance_id, ss.stage_key, case when ${rule} then 'rule' else (select min(a.reason) from app.wf_assignment a
          where a.instance_id = ss.instance_id and a.stage_key = ss.stage_key and a.user_id = ${userId} and a.is_active) end as because,
        ss.entered_at, ss.due_at, i.document_id, i.workflow_version_id,
        d.number, d.status_key, d.submitted_at, d.total_amount, dt.key as doc_type_key, dt.name as doc_type_name,
        loc.name as location_name, su.name as submitted_by_name, ss.instance_id::text || ':' || ss.stage_key as sort_id,
        (select count(*) from app.wf_line_state ls where ls.instance_id = ss.instance_id and ls.stage_key = ss.stage_key and ls.pending_qty > 0) as pending_lines,
        (select count(*) from app.wf_line_state ls where ls.instance_id = ss.instance_id and ls.stage_key = ss.stage_key and ls.held_qty > 0) as held_lines
      from app.wf_stage_state ss
      join app.wf_instance i on i.id = ss.instance_id
      join app.document d on d.id = i.document_id
      join app.doc_type dt on dt.id = d.doc_type_id
      join app.location_node loc on loc.id = d.location_node_id
      left join app.tenant_user su on su.id = d.submitted_by
      where ss.instance_id::text || ':' || ss.stage_key = any(${sql.val(keys)}::text[])
        and ss.instance_id = any(${sql.val([...new Set(page.rows.map(r => r.instance_id))])}::uuid[])
      order by ss.entered_at desc, sort_id desc`.execute(tx) : { rows: [] as Row[] };
    const missing = rows.rows.map(r => r.workflow_version_id).filter(v => !defs.has(v));
    if (missing.length) {
      const extra = await tx.selectFrom('app.workflow_version').select(['id', 'definition']).where('id', 'in', [...new Set(missing)]).execute();
      for (const e of extra) defs.set(e.id, parseDefinition(e.definition));
    }
    return toPage(rows.rows, q.limit, r => ({ t: r.entered_at, id: r.sort_id }), (r): InboxItem => {
      const def = defs.get(r.workflow_version_id);
      const stage = def?.stages.find(s => s.key === r.stage_key);
      const waiting = r.status_key.startsWith('waiting_') ? def?.stages.find(s => `waiting_${s.key}` === r.status_key) : undefined;
      return {
        documentId: r.document_id, docTypeKey: r.doc_type_key, docTypeName: r.doc_type_name, number: r.number,
        statusLabel: waiting ? statusLabelOf(waiting) : FIXED_STATUS_LABELS[r.status_key] ?? r.status_key,
        stageKey: r.stage_key, stageName: stage?.name ?? r.stage_key, location: r.location_name,
        submittedBy: r.submitted_by_name, submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
        totalAmount: r.total_amount, pendingLines: Number(r.pending_lines), heldLines: Number(r.held_lines),
        dueAt: r.due_at ? new Date(r.due_at).toISOString() : null, overdue: !!r.due_at && new Date(r.due_at) < now,
        assignedBecause: r.because,
      };
    });
  }

  async counts(tx: Tx, userId: string, perms: MyPermissions | undefined): Promise<InboxCounts> {
    const { rule, assigned, defs } = await this.base(tx, userId, perms);
    const now = new Date();
    // Rule matches and assignments as two plain index-driven sets (an OR across them defeats the scope push-down),
    // de-duplicated per stage row, with no re-joins afterwards (QA3-BUG-018).
    const rows = await sql<{ key: string; name: string; stage_key: string; version_id: string; n: string; overdue: string }>`
      with x as (
        select ss.instance_id, ss.stage_key, ss.due_at, d.doc_type_id, i.workflow_version_id
        from app.wf_stage_state ss
        join app.wf_instance i on i.id = ss.instance_id and i.status = 'running'
        join app.document d on d.id = i.document_id
        join app.location_node loc on loc.id = d.location_node_id
        where ss.status = 'active' and ${rule}
        union
        select ss.instance_id, ss.stage_key, ss.due_at, d.doc_type_id, i.workflow_version_id
        from app.wf_assignment a
        join app.wf_stage_state ss on ss.instance_id = a.instance_id and ss.stage_key = a.stage_key and ss.status = 'active'
        join app.wf_instance i on i.id = ss.instance_id and i.status = 'running'
        join app.document d on d.id = i.document_id
        where a.user_id = ${userId} and a.is_active and ${assigned}
      )
      select dt.key, dt.name, x.stage_key, max(x.workflow_version_id::text) as version_id, count(*) as n,
        count(*) filter (where x.due_at < ${now}) as overdue
      from x join app.doc_type dt on dt.id = x.doc_type_id
      group by dt.key, dt.name, x.stage_key
      order by dt.name, x.stage_key`.execute(tx);
    const missing = rows.rows.map(r => r.version_id).filter(v => !defs.has(v));
    if (missing.length) {
      const extra = await tx.selectFrom('app.workflow_version').select(['id', 'definition']).where('id', 'in', [...new Set(missing)]).execute();
      for (const e of extra) defs.set(e.id, parseDefinition(e.definition));
    }
    const byType = rows.rows.map(r => ({
      docTypeKey: r.key, name: r.name, stageKey: r.stage_key,
      stageName: defs.get(r.version_id)?.stages.find(s => s.key === r.stage_key)?.name ?? r.stage_key,
      count: Number(r.n), overdue: Number(r.overdue),
    }));
    return { total: byType.reduce((a, b) => a + b.count, 0), overdue: byType.reduce((a, b) => a + b.overdue, 0), byType };
  }
}

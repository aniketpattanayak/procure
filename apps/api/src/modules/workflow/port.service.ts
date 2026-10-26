import { Injectable } from '@nestjs/common';
import type { MyPermissions, WorkflowRuntimeView } from '@procure/schema';
import type { Tx } from '../../core/db.service';
import type { WorkflowPort } from '../../core/ports';
import { getTenantSetting } from '../identity';
import { ActorDoc, ActorsService } from './actors.service';
import { DefinitionsService } from './definitions.service';
import { DocsPortRef } from './docs-port';
import { EngineService } from './engine.service';
import { fmt, D, statusLabelOf } from './model';

const toIso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());

/** WorkflowPort (core/ports.ts) for the documents module. */
@Injectable()
export class WorkflowPortService implements WorkflowPort {
  constructor(
    private readonly engine: EngineService,
    private readonly defs: DefinitionsService,
    private readonly actors: ActorsService,
    private readonly docs: DocsPortRef,
  ) {}

  start(tx: Tx, documentId: string, actorId: string) { return this.engine.start(tx, documentId, actorId); }
  cancel(tx: Tx, documentId: string, reason: string, actorId: string | null) { return this.engine.cancel(tx, documentId, reason, actorId); }
  linesCancelled(tx: Tx, documentId: string, lineIds: string[]) { return this.engine.linesCancelled(tx, documentId, lineIds); }

  async lineStages(tx: Tx, documentId: string): Promise<Record<string, Record<string, { pending: string; held: string }>>> {
    const rows = await tx.selectFrom('app.wf_line_state as s').innerJoin('app.wf_instance as i', 'i.id', 's.instance_id')
      .select(['s.line_id', 's.stage_key', 's.pending_qty', 's.held_qty'])
      .where('i.document_id', '=', documentId).where('i.status', '=', 'running').execute();
    const out: Record<string, Record<string, { pending: string; held: string }>> = {};
    for (const r of rows) {
      if (D(r.pending_qty).isZero() && D(r.held_qty).isZero()) continue;
      (out[r.line_id] ??= {})[r.stage_key] = { pending: fmt(D(r.pending_qty)), held: fmt(D(r.held_qty)) };
    }
    return out;
  }

  async statusKeys(tx: Tx, docTypeId: string): Promise<{ key: string; label: string }[]> {
    const r = await tx.selectFrom('app.workflow_def as w').innerJoin('app.workflow_version as v', 'v.id', 'w.current_version_id')
      .select('v.id').where('w.doc_type_id', '=', docTypeId).executeTakeFirst();
    if (!r) return [];
    const ver = await this.defs.versionById(tx, r.id);
    return ver.definition.stages.map(s => ({ key: `waiting_${s.key}`, label: statusLabelOf(s) }));
  }

  async runtimeView(tx: Tx, documentId: string, viewer: { userId: string; permissions: string[] }): Promise<WorkflowRuntimeView | null> {
    const inst = await tx.selectFrom('app.wf_instance').select(['id', 'workflow_version_id', 'status'])
      .where('document_id', '=', documentId).orderBy('started_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (!inst) return null;
    const ver = await this.defs.versionById(tx, inst.workflow_version_id);
    const states = await tx.selectFrom('app.wf_stage_state').selectAll().where('instance_id', '=', inst.id).execute();
    const byKey = new Map(states.map(s => [s.stage_key, s]));
    const snap = await this.docs.get().snapshot(tx, documentId, { lock: false });
    const doc: ActorDoc = { docTypeKey: snap.docTypeKey, locationPath: snap.locationPath, submittedBy: snap.submittedBy, values: snap.values };
    const assignments = await tx.selectFrom('app.wf_assignment as a').innerJoin('app.tenant_user as u', 'u.id', 'a.user_id')
      .select(['a.stage_key', 'a.user_id', 'u.name']).where('a.instance_id', '=', inst.id).where('a.is_active', '=', true).execute();
    // The viewer could open the document, so the location is in their scope; check keys + rules here.
    const perms: MyPermissions = { keys: viewer.permissions, scope: { allNodes: true, nodeIds: [] }, fieldAccess: {}, version: 0 };
    const roleIds = await this.actors.roleIdsOf(tx, viewer.userId);
    const now = Date.now();
    let blockSelf: boolean | undefined;
    const stages: WorkflowRuntimeView['stages'] = [];
    for (const s of ver.definition.stages) {
      const st = byKey.get(s.key);
      const status = st?.status ?? (s.enabled ? 'pending' : 'disabled');
      const active = inst.status === 'running' && status === 'active';
      let canAct = false;
      let actors: string[];
      if (active) {
        const assigned = assignments.filter(a => a.stage_key === s.key);
        // Segregation of duties (QA3-BUG-004): the submitter never acts unless the stage allows self-approval.
        const self = !s.allowSelfApproval && doc.submittedBy === viewer.userId && (blockSelf ??= await getTenantSetting(tx, 'workflow.block_self_approval'));
        canAct = !self && (assigned.some(a => a.user_id === viewer.userId)
          || (await this.actors.callerMatches(tx, { userId: viewer.userId, perms, roleIds }, s, doc)).ok);
        const eligible = await this.actors.eligibleUsers(tx, snap.tenantId, s, doc, { limit: 20 });
        actors = [...new Set([...eligible.map(u => u.name), ...assigned.map(a => a.name)])];
      } else {
        actors = await this.actors.describe(tx, s.actors);
      }
      stages.push({
        key: s.key, name: s.name, status, skipReason: st?.skip_reason ?? null,
        enteredAt: toIso(st?.entered_at), dueAt: toIso(st?.due_at), completedAt: toIso(st?.completed_at),
        overdue: active && !!st?.due_at && new Date(st.due_at).getTime() < now,
        canAct, actors,
      });
    }
    return {
      instanceId: inst.id, workflowVersion: ver.version, status: inst.status, stages,
      stageActions: Object.fromEntries(ver.definition.stages.map(s => [s.key, [...s.actions]])),
      granularity: ver.definition.granularity,
      editableLineFields: Object.fromEntries(ver.definition.stages.map(s => [s.key, [...s.editableLineFields]])),
      requireReasonOn: Object.fromEntries(ver.definition.stages.map(s => [s.key, [...s.requireReasonOn]])),
    };
  }
}

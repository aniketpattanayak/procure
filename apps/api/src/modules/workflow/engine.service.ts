import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Effect, LineDecision, MyPermissions, WorkflowActionInput } from '@procure/schema';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { DocumentSnapshot, EFFECT_REGISTRY, EffectRegistry, LedgerEvent } from '../../core/ports';
import { tenantToday } from '../forms';
import { getTenantSetting } from '../identity';
import { ActorDoc, ActorsService, Caller, FAN_OUT_CAP } from './actors.service';
import { DefinitionsService, evaluateWhen } from './definitions.service';
import { DocsPortRef } from './docs-port';
import {
  AppliedDecision, cell, clearLine, D, Def, drainGroup, hasQty, enter, fmt, Group, groupIndexOf, groupQty, groupsOf, heldMeasure, inWorkflow, LineQty,
  mergeVotes, releasable, removeFromSiblings, StageDef, statusLabelOf, ZERO,
} from './model';

type StageStatus = 'pending' | 'active' | 'done' | 'skipped' | 'disabled';
/** skip_reason of an active/done stage that runs only for quantity routed to it (its own condition was false). */
export const ROUTE_ONLY = 'route_only';
interface StageRow {
  stage_key: string; status: StageStatus; skip_reason: string | null; entered_at: Date | null; due_at: Date | null;
  next_reminder_at: Date | null; reminders_sent: number; escalated_at: Date | null; completed_at: Date | null;
}
interface QueuedEffect { effect: Effect; stageKey: string | null; approved?: { lineId: string; qty: string }[]; rejected?: { lineId: string; qty: string }[] }

/** In-memory state of one instance during one action (one transaction). */
interface State {
  tenantId: string;
  snap: DocumentSnapshot;
  doc: ActorDoc;
  instanceId: string;
  versionId: string;
  def: Def;
  groups: Group[];
  stageDefs: Map<string, StageDef>;
  stages: Map<string, StageRow>;
  dirtyStages: Set<string>;
  lines: Map<string, LineQty>;
  heldBefore: Map<string, Decimal>;
  touchedLines: Set<string>;
  ledger: LedgerEvent[];
  effects: QueuedEffect[];
  /** Stage activation outcome memo within this action. */
  activated: Map<string, boolean>;
  now: Date;
  actorId: string | null;
}

export interface ActionResult { documentId: string; replay: boolean }

const isTrue = (v: Decimal) => v.gt(0);
const link = (s: DocumentSnapshot) => `/docs/${s.docTypeKey}/${s.id}`;
const docLabel = (s: DocumentSnapshot) => s.number ?? 'a draft document';

/**
 * The workflow runtime (contract §Workflow engine rules). One transaction per action: document row FOR UPDATE
 * first (DocumentsPort.snapshot), then wf_line_state rows in line-id order. Quantity arithmetic is decimal-exact.
 */
@Injectable()
export class EngineService {
  private readonly log = new Logger('Workflow');
  constructor(
    private readonly docs: DocsPortRef,
    private readonly defs: DefinitionsService,
    private readonly actors: ActorsService,
    @Inject(EFFECT_REGISTRY) private readonly registry: EffectRegistry,
  ) {}

  // =========================================================================================== loading

  private async load(tx: Tx, documentId: string, opts: { requireRunning: boolean; snap?: DocumentSnapshot; actorId: string | null }): Promise<State | null> {
    const port = this.docs.get();
    const snap = opts.snap ?? await port.snapshot(tx, documentId, { lock: true });
    const inst = await tx.selectFrom('app.wf_instance').select(['id', 'workflow_version_id'])
      .where('document_id', '=', documentId).where('status', '=', 'running').executeTakeFirst();
    if (!inst) {
      if (opts.requireRunning) throw new AppError(409, 'WORKFLOW_NOT_RUNNING', 'This document is not waiting for approval.');
      return null;
    }
    const ver = await this.defs.versionById(tx, inst.workflow_version_id);
    const stageRows = await tx.selectFrom('app.wf_stage_state')
      .select(['stage_key', 'status', 'skip_reason', 'entered_at', 'due_at', 'next_reminder_at', 'reminders_sent', 'escalated_at', 'completed_at'])
      .where('instance_id', '=', inst.id).forUpdate().execute();
    const lineRows = await sql<{ line_id: string; stage_key: string; pending_qty: string; held_qty: string }>`
      select line_id, stage_key, pending_qty, held_qty from app.wf_line_state where instance_id = ${inst.id}
      order by line_id, stage_key for update`.execute(tx);
    const st = this.newState(snap, inst.id, inst.workflow_version_id, ver.definition, opts.actorId);
    for (const r of stageRows) st.stages.set(r.stage_key, r as StageRow);
    for (const r of lineRows.rows) {
      const l = this.lineOf(st, r.line_id);
      l.set(r.stage_key, { p: D(r.pending_qty), h: D(r.held_qty) });
    }
    for (const [id, l] of st.lines) st.heldBefore.set(id, heldMeasure(l, st.groups));
    return st;
  }

  private newState(snap: DocumentSnapshot, instanceId: string, versionId: string, def: Def, actorId: string | null): State {
    return {
      tenantId: snap.tenantId, snap,
      doc: { docTypeKey: snap.docTypeKey, locationPath: snap.locationPath, submittedBy: snap.submittedBy, values: snap.values },
      instanceId, versionId, def, groups: groupsOf(def.stages), stageDefs: new Map(def.stages.map(s => [s.key, s])),
      stages: new Map(), dirtyStages: new Set(), lines: new Map(), heldBefore: new Map(), touchedLines: new Set(),
      ledger: [], effects: [], activated: new Map(), now: new Date(), actorId,
    };
  }

  private lineOf(st: State, lineId: string): LineQty {
    let l = st.lines.get(lineId);
    if (!l) { l = new Map(); st.lines.set(lineId, l); st.heldBefore.set(lineId, ZERO); }
    return l;
  }

  private stageRow(st: State, key: string): StageRow {
    let r = st.stages.get(key);
    if (!r) {
      r = { stage_key: key, status: 'pending', skip_reason: null, entered_at: null, due_at: null, next_reminder_at: null, reminders_sent: 0, escalated_at: null, completed_at: null };
      st.stages.set(key, r);
      st.dirtyStages.add(key);
    }
    return r;
  }

  private patchStage(st: State, key: string, patch: Partial<StageRow>) {
    Object.assign(this.stageRow(st, key), patch);
    st.dirtyStages.add(key);
  }

  // =========================================================================================== start

  async start(tx: Tx, documentId: string, actorId: string): Promise<void> {
    const port = this.docs.get();
    const snap = await port.snapshot(tx, documentId, { lock: true });
    const running = await tx.selectFrom('app.wf_instance').select('id').where('document_id', '=', documentId).where('status', '=', 'running').executeTakeFirst();
    if (running) throw AppError.conflict('This document is already in approval.');
    const dt = await this.defs.docTypeById(tx, snap.docTypeId);
    const ver = await this.defs.currentVersion(tx, snap.tenantId, dt, actorId);
    const inst = await tx.insertInto('app.wf_instance').values({
      tenant_id: snap.tenantId, document_id: documentId, workflow_version_id: ver.id, status: 'running', started_by: actorId,
    }).returning('id').executeTakeFirstOrThrow();
    const st = this.newState(snap, inst.id, ver.id, ver.definition, actorId);

    // Routing: conditions are evaluated once, at submit, on header values + `lines` rows.
    const today = await tenantToday(tx);
    const lineValues = snap.lines.filter(l => !l.isCancelled).map(l => ({ ...l.values, qty: l.values.qty ?? l.qty }));
    for (const s of st.def.stages) {
      if (!s.enabled) { this.patchStage(st, s.key, { status: 'disabled', skip_reason: 'stage_disabled' }); continue; }
      const w = evaluateWhen(s, { values: snap.values, lines: lineValues, lookups: snap.lookups, today });
      if (w.error) this.log.warn(`stage ${s.key} condition failed on document ${documentId}: ${w.error}; stage runs`);
      this.patchStage(st, s.key, w.run ? { status: 'pending' } : { status: 'skipped', skip_reason: 'condition_false' });
    }
    const submitId = await this.insertAction(tx, st, { stageKey: '_start', action: 'submit', actorId });
    st.effects.push(...st.def.onSubmit.map(effect => ({ effect, stageKey: null })));
    for (const l of snap.lines) {
      if (l.isCancelled || !D(l.qty).gt(0)) continue;
      this.lineOf(st, l.id);
      await this.forward(tx, st, -1, l.id, D(l.qty), null);
    }
    let actionId = submitId;
    if (st.ledger.some(e => e.type === 'approved') && !this.anyQty(st)) {
      actionId = await this.insertAction(tx, st, { stageKey: '_start', action: 'auto_approve', actorId: null, comment: 'No approval stage applies' });
    }
    await this.flush(tx, st, actionId);
    await this.finishAction(tx, st, actionId);
  }

  // =========================================================================================== routing

  private anyQty(st: State): boolean {
    for (const l of st.lines.values()) for (const c of l.values()) if (isTrue(c.p) || isTrue(c.h)) return true;
    return false;
  }

  /**
   * Moves `qty` of a line that left group `fromGroup` into the next group with a participating stage, or out of the
   * workflow (ledger `approved`) after the last group.
   */
  private async forward(tx: Tx, st: State, fromGroup: number, lineId: string, qty: Decimal, fromStage: string | null) {
    if (!qty.gt(0)) return;
    st.touchedLines.add(lineId);
    for (let gi = fromGroup + 1; gi < st.groups.length; gi++) {
      const parts = await this.participants(tx, st, st.groups[gi]!);
      if (parts.length) { enter(this.lineOf(st, lineId), parts, qty); return; }
    }
    st.ledger.push({ lineId, type: 'approved', qty: fmt(qty), stageKey: fromStage });
  }

  /** Stages of a group that take quantity now (activating them; no-actor handling per stage). */
  private async participants(tx: Tx, st: State, g: Group, force?: string): Promise<string[]> {
    const out: string[] = [];
    for (const key of g.stages) {
      const row = this.stageRow(st, key);
      // Phase 5: a stage whose condition was false and that only took quantity through `route_to` stays route-only
      // (skip_reason ROUTE_ONLY): normal onward flow never enters it.
      const routeOnly = row.skip_reason === ROUTE_ONLY || (row.status === 'skipped' && row.skip_reason === 'condition_false');
      const runnable = key === force || ((row.status === 'pending' || row.status === 'active' || row.status === 'done') && row.skip_reason !== ROUTE_ONLY)
        || (row.status === 'skipped' && row.skip_reason === 'no_actor');
      if (!runnable) continue;
      if (await this.activate(tx, st, key, key === force && routeOnly)) out.push(key);
    }
    return out;
  }

  /** Activates a stage (once per action). Returns false when it is skipped for lack of actors. */
  private async activate(tx: Tx, st: State, key: string, routeOnly = false): Promise<boolean> {
    const memo = st.activated.get(key);
    if (memo !== undefined) return memo;
    const row = this.stageRow(st, key);
    if (row.status === 'active') { st.activated.set(key, true); return true; }
    const s = st.stageDefs.get(key)!;
    let notify = await this.actors.eligibleUsers(tx, st.tenantId, s, st.doc);
    if (!notify.length) {
      if (s.ifNoActor === 'skip') {
        this.patchStage(st, key, { status: 'skipped', skip_reason: 'no_actor', entered_at: null, due_at: null, next_reminder_at: null });
        await this.insertAction(tx, st, { stageKey: key, action: 'auto_skip', actorId: null, comment: 'Nobody can act on this stage' });
        st.activated.set(key, false);
        return false;
      }
      const admins = await this.actors.activeAdmins(tx);
      // Other admins first; a lone admin who submitted is still assigned (the stage is never orphaned) but, with
      // `workflow.block_self_approval`, cannot act on it (QA3-BUG-004).
      const others = admins.filter(a => a.id !== st.snap.submittedBy || s.allowSelfApproval);
      notify = others.length ? others : admins;
      await this.assign(tx, st, key, notify.map(a => a.id), 'escalation', null);
    }
    const sla = s.sla;
    this.patchStage(st, key, {
      status: 'active', skip_reason: routeOnly ? ROUTE_ONLY : null, entered_at: st.now, completed_at: null, escalated_at: null, reminders_sent: 0,
      due_at: sla ? new Date(st.now.getTime() + sla.hours * 3600_000) : null,
      next_reminder_at: sla?.remindEveryHours ? new Date(st.now.getTime() + sla.remindEveryHours * 3600_000) : null,
    });
    st.activated.set(key, true);
    await this.notify(tx, st, notify.map(u => u.id), 'approval_pending', `${docLabel(st.snap)} is waiting for ${s.name}`, null, { stageKey: key });
    await this.docs.get().emit(tx, 'workflow.stage_entered', { kind: 'document', id: st.snap.id }, { documentId: st.snap.id, docType: st.snap.docTypeKey, stageKey: key, instanceId: st.instanceId });
    st.effects.push(...s.effects.onEnter.map(effect => ({ effect, stageKey: key })));
    return true;
  }

  private async assign(tx: Tx, st: State, stageKey: string, userIds: string[], reason: 'forward' | 'escalation', by: string | null) {
    const existing = await tx.selectFrom('app.wf_assignment').select('user_id').where('instance_id', '=', st.instanceId)
      .where('stage_key', '=', stageKey).where('is_active', '=', true).execute();
    const have = new Set(existing.map(e => e.user_id));
    const add = [...new Set(userIds)].filter(u => !have.has(u));
    if (add.length) {
      await tx.insertInto('app.wf_assignment').values(add.map(user_id => ({
        tenant_id: st.tenantId, instance_id: st.instanceId, stage_key: stageKey, user_id, reason, created_by: by,
      }))).execute();
    }
  }

  // =========================================================================================== persistence

  private async insertAction(tx: Tx, st: State, a: {
    stageKey: string; action: string; actorId: string | null; onBehalfOf?: string | null; comment?: string | null;
    decisions?: AppliedDecision[]; targetStage?: string | null; targetUserId?: string | null; idempotencyKey?: string | null;
  }): Promise<string> {
    const r = await tx.insertInto('app.wf_action').values({
      tenant_id: st.tenantId, instance_id: st.instanceId, document_id: st.snap.id, stage_key: a.stageKey, action: a.action,
      actor_id: a.actorId, on_behalf_of: a.onBehalfOf ?? null, comment: a.comment ?? null, decisions: JSON.stringify(a.decisions ?? []),
      target_stage: a.targetStage ?? null, target_user_id: a.targetUserId ?? null, idempotency_key: a.idempotencyKey ?? null, at: st.now,
    }).returning('id').executeTakeFirstOrThrow();
    return r.id;
  }

  /** Writes line/stage state, held/unheld deltas + queued ledger events, stage completion. */
  private async flush(tx: Tx, st: State, actionId: string) {
    // Line state: upsert non-zero cells, delete empty ones.
    const upserts: { line_id: string; stage_key: string; pending_qty: string; held_qty: string }[] = [];
    const deletes: { line: string; stage: string }[] = [];
    for (const [lineId, l] of st.lines) {
      for (const [stage, c] of l) {
        if (c.p.lt(0) || c.h.lt(0)) throw new Error(`negative workflow qty on ${lineId}/${stage}`);
        if (c.p.isZero() && c.h.isZero()) deletes.push({ line: lineId, stage });
        else upserts.push({ line_id: lineId, stage_key: stage, pending_qty: fmt(c.p), held_qty: fmt(c.h) });
      }
    }
    for (const d of deletes) {
      await tx.deleteFrom('app.wf_line_state').where('instance_id', '=', st.instanceId).where('line_id', '=', d.line).where('stage_key', '=', d.stage).execute();
      st.lines.get(d.line)!.delete(d.stage);
    }
    if (upserts.length) {
      await tx.insertInto('app.wf_line_state').values(upserts.map(u => ({ ...u, tenant_id: st.tenantId, instance_id: st.instanceId, updated_at: st.now })))
        .onConflict(oc => oc.columns(['tenant_id', 'instance_id', 'line_id', 'stage_key']).doUpdateSet(eb => ({
          pending_qty: eb.ref('excluded.pending_qty'), held_qty: eb.ref('excluded.held_qty'), updated_at: eb.ref('excluded.updated_at'),
        }))).execute();
    }

    // Stages with nothing left are done.
    const holding = new Set<string>();
    for (const l of st.lines.values()) for (const [s, c] of l) if (isTrue(c.p) || isTrue(c.h)) holding.add(s);
    for (const [key, row] of st.stages) {
      if (row.status === 'active' && !holding.has(key)) {
        this.patchStage(st, key, { status: 'done', completed_at: st.now, next_reminder_at: null });
        await tx.updateTable('app.wf_assignment').set({ is_active: false }).where('instance_id', '=', st.instanceId).where('stage_key', '=', key).where('is_active', '=', true).execute();
      }
    }
    for (const key of st.dirtyStages) {
      const r = st.stages.get(key)!;
      const vals = {
        status: r.status, skip_reason: r.skip_reason, entered_at: r.entered_at, due_at: r.due_at, next_reminder_at: r.next_reminder_at,
        reminders_sent: r.reminders_sent, escalated_at: r.escalated_at, completed_at: r.completed_at,
      };
      await tx.insertInto('app.wf_stage_state').values({ tenant_id: st.tenantId, instance_id: st.instanceId, stage_key: key, ...vals })
        .onConflict(oc => oc.columns(['tenant_id', 'instance_id', 'stage_key']).doUpdateSet(vals)).execute();
    }
    st.dirtyStages.clear();

    // Ledger: held/unheld deltas first, then queued events (rejected/approved/cancelled), per line in id order.
    const events: LedgerEvent[] = [];
    for (const lineId of [...st.lines.keys()].sort()) {
      const before = st.heldBefore.get(lineId) ?? ZERO;
      const after = heldMeasure(st.lines.get(lineId)!, st.groups);
      const delta = after.minus(before);
      if (delta.gt(0)) events.push({ lineId, type: 'held', qty: fmt(delta) });
      if (delta.lt(0)) events.push({ lineId, type: 'unheld', qty: fmt(delta.neg()) });
      st.heldBefore.set(lineId, after);
    }
    events.push(...st.ledger);
    st.ledger = [];
    const withAction = events.map(e => ({ ...e, wfActionId: actionId, reason: e.reason ?? null, stageKey: e.stageKey ?? null }));
    if (withAction.length) await this.docs.get().recordQuantities(tx, st.snap.id, withAction, st.actorId);
  }

  /** Effects, completion, status recompute, document version bump. */
  private async finishAction(tx: Tx, st: State, actionId: string) {
    await this.runEffects(tx, st, actionId);
    if (!this.anyQty(st)) await this.complete(tx, st);
    const port = this.docs.get();
    // Every workflow action bumps the document version (touch trigger) so If-Match detects concurrent decisions.
    await tx.updateTable('app.document').set({ updated_by: st.actorId }).where('id', '=', st.snap.id).execute();
    await port.recomputeStatus(tx, st.snap.id);
    await this.defs.cleanupRetired(tx, st.tenantId, st.snap.docTypeId);
  }

  private async runEffects(tx: Tx, st: State, actionId: string) {
    while (st.effects.length) {
      const q = st.effects.shift()!;
      if (q.effect.effect === 'route_to') continue; // executed inline by the engine (rejected qty routing)
      await this.registry.run(q.effect, {
        tx, tenantId: st.tenantId, documentId: st.snap.id, stageKey: q.stageKey, wfActionId: actionId, actorId: st.actorId,
        approved: q.approved, rejected: q.rejected,
      });
    }
  }

  private async complete(tx: Tx, st: State) {
    const r = await tx.updateTable('app.wf_instance').set({ status: 'completed', completed_at: st.now })
      .where('id', '=', st.instanceId).where('status', '=', 'running').executeTakeFirst();
    if (!Number(r.numUpdatedRows)) return;
    const id = await this.insertAction(tx, st, { stageKey: '_end', action: 'complete', actorId: null });
    st.effects.push(...st.def.onComplete.map(effect => ({ effect, stageKey: null })));
    await this.runEffects(tx, st, id);
    await this.docs.get().emit(tx, 'workflow.completed', { kind: 'document', id: st.snap.id }, { documentId: st.snap.id, docType: st.snap.docTypeKey, instanceId: st.instanceId });
  }

  async notify(tx: Tx, st: { tenantId: string; snap: DocumentSnapshot }, userIds: string[], kind: string, title: string, body: string | null, data: Record<string, unknown>) {
    const ids = [...new Set(userIds)].slice(0, FAN_OUT_CAP);
    if (!ids.length) return;
    await tx.insertInto('app.notification').values(ids.map(user_id => ({
      tenant_id: st.tenantId, user_id, kind, title: title.slice(0, 300), body, link: link(st.snap),
      data: JSON.stringify({ documentId: st.snap.id, docType: st.snap.docTypeKey, ...data }),
    }))).execute();
  }

  // =========================================================================================== actions

  /**
   * POST /docs/:type/:id/actions. Authorises at action time, applies the action, returns the document id.
   * `caller.perms` are the request's resolved permissions (keys + scopes).
   */
  async act(tx: Tx, docTypeKey: string, documentId: string, input: WorkflowActionInput, caller: { userId: string; perms: MyPermissions | undefined },
    opts: { ifMatch?: number; idempotencyKey?: string }): Promise<ActionResult> {
    const port = this.docs.get();
    let snap: DocumentSnapshot;
    try {
      snap = await port.snapshot(tx, documentId, { lock: true });
    } catch (e) {
      if (e instanceof AppError && e.status === 404) throw AppError.notFound('Document');
      throw e;
    }
    if (snap.docTypeKey !== docTypeKey) throw AppError.notFound('Document');
    if (!this.actors.inScope(caller.perms, { docTypeKey, locationPath: snap.locationPath })) {
      // An explicit assignment (forward / escalation) is a grant for this document even outside the caller's scope.
      const asg = await tx.selectFrom('app.wf_assignment as a').innerJoin('app.wf_instance as i', 'i.id', 'a.instance_id')
        .select('a.id').where('i.document_id', '=', documentId).where('i.status', '=', 'running')
        .where('a.user_id', '=', caller.userId).where('a.is_active', '=', true).executeTakeFirst();
      if (!asg) throw AppError.notFound('Document');
    }

    if (opts.idempotencyKey) {
      const prev = await tx.selectFrom('app.wf_action').select(['document_id', 'actor_id']).where('idempotency_key', '=', opts.idempotencyKey).executeTakeFirst();
      if (prev) {
        if (prev.document_id !== documentId) throw AppError.conflict('This Idempotency-Key was already used for another document.');
        // QA3-BUG-005: a replay is only the original caller's; anyone else presenting the key is refused.
        if (prev.actor_id !== caller.userId) throw AppError.forbidden('This Idempotency-Key belongs to another request.');
        return { documentId, replay: true };
      }
    }
    if (opts.ifMatch !== undefined && opts.ifMatch !== snap.version) throw AppError.versionConflict();

    const st = (await this.load(tx, documentId, { requireRunning: true, snap, actorId: caller.userId }))!;
    const stage = st.stageDefs.get(input.stageKey);
    if (!stage) throw AppError.notFound('Stage');
    const row = st.stages.get(stage.key);
    if (row?.status !== 'active') throw new AppError(409, 'STAGE_NOT_ACTIVE', `"${stage.name}" is not waiting for action on this document.`);

    // Authorisation: rule-based, or an active assignment (forward / escalation).
    const roleIds = await this.actors.roleIdsOf(tx, caller.userId);
    const who: Caller = { userId: caller.userId, perms: caller.perms, roleIds };
    const rule = await this.actors.callerMatches(tx, who, stage, st.doc);
    let onBehalfOf: string | null = null;
    if (rule.reason === 'self' && !(await this.assignedTo(tx, st, stage.key, caller.userId))) {
      throw AppError.forbidden('You cannot approve a document you submitted.');
    }
    // QA3-BUG-004: with `workflow.block_self_approval` (default on) segregation of duties also holds on assignments
    // (escalation / no-actor fallback). The submitter stays assigned (so the stage is never orphaned) but cannot act.
    if (!stage.allowSelfApproval && st.doc.submittedBy === caller.userId && await this.blocksSelf(tx)) {
      throw AppError.forbidden('You submitted this document, so you cannot approve it. Forward it to another approver, or ask an administrator to add one to this stage.');
    }
    if (!rule.ok) {
      const asg = await tx.selectFrom('app.wf_assignment').select(['reason', 'created_by']).where('instance_id', '=', st.instanceId)
        .where('stage_key', '=', stage.key).where('user_id', '=', caller.userId).where('is_active', '=', true).executeTakeFirst();
      if (!asg) {
        if (rule.reason === 'scope') throw AppError.notFound('Document');
        if (rule.reason === 'self') throw AppError.forbidden('You cannot approve a document you submitted.');
        if (rule.reason === 'actor') throw AppError.forbidden(`You are not an approver for "${stage.name}" on this document.`);
        throw AppError.forbidden();
      }
      onBehalfOf = asg.created_by;
    }

    const base = { stage, idempotencyKey: opts.idempotencyKey ?? null, onBehalfOf };
    switch (input.action) {
      case 'decide': await this.decide(tx, st, { ...base, input, perms: caller.perms }); break;
      case 'unhold': await this.unhold(tx, st, { ...base, input }); break;
      case 'send_back': await this.sendBack(tx, st, { ...base, input }); break;
      case 'forward': await this.forwardTo(tx, st, { ...base, input }); break;
    }
    return { documentId, replay: false };
  }

  private async assignedTo(tx: Tx, st: State, stageKey: string, userId: string): Promise<boolean> {
    return !!(await tx.selectFrom('app.wf_assignment').select('id').where('instance_id', '=', st.instanceId)
      .where('stage_key', '=', stageKey).where('user_id', '=', userId).where('is_active', '=', true).executeTakeFirst());
  }

  /** Tenant setting `workflow.block_self_approval` (QA3-BUG-004). */
  blocksSelf(tx: Tx): Promise<boolean> {
    return getTenantSetting(tx, 'workflow.block_self_approval');
  }

  private requireAction(stage: StageDef, action: string) {
    if (!(stage.actions as string[]).includes(action)) throw new AppError(403, 'ACTION_NOT_ALLOWED', `"${action}" is not allowed at ${stage.name}.`);
  }

  // ------------------------------------------------------------------------------------------- decide

  private normalise(st: State, stage: StageDef, input: Extract<WorkflowActionInput, { action: 'decide' }>): AppliedDecision[] {
    const pendingOf = (lineId: string) => st.lines.get(lineId)?.get(stage.key)?.p ?? ZERO;
    const lineNo = new Map(st.snap.lines.map(l => [l.id, l.lineNo]));
    const pendingLines = [...st.lines.entries()].filter(([, l]) => isTrue(l.get(stage.key)?.p ?? ZERO)).map(([id]) => id).sort();

    let decisions: LineDecision[] = input.decisions;
    if (st.def.granularity === 'document' && decisions.length) {
      throw new AppError(400, 'VALIDATION_FAILED', 'This workflow approves whole documents: send "outcome" instead of line decisions.');
    }
    if (input.outcome) {
      if (decisions.length) throw new AppError(400, 'VALIDATION_FAILED', 'Send either "outcome" or line decisions, not both.');
      decisions = pendingLines.map(lineId => {
        const p = fmt(pendingOf(lineId));
        return { lineId, approve: input.outcome === 'approve' ? p : '0', hold: input.outcome === 'hold' ? p : '0', reject: input.outcome === 'reject' ? p : '0', reason: input.comment };
      });
    }
    if (!decisions.length) throw new AppError(400, 'VALIDATION_FAILED', 'Nothing to decide: no line is pending at this stage.');
    const seen = new Set<string>();
    const out: AppliedDecision[] = [];
    for (const d of decisions) {
      if (seen.has(d.lineId)) throw new AppError(400, 'VALIDATION_FAILED', 'A line appears more than once in the decisions.', { lineId: d.lineId });
      seen.add(d.lineId);
      const pending = pendingOf(d.lineId);
      const a = D(d.approve); const h = D(d.hold); const r = D(d.reject);
      if (!pending.gt(0) || !a.plus(h).plus(r).eq(pending)) {
        throw new AppError(409, 'QTY_CHANGED', `Line ${lineNo.get(d.lineId) ?? '?'}: approve + hold + reject must equal the pending quantity ${fmt(pending)}. Reload and try again.`,
          { lineId: d.lineId, pending: fmt(pending) });
      }
      if (a.gt(0)) this.requireAction(stage, 'approve');
      if (h.gt(0)) this.requireAction(stage, 'hold');
      if (r.gt(0)) this.requireAction(stage, 'reject');
      const reason = d.reason?.trim() || input.comment?.trim() || null;
      const partial = a.gt(0) && a.lt(pending);
      const rro = stage.requireReasonOn as string[];
      // A reduction (approve below pending) needs a reason unless the stage dropped 'partial' from requireReasonOn.
      const needs = (r.gt(0) && rro.includes('reject')) || (h.gt(0) && rro.includes('hold')) || (partial && rro.includes('partial'));
      if (needs && !reason) throw new AppError(400, 'REASON_REQUIRED', `Line ${lineNo.get(d.lineId) ?? '?'}: give a reason for this decision.`, { lineId: d.lineId });
      if (d.values && Object.keys(d.values).length) {
        const bad = Object.keys(d.values).filter(k => !stage.editableLineFields.includes(k));
        if (bad.length) throw new AppError(400, 'VALIDATION_FAILED', `These fields cannot be changed at ${stage.name}: ${bad.join(', ')}.`, { fields: bad });
      }
      out.push({ lineId: d.lineId, lineNo: lineNo.get(d.lineId), pending: fmt(pending), approve: fmt(a), hold: fmt(h), reject: fmt(r), reason,
        ...(d.values && Object.keys(d.values).length ? { values: d.values } : {}) });
    }
    return out;
  }

  private async decide(tx: Tx, st: State, a: {
    stage: StageDef; input: Extract<WorkflowActionInput, { action: 'decide' }>; idempotencyKey: string | null; onBehalfOf: string | null; perms?: MyPermissions;
  }) {
    const { stage, input } = a;
    const decisions = this.normalise(st, stage, input);
    const edits = decisions.filter(d => d.values).map(d => ({ lineId: d.lineId, values: d.values! }));
    // QA3-BUG-008: the approver's field access applies to the stage's editable line fields.
    if (edits.length) await this.docs.get().applyLineEdits(tx, st.snap.id, edits, stage.editableLineFields, { userId: st.actorId, perms: a.perms });

    if (stage.quorum === 'all') {
      const voteId = await this.insertAction(tx, st, {
        stageKey: stage.key, action: 'decide', actorId: st.actorId, onBehalfOf: a.onBehalfOf, comment: input.comment ?? null,
        decisions: decisions.map(d => ({ ...d, vote: true })), idempotencyKey: a.idempotencyKey,
      });
      const merged = await this.quorumMerge(tx, st, stage);
      if (!merged) {
        await this.flush(tx, st, voteId);
        await this.finishAction(tx, st, voteId);
        return;
      }
      const mergeId = await this.insertAction(tx, st, { stageKey: stage.key, action: 'decide', actorId: st.actorId, comment: 'All approvers decided', decisions: merged });
      await this.applyDecisions(tx, st, stage, merged, mergeId);
      return;
    }
    const id = await this.insertAction(tx, st, {
      stageKey: stage.key, action: 'decide', actorId: st.actorId, onBehalfOf: a.onBehalfOf, comment: input.comment ?? null,
      decisions, idempotencyKey: a.idempotencyKey,
    });
    await this.applyDecisions(tx, st, stage, decisions, id);
  }

  /** Quorum 'all': merged decisions once every required approver has a current vote covering every pending line. */
  private async quorumMerge(tx: Tx, st: State, stage: StageDef): Promise<AppliedDecision[] | null> {
    const pending = new Map<string, Decimal>();
    for (const [id, l] of st.lines) { const p = l.get(stage.key)?.p; if (p && p.gt(0)) pending.set(id, p); }
    const voters = new Set((await this.actors.eligibleUsers(tx, st.tenantId, stage, st.doc)).map(u => u.id));
    const asg = await tx.selectFrom('app.wf_assignment').select('user_id').where('instance_id', '=', st.instanceId)
      .where('stage_key', '=', stage.key).where('is_active', '=', true).execute();
    for (const x of asg) voters.add(x.user_id);
    const since = st.stages.get(stage.key)?.entered_at ?? new Date(0);
    const rows = await tx.selectFrom('app.wf_action').select(['actor_id', 'decisions', 'at']).where('instance_id', '=', st.instanceId)
      .where('stage_key', '=', stage.key).where('action', '=', 'decide').where('at', '>=', since).orderBy('at', 'desc').execute();
    const latest = new Map<string, AppliedDecision[]>();
    for (const r of rows) {
      const ds = (typeof r.decisions === 'string' ? JSON.parse(r.decisions) : r.decisions) as AppliedDecision[];
      if (!ds.length || !ds[0]!.vote) {
        if (ds.length) break; // a merge happened after older votes: they are spent
        continue;
      }
      if (r.actor_id && !latest.has(r.actor_id)) latest.set(r.actor_id, ds);
    }
    const valid = (ds: AppliedDecision[]) => ds.length === pending.size && ds.every(d => pending.get(d.lineId)?.eq(D(d.pending)));
    for (const v of voters) if (!latest.has(v) || !valid(latest.get(v)!)) return null;
    if (!voters.size) return null;
    const votes = [...voters].map(v => latest.get(v)!);
    return [...pending.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([lineId, p]) => {
      const per = votes.map(ds => ds.find(d => d.lineId === lineId)!);
      const m = mergeVotes(p, per.map(d => ({ approve: D(d.approve), reject: D(d.reject) })));
      const reasons = per.map(d => d.reason).filter(Boolean);
      return { lineId, lineNo: per[0]!.lineNo, pending: fmt(p), approve: fmt(m.approve), hold: fmt(m.hold), reject: fmt(m.reject), reason: reasons.join('; ') || null };
    });
  }

  /** Applies normalised decisions at a stage: hold/reject/approve, eager release, onward routing, effects. */
  private async applyDecisions(tx: Tx, st: State, stage: StageDef, decisions: AppliedDecision[], actionId: string) {
    const gi = groupIndexOf(st.groups, stage.key);
    const g = st.groups[gi]!;
    const route = stage.effects.onReject.find((e): e is Extract<Effect, { effect: 'route_to' }> => e.effect === 'route_to');
    const approved: { lineId: string; qty: string }[] = [];
    const rejected: { lineId: string; qty: string }[] = [];
    const routed: { lineId: string; qty: Decimal }[] = [];
    for (const d of decisions) {
      const l = this.lineOf(st, d.lineId);
      st.touchedLines.add(d.lineId);
      const a = D(d.approve); const h = D(d.hold); const r = D(d.reject);
      const qBefore = groupQty(l, g);
      const c = cell(l, stage.key);
      c.p = c.p.minus(a).minus(h).minus(r);
      c.h = c.h.plus(h);
      removeFromSiblings(l, g, stage.key, r);
      if (r.gt(0)) {
        rejected.push({ lineId: d.lineId, qty: fmt(r) });
        if (route) routed.push({ lineId: d.lineId, qty: r });
        else st.ledger.push({ lineId: d.lineId, type: 'rejected', qty: fmt(r), stageKey: stage.key, reason: d.reason });
      }
      if (a.gt(0)) approved.push({ lineId: d.lineId, qty: fmt(a) });
      const m = releasable(l, g, qBefore.minus(r));
      if (m.gt(0)) await this.forward(tx, st, gi, d.lineId, m, stage.key);
    }
    if (route && routed.length) {
      const target = st.groups[groupIndexOf(st.groups, route.stage)]!;
      await this.participants(tx, st, target, route.stage);
      for (const x of routed) enter(this.lineOf(st, x.lineId), [route.stage], x.qty);
    }
    if (approved.length) st.effects.push(...stage.effects.onApprove.map(effect => ({ effect, stageKey: stage.key, approved, rejected })));
    if (rejected.length) st.effects.push(...stage.effects.onReject.map(effect => ({ effect, stageKey: stage.key, approved, rejected })));
    await this.flush(tx, st, actionId);
    await this.finishAction(tx, st, actionId);

    const summary = summarise(decisions);
    await this.docs.get().emit(tx, 'workflow.decided', { kind: 'document', id: st.snap.id }, {
      documentId: st.snap.id, docType: st.snap.docTypeKey, stageKey: stage.key, actionId, decisions,
    });
    if (st.snap.submittedBy && st.snap.submittedBy !== st.actorId) {
      await this.notify(tx, st, [st.snap.submittedBy], 'document_decided', `${docLabel(st.snap)}: ${summary} at ${stage.name}`, null, { stageKey: stage.key, actionId });
    }
  }

  // ------------------------------------------------------------------------------------------- unhold

  private async unhold(tx: Tx, st: State, a: { stage: StageDef; input: Extract<WorkflowActionInput, { action: 'unhold' }>; idempotencyKey: string | null; onBehalfOf: string | null }) {
    const { stage, input } = a;
    this.requireAction(stage, 'hold');
    const decisions: AppliedDecision[] = [];
    for (const lineId of [...new Set(input.lineIds)].sort()) {
      const c = st.lines.get(lineId)?.get(stage.key);
      if (!c || !c.h.gt(0)) throw new AppError(409, 'QTY_CHANGED', 'This line has nothing on hold at this stage. Reload and try again.', { lineId });
      decisions.push({ lineId, pending: fmt(c.p), approve: '0', hold: fmt(c.h.neg()), reject: '0', reason: input.comment ?? null });
      c.p = c.p.plus(c.h);
      c.h = ZERO;
      st.touchedLines.add(lineId);
    }
    // New pending → a new decision round (quorum votes are compared against entered_at).
    this.patchStage(st, stage.key, { entered_at: st.now });
    const id = await this.insertAction(tx, st, { stageKey: stage.key, action: 'unhold', actorId: st.actorId, onBehalfOf: a.onBehalfOf, comment: input.comment ?? null, decisions, idempotencyKey: a.idempotencyKey });
    await this.flush(tx, st, id);
    await this.finishAction(tx, st, id);
  }

  // ------------------------------------------------------------------------------------------- send back

  private async sendBack(tx: Tx, st: State, a: { stage: StageDef; input: Extract<WorkflowActionInput, { action: 'send_back' }>; idempotencyKey: string | null; onBehalfOf: string | null }) {
    const { stage, input } = a;
    this.requireAction(stage, 'send_back');
    const port = this.docs.get();
    if (input.toStage === '_draft') {
      const id = await this.insertAction(tx, st, { stageKey: stage.key, action: 'send_back', actorId: st.actorId, onBehalfOf: a.onBehalfOf, comment: input.reason, targetStage: '_draft', idempotencyKey: a.idempotencyKey });
      for (const [lineId, l] of st.lines) {
        const w = inWorkflow(l, st.groups);
        clearLine(l);
        if (w.gt(0)) st.ledger.push({ lineId, type: 'cancelled', qty: fmt(w), stageKey: stage.key, reason: input.reason });
      }
      this.reopenActive(st);
      await this.flush(tx, st, id);
      await this.closeInstance(tx, st, 'cancelled', `Sent back to draft: ${input.reason}`);
      await port.returnToDraft(tx, st.snap.id, st.actorId, input.reason);
      await port.emit(tx, 'workflow.sent_back', { kind: 'document', id: st.snap.id }, { documentId: st.snap.id, docType: st.snap.docTypeKey, fromStage: stage.key, toStage: '_draft', reason: input.reason });
      await tx.updateTable('app.document').set({ updated_by: st.actorId }).where('id', '=', st.snap.id).execute();
      await port.recomputeStatus(tx, st.snap.id);
      if (st.snap.submittedBy && st.snap.submittedBy !== st.actorId) {
        await this.notify(tx, st, [st.snap.submittedBy], 'document_decided', `${docLabel(st.snap)} was sent back to you`, input.reason, { stageKey: stage.key });
      }
      return;
    }
    const target = st.stageDefs.get(input.toStage);
    const tgi = target ? groupIndexOf(st.groups, target.key) : -1;
    const cur = groupIndexOf(st.groups, stage.key);
    const tRow = target ? st.stages.get(target.key) : undefined;
    if (!target || tgi >= cur || !tRow || !['active', 'done'].includes(tRow.status)) {
      throw new AppError(400, 'BAD_SEND_BACK', 'You can send back only to an earlier stage that has already run, or to the submitter.');
    }
    const id = await this.insertAction(tx, st, { stageKey: stage.key, action: 'send_back', actorId: st.actorId, onBehalfOf: a.onBehalfOf, comment: input.reason, targetStage: target.key, idempotencyKey: a.idempotencyKey });
    const moved = new Map<string, Decimal>();
    for (const [lineId, l] of st.lines) {
      let x = ZERO;
      for (const g of st.groups.slice(tgi + 1)) x = x.plus(drainGroup(l, g).qty);
      if (x.gt(0)) moved.set(lineId, x);
    }
    for (const g of st.groups.slice(tgi + 1)) for (const key of g.stages) {
      const r = st.stages.get(key);
      if (r && (r.status === 'active' || r.status === 'done')) {
        this.patchStage(st, key, { status: 'pending', entered_at: null, due_at: null, next_reminder_at: null, completed_at: null, escalated_at: null });
        await tx.updateTable('app.wf_assignment').set({ is_active: false }).where('instance_id', '=', st.instanceId).where('stage_key', '=', key).where('is_active', '=', true).execute();
      }
    }
    if (moved.size) {
      if (tRow.status === 'done') { st.activated.delete(target.key); }
      const parts = await this.participants(tx, st, st.groups[tgi]!, target.key);
      for (const [lineId, x] of moved) enter(this.lineOf(st, lineId), parts, x);
      this.patchStage(st, target.key, { entered_at: st.now });
    }
    await this.flush(tx, st, id);
    await this.finishAction(tx, st, id);
    await port.emit(tx, 'workflow.sent_back', { kind: 'document', id: st.snap.id }, { documentId: st.snap.id, docType: st.snap.docTypeKey, fromStage: stage.key, toStage: target.key, reason: input.reason });
  }

  // ------------------------------------------------------------------------------------------- forward

  private async forwardTo(tx: Tx, st: State, a: { stage: StageDef; input: Extract<WorkflowActionInput, { action: 'forward' }>; idempotencyKey: string | null; onBehalfOf: string | null }) {
    const { stage, input } = a;
    this.requireAction(stage, 'forward');
    if (input.toUserId === st.actorId) throw new AppError(400, 'BAD_FORWARD', 'You cannot forward to yourself.');
    if (input.toUserId === st.snap.submittedBy && !stage.allowSelfApproval) throw new AppError(400, 'BAD_FORWARD', 'You cannot forward a document to the person who submitted it.');
    if (!await this.actors.userCanView(tx, st.tenantId, input.toUserId, st.doc)) {
      throw new AppError(400, 'BAD_FORWARD', 'That person cannot see this document (no access to this document type or location).');
    }
    const id = await this.insertAction(tx, st, { stageKey: stage.key, action: 'forward', actorId: st.actorId, onBehalfOf: a.onBehalfOf, comment: input.reason, targetUserId: input.toUserId, idempotencyKey: a.idempotencyKey });
    await this.assign(tx, st, stage.key, [input.toUserId], 'forward', st.actorId);
    await this.notify(tx, st, [input.toUserId], 'approval_pending', `${docLabel(st.snap)} was forwarded to you for ${stage.name}`, input.reason, { stageKey: stage.key, forwarded: true });
    await this.docs.get().emit(tx, 'workflow.forwarded', { kind: 'document', id: st.snap.id }, { documentId: st.snap.id, docType: st.snap.docTypeKey, stageKey: stage.key, toUserId: input.toUserId });
    await this.flush(tx, st, id);
    await this.finishAction(tx, st, id);
  }

  // =========================================================================================== port: cancel

  private async closeInstance(tx: Tx, st: State, status: 'cancelled', reason: string) {
    await tx.updateTable('app.wf_instance').set({ status, completed_at: st.now, cancel_reason: reason }).where('id', '=', st.instanceId).execute();
    // QA3-BUG-011: stages still waiting were never completed (sent back / cancelled): they go back to pending, not done.
    await tx.updateTable('app.wf_stage_state').set({ status: 'pending', completed_at: null, due_at: null, next_reminder_at: null })
      .where('instance_id', '=', st.instanceId).where('status', '=', 'active').execute();
    await tx.updateTable('app.wf_assignment').set({ is_active: false }).where('instance_id', '=', st.instanceId).where('is_active', '=', true).execute();
    await tx.deleteFrom('app.wf_line_state').where('instance_id', '=', st.instanceId).execute();
    await this.defs.cleanupRetired(tx, st.tenantId, st.snap.docTypeId);
  }

  /** QA3-BUG-011: stages that were waiting when the instance is sent back / cancelled were not completed: pending again. */
  private reopenActive(st: State) {
    for (const [key, row] of st.stages) {
      if (row.status === 'active') this.patchStage(st, key, { status: 'pending', completed_at: null, due_at: null, next_reminder_at: null });
    }
  }

  /** Removes a line's qty from every stage without ledger events (the documents module already wrote unheld + cancelled). */
  private dropLine(st: State, lineId: string) {
    clearLine(st.lines.get(lineId)!);
    st.heldBefore.set(lineId, ZERO);
  }

  /** WorkflowPort.cancel: the documents module already wrote `unheld` + `cancelled` for the remaining qty. */
  async cancel(tx: Tx, documentId: string, reason: string, actorId: string | null): Promise<void> {
    const st = await this.load(tx, documentId, { requireRunning: false, actorId });
    if (!st) return;
    for (const id of st.lines.keys()) this.dropLine(st, id);
    this.reopenActive(st);
    const id = await this.insertAction(tx, st, { stageKey: '_end', action: 'cancel', actorId, comment: reason });
    await this.flush(tx, st, id);
    await this.closeInstance(tx, st, 'cancelled', reason);
  }

  /** WorkflowPort.linesCancelled: removes the lines' qty from every stage (ledger written by documents); may complete. */
  async linesCancelled(tx: Tx, documentId: string, lineIds: string[]): Promise<void> {
    const st = await this.load(tx, documentId, { requireRunning: false, actorId: null });
    if (!st) return;
    const ids = new Set(lineIds);
    let touched = false;
    for (const [lineId, l] of st.lines) if (ids.has(lineId) && hasQty(l)) { this.dropLine(st, lineId); touched = true; }
    if (!touched) return;
    const id = await this.insertAction(tx, st, { stageKey: '_end', action: 'cancel', actorId: null, comment: 'Lines cancelled', decisions: [...ids].map(lineId => ({ lineId, pending: '0', approve: '0', hold: '0', reject: '0', reason: null })) });
    await this.flush(tx, st, id);
    await this.runEffects(tx, st, id);
    if (!this.anyQty(st)) await this.complete(tx, st);
    await this.defs.cleanupRetired(tx, st.tenantId, st.snap.docTypeId);
  }

  // =========================================================================================== SLA

  /** Processes one due stage row (already locked by the SLA scanner). */
  async slaTick(tx: Tx, row: { instance_id: string; stage_key: string; due_at: Date | null; next_reminder_at: Date | null; escalated_at: Date | null; reminders_sent: number }, now: Date) {
    const inst = await tx.selectFrom('app.wf_instance').select(['document_id', 'workflow_version_id', 'status']).where('id', '=', row.instance_id).executeTakeFirst();
    if (!inst || inst.status !== 'running') return;
    const snap = await this.docs.get().snapshot(tx, inst.document_id, { lock: false });
    const ver = await this.defs.versionById(tx, inst.workflow_version_id);
    const stage = ver.definition.stages.find(s => s.key === row.stage_key);
    if (!stage?.sla) return;
    const st = this.newState(snap, row.instance_id, inst.workflow_version_id, ver.definition, null);
    st.now = now;
    const assignees = await tx.selectFrom('app.wf_assignment').select('user_id').where('instance_id', '=', row.instance_id)
      .where('stage_key', '=', row.stage_key).where('is_active', '=', true).execute();
    const eligible = [...(await this.actors.eligibleUsers(tx, st.tenantId, stage, st.doc)).map(u => u.id), ...assignees.map(a => a.user_id)];

    if (row.due_at && !row.escalated_at && row.due_at <= now) {
      let targets: string[] = [];
      if (stage.sla.escalateTo) targets = (await this.actors.usersOfActors(tx, [stage.sla.escalateTo], st.doc)).map(u => u.id);
      if (targets.length) await this.assign(tx, st, stage.key, targets, 'escalation', null);
      await this.insertAction(tx, st, { stageKey: stage.key, action: 'escalate', actorId: null, comment: 'Approval is overdue', targetUserId: targets[0] ?? null });
      await tx.updateTable('app.wf_stage_state').set({ escalated_at: now }).where('instance_id', '=', row.instance_id).where('stage_key', '=', row.stage_key).execute();
      await this.notify(tx, st, [...targets, ...eligible], 'approval_escalated', `${docLabel(snap)} is overdue at ${stage.name}`, null, { stageKey: stage.key, escalated: true });
      await this.docs.get().emit(tx, 'workflow.sla_escalated', { kind: 'document', id: snap.id }, { documentId: snap.id, docType: snap.docTypeKey, stageKey: stage.key, escalatedTo: targets });
    }
    if (row.next_reminder_at && row.next_reminder_at <= now) {
      const every = stage.sla.remindEveryHours;
      let next: Date | null = null;
      if (every) {
        next = new Date(row.next_reminder_at.getTime());
        while (next <= now) next = new Date(next.getTime() + every * 3600_000);
      }
      await this.insertAction(tx, st, { stageKey: stage.key, action: 'remind', actorId: null, comment: `Reminder ${row.reminders_sent + 1}` });
      await tx.updateTable('app.wf_stage_state').set({ next_reminder_at: next, reminders_sent: row.reminders_sent + 1 })
        .where('instance_id', '=', row.instance_id).where('stage_key', '=', row.stage_key).execute();
      await this.notify(tx, st, eligible, 'approval_reminder', `Reminder: ${docLabel(snap)} is waiting for ${stage.name}`, null, { stageKey: stage.key });
      await this.docs.get().emit(tx, 'workflow.sla_reminder', { kind: 'document', id: snap.id }, { documentId: snap.id, docType: snap.docTypeKey, stageKey: stage.key, reminder: row.reminders_sent + 1 });
    }
  }

  // =========================================================================================== route_to effect

  /** Handler body of the `route_to` effect (the engine already routes rejected qty inline). */
  routeTo(): Promise<void> {
    return Promise.resolve();
  }

  /** Users to notify for a `notify` effect target `stage_actors`. */
  async stageActors(tx: Tx, tenantId: string, documentId: string, stageKey: string): Promise<string[]> {
    const inst = await tx.selectFrom('app.wf_instance').select(['id', 'workflow_version_id']).where('document_id', '=', documentId)
      .orderBy('started_at', 'desc').limit(1).executeTakeFirst();
    if (!inst) return [];
    const ver = await this.defs.versionById(tx, inst.workflow_version_id);
    const stage = ver.definition.stages.find(s => s.key === stageKey);
    if (!stage) return [];
    const snap = await this.docs.get().snapshot(tx, documentId, { lock: false });
    const doc: ActorDoc = { docTypeKey: snap.docTypeKey, locationPath: snap.locationPath, submittedBy: snap.submittedBy, values: snap.values };
    return (await this.actors.eligibleUsers(tx, tenantId, stage, doc)).map(u => u.id);
  }
}

export function summarise(ds: AppliedDecision[]): string {
  const n = (f: (d: AppliedDecision) => boolean) => ds.filter(f).length;
  const parts: string[] = [];
  const approved = n(d => D(d.approve).gt(0));
  const held = n(d => D(d.hold).gt(0));
  const rejected = n(d => D(d.reject).gt(0));
  if (approved) parts.push(`approved ${approved} line${approved > 1 ? 's' : ''}`);
  if (held) parts.push(`held ${held}`);
  if (rejected) parts.push(`rejected ${rejected}`);
  return parts.join(', ') || 'decided';
}

export { statusLabelOf };

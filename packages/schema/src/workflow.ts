import { z } from 'zod';
import { Uuid } from './common';
import { Expr, FieldKey } from './forms';

/**
 * WORKFLOW CONTRACT (Phase 3, frozen). ADR-0011. One engine runs approvals for every document type.
 *
 * Model: an ordered list of stages. Consecutive stages with the same `parallelGroup` run in parallel and all must
 * finish (join = all) before the next stage. A stage whose `when` is false, or that is disabled, is skipped.
 * Quantities flow stage to stage per line: at each stage an actor decides, per line, how much to approve (moves to
 * the next stage, or out of the workflow as approved after the last stage), hold (stays at this stage until
 * un-held) and reject (leaves the workflow). Approve + hold + reject must equal the line's pending qty at the stage.
 */

export const StageKey = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, 'Use lowercase letters, digits and _');

/** Who may act on a stage. Every actor must ALSO hold the stage permission `doc.<type>:action.stage_<key>` and have
 *  the document's location in their data scope. Actor rules are OR-ed; an empty list = anyone with the permission. */
export const WorkflowActor = z.discriminatedUnion('type', [
  z.object({ type: z.literal('role'), roleId: Uuid }),
  z.object({ type: z.literal('users'), userIds: z.array(Uuid).min(1).max(50) }),
  /** Reporting manager of the user who submitted the document. */
  z.object({ type: z.literal('reporting_manager') }),
  /** A user picked on the document header (lookup field with source kind 'user'). */
  z.object({ type: z.literal('field'), field: FieldKey }),
]);
export type WorkflowActor = z.infer<typeof WorkflowActor>;

/** Effects are a FIXED vocabulary implemented by the engine and modules. Unavailable effects (module not shipped or
 *  not in plan) are rejected at publish with a clear issue. */
export const EFFECTS = ['lock_editing', 'unlock_editing', 'close_document', 'notify', 'emit', 'route_to',
  'post_stock', 'block_stock', 'unblock_stock', 'return_to_vendor', 'generate_pdf', 'send_email', 'send_whatsapp'] as const;
export const Effect = z.discriminatedUnion('effect', [
  z.object({ effect: z.literal('lock_editing') }),
  z.object({ effect: z.literal('unlock_editing') }),
  z.object({ effect: z.literal('close_document') }),
  /** In-app notification (email/WhatsApp come from the trigger engine in Phase 6). */
  z.object({ effect: z.literal('notify'), to: z.array(z.union([WorkflowActor, z.object({ type: z.literal('submitter') }), z.object({ type: z.literal('stage_actors'), stage: StageKey })])).min(1), message: z.string().max(300).optional() }),
  /** Writes a domain event to the outbox (consumed by triggers/webhooks later). */
  z.object({ effect: z.literal('emit'), event: z.string().regex(/^[a-z][a-z0-9_.]{2,60}$/) }),
  /** Jump to another stage (e.g. QA reject → store disposition). Only valid in onReject. */
  z.object({ effect: z.literal('route_to'), stage: StageKey }),
  z.object({ effect: z.literal('post_stock'), stockStatus: z.enum(['available', 'quarantine']).default('available') }),
  z.object({ effect: z.literal('block_stock') }),
  z.object({ effect: z.literal('unblock_stock') }),
  z.object({ effect: z.literal('return_to_vendor') }),
  z.object({ effect: z.literal('generate_pdf'), template: z.string().optional() }),
  z.object({ effect: z.literal('send_email'), template: z.string() }),
  z.object({ effect: z.literal('send_whatsapp'), template: z.string() }),
]);
export type Effect = z.infer<typeof Effect>;

/** 'partial' is informational for the designer: split decisions (approve part, hold/reject the rest) are allowed
 *  whenever 'approve' plus the needed 'hold'/'reject' actions are allowed. */
export const STAGE_ACTIONS = ['approve', 'partial', 'reject', 'hold', 'send_back', 'forward'] as const;

export const Stage = z.object({
  key: StageKey,
  name: z.string().trim().min(1).max(60),
  /** Status label shown while a document waits here, e.g. 'Waiting for verification'. Default: 'Waiting for <name>'. */
  statusLabel: z.string().max(60).optional(),
  enabled: z.boolean().default(true),
  /** Boolean formula on header fields (and aggregates over `lines.*`). False → stage skipped. */
  when: Expr.optional(),
  actors: z.array(WorkflowActor).max(10).default([]),
  actions: z.array(z.enum(STAGE_ACTIONS)).min(1).default(['approve', 'reject', 'hold', 'send_back']),
  /** 'any' = first eligible actor's decision completes the stage; 'all' = every resolved actor must approve
   *  (decisions merge as the minimum approved qty; any reject rejects). 'all' needs explicit actors (role/users). */
  quorum: z.enum(['any', 'all']).default('any'),
  allowSelfApproval: z.boolean().default(false),
  /** When no user can act: skip the stage (logged) or assign tenant admins. */
  ifNoActor: z.enum(['skip', 'assign_admins']).default('assign_admins'),
  parallelGroup: z.string().regex(/^[a-z0-9_]{1,20}$/).optional(),
  /** Reason required for these decisions. A reduction (approve < pending) counts as 'partial'; the default list
   *  requires reasons for hold, reject, send back and reductions, as the brief asks. */
  requireReasonOn: z.array(z.enum(['reject', 'hold', 'send_back', 'forward', 'partial'])).default(['reject', 'hold', 'send_back', 'partial']),
  /** Approvers at this stage may edit these line fields while deciding (e.g. rate); empty = none. */
  editableLineFields: z.array(FieldKey).max(20).default([]),
  sla: z.object({
    hours: z.number().positive().max(24 * 90),
    /** Business hours are not modelled in v1: hours are wall-clock in the tenant timezone. */
    remindEveryHours: z.number().positive().max(24 * 30).optional(),
    escalateTo: WorkflowActor.optional(),
  }).optional(),
  effects: z.object({
    onEnter: z.array(Effect).default([]),
    /** Runs once per approve decision (with the approved qty per line available to the effect). */
    onApprove: z.array(Effect).default([]),
    onReject: z.array(Effect).default([]),
  }).default({}),
});
export type Stage = z.infer<typeof Stage>;

export const WorkflowDefinition = z.object({
  version: z.number().int().min(1).default(1),
  /** 'line' = per-line decisions with quantities; 'document' = one decision for all lines. */
  granularity: z.enum(['line', 'document']).default('line'),
  stages: z.array(Stage).max(30).default([]),
  /** Effects when the workflow finishes (every line approved/rejected/cancelled). */
  onComplete: z.array(Effect).default([]),
  /** Effects at submit (before the first stage), e.g. lock_editing. Default lock_editing is implicit. */
  onSubmit: z.array(Effect).default([]),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export interface WorkflowIssue {
  path: string;   // 'stages.2.when', 'stages.1.actors.0.roleId', 'onComplete.0'
  code: 'DUPLICATE_STAGE' | 'BAD_CONDITION' | 'UNKNOWN_ROLE' | 'UNKNOWN_USER' | 'UNKNOWN_FIELD' | 'EFFECT_UNAVAILABLE'
    | 'BAD_ROUTE' | 'BAD_PARALLEL_GROUP' | 'QUORUM_NEEDS_ACTORS' | 'NO_ACTIONS' | 'RESERVED_STAGE_KEY';
  message: string;
}

export interface WorkflowDetail {
  id: string; docTypeKey: string; name: string;
  published: WorkflowDefinition | null; publishedVersion: number | null;
  draft: WorkflowDefinition | null; draftIssues: WorkflowIssue[];
  /** Effects available to this tenant right now (plan + shipped modules), for the designer palette. */
  availableEffects: (typeof EFFECTS)[number][];
  version: number;
}
export const WorkflowDraftSave = z.object({ definition: WorkflowDefinition, version: z.number().int() });
export const WorkflowPublish = z.object({ changeNote: z.string().max(500).optional(), version: z.number().int() });

/** POST /config/workflows/:docType/simulate — dry run of routing for sample header/line values. */
export const SimulateInput = z.object({
  values: z.record(z.string(), z.unknown()),
  lines: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
  useDraft: z.boolean().default(true),
});
export interface SimulateResult {
  stages: { key: string; name: string; outcome: 'run' | 'skipped_condition' | 'disabled' | 'no_actor_skip' | 'no_actor_admins'; actors: string[]; parallelGroup: string | null; conditionValue?: boolean; error?: string }[];
}

// ---------------------------------------------------------------------------------------------
// Runtime actions
// ---------------------------------------------------------------------------------------------

/** Per-line decision at a stage. approve + hold + reject = the line's pending qty at that stage (decimal strings).
 *  approve < pending (a reduction) needs `reason` unless the stage drops 'partial' from requireReasonOn. */
export const LineDecision = z.object({
  lineId: Uuid,
  approve: z.string().regex(/^\d+(\.\d+)?$/).default('0'),
  hold: z.string().regex(/^\d+(\.\d+)?$/).default('0'),
  reject: z.string().regex(/^\d+(\.\d+)?$/).default('0'),
  reason: z.string().trim().max(500).optional(),
  /** Values for stage.editableLineFields. */
  values: z.record(z.string(), z.unknown()).optional(),
});
export type LineDecision = z.infer<typeof LineDecision>;

export const WorkflowActionInput = z.discriminatedUnion('action', [
  /** Line granularity: decisions for any subset of lines pending at the stage. Document granularity: send
   *  `outcome` instead and the engine applies it to every line. */
  z.object({ action: z.literal('decide'), stageKey: StageKey, decisions: z.array(LineDecision).max(1000).default([]), outcome: z.enum(['approve', 'reject', 'hold']).optional(), comment: z.string().max(2000).optional() }),
  z.object({ action: z.literal('unhold'), stageKey: StageKey, lineIds: z.array(Uuid).min(1), comment: z.string().max(2000).optional() }),
  /** Back to an earlier stage, or '_draft' to return the document to its creator (instance cancelled; resubmit restarts). */
  z.object({ action: z.literal('send_back'), stageKey: StageKey, toStage: z.string(), reason: z.string().trim().min(3).max(500) }),
  z.object({ action: z.literal('forward'), stageKey: StageKey, toUserId: Uuid, reason: z.string().trim().min(3).max(500) }),
]);
export type WorkflowActionInput = z.infer<typeof WorkflowActionInput>;

export interface InboxItem {
  documentId: string; docTypeKey: string; docTypeName: string; number: string | null; statusLabel: string;
  stageKey: string; stageName: string; location: string; submittedBy: string | null; submittedAt: string | null;
  totalAmount: string | null; pendingLines: number; heldLines: number; dueAt: string | null; overdue: boolean;
  assignedBecause: 'rule' | 'forward' | 'escalation';
}
export interface InboxCounts { total: number; overdue: number; byType: { docTypeKey: string; name: string; stageKey: string; stageName: string; count: number; overdue: number }[] }

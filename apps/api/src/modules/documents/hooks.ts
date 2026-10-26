import { Injectable } from '@nestjs/common';
import type { Tx } from '../../core/db.service';
import type { LedgerEvent } from '../../core/ports';
import type { Buckets } from './qty';
import type { DocActor } from './types';

/**
 * Generic extension points for modules that build on system document types (Phase 4: procurement). Additive:
 * documents behave exactly as before when nothing is registered.
 *
 * - `onSubmit(docTypeKey, fn)`: runs inside the submit transaction after numbering and the `requested` ledger events,
 *   before the workflow starts. Throwing aborts the submit (e.g. 409 QTY_EXCEEDS_REMAINING).
 * - `onLineOutcome(docTypeKey, fn)`: runs inside the same transaction whenever ledger events of type
 *   approved / rejected / cancelled are recorded on lines of a document of that type (workflow decisions, auto
 *   approval, cancel, send back to draft). Handlers may record events on OTHER documents.
 */
export interface SubmitHookCtx { tenantId: string; documentId: string; docTypeKey: string; actor: DocActor }
export interface LineOutcomeCtx { tenantId: string; documentId: string; docTypeKey: string; events: LedgerEvent[]; actorId: string | null }
export type SubmitHook = (tx: Tx, ctx: SubmitHookCtx) => Promise<void>;
export type LineOutcomeHook = (tx: Tx, ctx: LineOutcomeCtx) => Promise<void>;

export const OUTCOME_EVENT_TYPES: ReadonlySet<string> = new Set(['approved', 'rejected', 'cancelled']);

@Injectable()
export class DocumentHooks {
  private readonly submit = new Map<string, SubmitHook[]>();
  private readonly outcome = new Map<string, LineOutcomeHook[]>();

  onSubmit(docTypeKey: string, fn: SubmitHook): void {
    this.submit.set(docTypeKey, [...(this.submit.get(docTypeKey) ?? []), fn]);
  }

  onLineOutcome(docTypeKey: string, fn: LineOutcomeHook): void {
    this.outcome.set(docTypeKey, [...(this.outcome.get(docTypeKey) ?? []), fn]);
  }

  get hasLineOutcomeHooks(): boolean {
    return this.outcome.size > 0;
  }

  async runSubmit(tx: Tx, ctx: SubmitHookCtx): Promise<void> {
    for (const fn of this.submit.get(ctx.docTypeKey) ?? []) await fn(tx, ctx);
  }

  async runLineOutcome(tx: Tx, ctx: LineOutcomeCtx): Promise<void> {
    const events = ctx.events.filter(e => OUTCOME_EVENT_TYPES.has(e.type));
    if (!events.length) return;
    for (const fn of this.outcome.get(ctx.docTypeKey) ?? []) await fn(tx, { ...ctx, events });
  }

  // ---------------------------------------------------------------- Phase 4 (procurement agent B, additive)
  private readonly beforeRec = new Map<string, BeforeRecordHook[]>();
  private readonly save = new Map<string, SaveHook[]>();
  private readonly resubmit = new Map<string, ResubmitHook[]>();
  private readonly extras = new Map<string, string[]>();
  private readonly draftLikeStatuses = new Map<string, Set<string>>();

  /**
   * `beforeRecord(docTypeKey, fn)`: runs at the start of every ledger write on a document of that type and returns
   * the events to record (it may drop or replace some — e.g. a PO amendment under re-approval keeps the workflow's
   * approved/rejected out of the ledger and applies deltas itself). Returning [] records nothing.
   */
  beforeRecord(docTypeKey: string, fn: BeforeRecordHook): void {
    this.beforeRec.set(docTypeKey, [...(this.beforeRec.get(docTypeKey) ?? []), fn]);
  }

  get hasBeforeRecordHooks(): boolean {
    return this.beforeRec.size > 0;
  }

  hasBeforeRecord(docTypeKey: string): boolean {
    return this.beforeRec.has(docTypeKey);
  }

  async runBeforeRecord(tx: Tx, ctx: LineOutcomeCtx): Promise<LedgerEvent[]> {
    let events = ctx.events;
    for (const fn of this.beforeRec.get(ctx.docTypeKey) ?? []) {
      if (!events.length) break;
      events = await fn(tx, { ...ctx, events });
    }
    return events;
  }

  /** `onSave(docTypeKey, fn)`: runs after header + lines were written (create, update, approver line edits, submit
   *  before numbering). Throwing (e.g. a 400 with `lines.N.<field>` paths) aborts the save. */
  onSave(docTypeKey: string, fn: SaveHook): void {
    this.save.set(docTypeKey, [...(this.save.get(docTypeKey) ?? []), fn]);
  }

  async runSave(tx: Tx, ctx: SaveHookCtx): Promise<void> {
    for (const fn of this.save.get(ctx.docTypeKey) ?? []) await fn(tx, ctx);
  }

  /** `onResubmit(docTypeKey, fn)`: POST /docs/:type/:id/submit asks these first; a hook returning true handled the
   *  submit itself (e.g. a PO amendment going back to approval) and the generic draft submit is skipped. */
  onResubmit(docTypeKey: string, fn: ResubmitHook): void {
    this.resubmit.set(docTypeKey, [...(this.resubmit.get(docTypeKey) ?? []), fn]);
  }

  async runResubmit(tx: Tx, ctx: ResubmitHookCtx): Promise<boolean> {
    for (const fn of this.resubmit.get(ctx.docTypeKey) ?? []) if (await fn(tx, ctx)) return true;
    return false;
  }

  /** Line value keys a module keeps itself (stored verbatim in line `custom`, outside the form pipeline — e.g. the
   *  PO delivery `schedule` grid inside a line). The module validates them in its `onSave` hook. */
  lineExtras(docTypeKey: string, keys: string[]): void {
    this.extras.set(docTypeKey, [...new Set([...(this.extras.get(docTypeKey) ?? []), ...keys])]);
  }

  extrasOf(docTypeKey: string): string[] {
    return this.extras.get(docTypeKey) ?? [];
  }

  /** Statuses (besides `draft`) in which an edit behaves like a draft edit (lines may be added, quantities change)
   *  and submit is offered — e.g. a PO under amendment (`amending`). The type's `editableStatuses` must include them. */
  draftLike(docTypeKey: string, statuses: string[]): void {
    this.draftLikeStatuses.set(docTypeKey, new Set([...(this.draftLikeStatuses.get(docTypeKey) ?? []), ...statuses]));
  }

  isDraftLike(docTypeKey: string, statusKey: string): boolean {
    return this.draftLikeStatuses.get(docTypeKey)?.has(statusKey) ?? false;
  }

  // ---------------------------------------------------------------- Phase 5 (GRN agent, additive)
  private readonly statusRules = new Map<string, StatusRule>();

  /** `statusRule(docTypeKey, fn)`: refines the statuses computed by `recompute` (after the generic rules, before they are
   *  stored) — e.g. a PO moves to `partially_received` / `received` from its receipt buckets. One rule per type. */
  statusRule(docTypeKey: string, fn: StatusRule): void {
    this.statusRules.set(docTypeKey, fn);
  }

  get hasStatusRules(): boolean {
    return this.statusRules.size > 0;
  }

  async runStatusRule(tx: Tx, ctx: StatusRuleCtx): Promise<{ lines: Record<string, string>; statusKey: string } | null> {
    const fn = this.statusRules.get(ctx.docTypeKey);
    return fn ? fn(tx, ctx) : null;
  }

  private readonly extra = new Map<string, ExtraStatus[]>();

  /** Status keys a module adds to a type's `statuses` list (list chips, labels), e.g. PO partially_received. Each is
   *  inserted after the outcome status `after` (default: at the end). */
  extraStatuses(docTypeKey: string, list: ExtraStatus[]): void {
    const cur = this.extra.get(docTypeKey) ?? [];
    this.extra.set(docTypeKey, [...cur.filter(c => !list.some(l => l.key === c.key)), ...list]);
  }

  extraStatusesOf(docTypeKey: string): ExtraStatus[] {
    return this.extra.get(docTypeKey) ?? [];
  }
}

export interface ExtraStatus { key: string; label: string; tone: 'neutral' | 'blue' | 'amber' | 'green' | 'red'; after?: string }

export interface StatusRuleCtx {
  tenantId: string; documentId: string; docTypeKey: string;
  /** Document status computed by the generic rules. */
  statusKey: string;
  lines: { id: string; statusKey: string; buckets: Buckets }[];
}
/** Returns the (possibly changed) line statuses by line id and the document status; null keeps the generic result. */
export type StatusRule = (tx: Tx, ctx: StatusRuleCtx) => Promise<{ lines: Record<string, string>; statusKey: string } | null>;

export type BeforeRecordHook = (tx: Tx, ctx: LineOutcomeCtx) => Promise<LedgerEvent[]>;
export interface SaveHookCtx {
  tenantId: string; documentId: string; docTypeKey: string; actor: DocActor; statusKey: string;
  mode: 'create' | 'update' | 'line_edits' | 'submit';
}
export type SaveHook = (tx: Tx, ctx: SaveHookCtx) => Promise<void>;
export interface ResubmitHookCtx extends SubmitHookCtx { statusKey: string; version: number }
export type ResubmitHook = (tx: Tx, ctx: ResubmitHookCtx) => Promise<boolean>;

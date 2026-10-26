/**
 * Pure workflow model helpers (no I/O): definition parsing, stage groups, decimal arithmetic and the per-line
 * quantity flow through (parallel) stage groups. ADR-0011.
 *
 * Quantity model. `wf_line_state` keeps, per line and stage, `pending` (not yet decided) and `held`. Inside a group
 * (one stage, or consecutive stages sharing `parallelGroup`) every participating stage sees the same quantity Q of the
 * line; the part a stage has already approved is implicit: cleared_i = Q − pending_i − held_i. Quantity leaves the
 * group as soon as every stage has cleared it (eager release), so after every operation min_i cleared_i = 0, i.e.
 *
 *     Q = max over the group's stages of (pending_i + held_i)
 *
 * which lets the engine work on the frozen schema without storing Q. A single-stage group is the degenerate case
 * (Q = pending + held, approvals leave immediately).
 */
import { Stage, WorkflowDefinition } from '@procure/schema';
import Decimal from 'decimal.js';

export type Def = WorkflowDefinition;
export type StageDef = Stage;

/** Parses stored JSON (applies schema defaults). */
export function parseDefinition(json: unknown): Def {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  return WorkflowDefinition.parse(raw ?? {});
}

export const D = (v: Decimal.Value | null | undefined): Decimal => new Decimal(v === null || v === undefined || v === '' ? 0 : v);
export const ZERO = new Decimal(0);
/** Canonical decimal string (no exponent, no trailing zeros). */
export const fmt = (d: Decimal): string => {
  const s = d.toFixed();
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

export interface Group { index: number; key: string | null; stages: string[] }

/** Consecutive stages with the same parallelGroup form one group; others are singleton groups. */
export function groupsOf(stages: Pick<StageDef, 'key' | 'parallelGroup'>[]): Group[] {
  const out: Group[] = [];
  for (const s of stages) {
    const last = out[out.length - 1];
    if (s.parallelGroup && last && last.key === s.parallelGroup) last.stages.push(s.key);
    else out.push({ index: out.length, key: s.parallelGroup ?? null, stages: [s.key] });
  }
  return out;
}

export function groupIndexOf(groups: Group[], stageKey: string): number {
  return groups.findIndex(g => g.stages.includes(stageKey));
}

/** Per line: stage -> { p: pending, h: held }. */
export type LineQty = Map<string, { p: Decimal; h: Decimal }>;

export function cell(l: LineQty, stage: string): { p: Decimal; h: Decimal } {
  let c = l.get(stage);
  if (!c) { c = { p: ZERO, h: ZERO }; l.set(stage, c); }
  return c;
}

/** Quantity of the line inside a group (see header comment). */
export function groupQty(l: LineQty, g: Group): Decimal {
  let q = ZERO;
  for (const s of g.stages) {
    const c = l.get(s);
    if (c) q = Decimal.max(q, c.p.plus(c.h));
  }
  return q;
}

/** Held measure of a line: per group the max held over its stages (parallel copies of the same qty count once). */
export function heldMeasure(l: LineQty, groups: Group[]): Decimal {
  let h = ZERO;
  for (const g of groups) {
    let m = ZERO;
    for (const s of g.stages) { const c = l.get(s); if (c) m = Decimal.max(m, c.h); }
    h = h.plus(m);
  }
  return h;
}

/** Total quantity of a line still inside the workflow. */
export function inWorkflow(l: LineQty, groups: Group[]): Decimal {
  return groups.reduce((acc, g) => acc.plus(groupQty(l, g)), ZERO);
}

/**
 * Removes `r` (rejected at `atStage`) from the other stages of the group: pending first, then held, then the
 * implicit cleared part (no state). The deciding stage has already taken `r` from its own pending.
 */
export function removeFromSiblings(l: LineQty, g: Group, atStage: string, r: Decimal) {
  if (r.lte(0)) return;
  for (const s of g.stages) {
    if (s === atStage) continue;
    const c = l.get(s);
    if (!c) continue;
    let rest = r;
    const fromP = Decimal.min(rest, c.p);
    c.p = c.p.minus(fromP);
    rest = rest.minus(fromP);
    const fromH = Decimal.min(rest, c.h);
    c.h = c.h.minus(fromH);
  }
}

/**
 * After an operation on group g: Q' = qBefore − removed + added. Releases what every stage has cleared:
 * m = Q' − max_i(pending_i + held_i). Returns m (≥ 0).
 */
export function releasable(l: LineQty, g: Group, qAfter: Decimal): Decimal {
  const m = qAfter.minus(groupQty(l, g));
  return m.gt(0) ? m : ZERO;
}

/** Adds x as pending to each of the given stages (entry into a group). */
export function enter(l: LineQty, stages: string[], x: Decimal) {
  if (x.lte(0)) return;
  for (const s of stages) { const c = cell(l, s); c.p = c.p.plus(x); }
}

/** Removes all qty of the line from a group; returns the qty that was in it. */
export function drainGroup(l: LineQty, g: Group): { qty: Decimal } {
  const qty = groupQty(l, g);
  for (const s of g.stages) { const c = l.get(s); if (c) { c.p = ZERO; c.h = ZERO; } }
  return { qty };
}

/** Zeroes every cell of the line (rows are deleted at flush). */
export function clearLine(l: LineQty) {
  for (const c of l.values()) { c.p = ZERO; c.h = ZERO; }
}

export function hasQty(l: LineQty): boolean {
  for (const c of l.values()) if (c.p.gt(0) || c.h.gt(0)) return true;
  return false;
}

export const QTY_RE = /^\d+(\.\d+)?$/;

/** Normalised line decision as stored in wf_action.decisions. */
export interface AppliedDecision {
  lineId: string; lineNo?: number; pending: string; approve: string; hold: string; reject: string; reason: string | null;
  values?: Record<string, unknown>; vote?: boolean;
}

/** Merge of quorum-'all' votes for one line: approve = min, reject = max (bounded), hold = the rest. */
export function mergeVotes(pending: Decimal, votes: { approve: Decimal; reject: Decimal }[]): { approve: Decimal; hold: Decimal; reject: Decimal } {
  if (!votes.length) return { approve: ZERO, hold: pending, reject: ZERO };
  const approve = Decimal.min(...votes.map(v => v.approve));
  const reject = Decimal.min(Decimal.max(...votes.map(v => v.reject)), pending.minus(approve));
  return { approve, reject, hold: pending.minus(approve).minus(reject) };
}

export const RESERVED_STAGE_KEYS = new Set([
  'draft', 'start', 'submit', 'complete', 'cancel', 'approved', 'rejected', 'on_hold', 'partially_approved', 'cancelled', 'closed',
]);

export const stageKeyPerm = (docType: string, stage: string) => `doc.${docType}:action.stage_${stage}`;
export const stageViewPerm = (docType: string, stage: string) => `doc.${docType}:view.waiting_${stage}`;
export const docTab = (docType: string) => `doc.${docType}`;
export const statusLabelOf = (s: Pick<StageDef, 'name' | 'statusLabel'>) => s.statusLabel || `Waiting for ${s.name}`;

export const FIXED_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', on_hold: 'On hold', partially_approved: 'Partially approved', approved: 'Approved', rejected: 'Rejected',
  cancelled: 'Cancelled', closed: 'Closed',
};

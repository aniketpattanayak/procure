/**
 * Pure helpers for the workflow designer: rows (parallel groups), structural edits, keys, the combined
 * header + `lines` definition used for condition scope, and instant local checks. The server re-validates on save
 * and publish (draftIssues); these only make mistakes visible while editing.
 */
import {
  EFFECTS, STAGE_ACTIONS, WorkflowDefinition, type Effect, type Field, type FormDefinition, type FormulaScope,
  type Stage, type WorkflowActor, type WorkflowIssue,
} from '@procure/schema';
import { compile, isDataField, scopeFromDefinition } from '@/engines/form-renderer/formula';

export type EffectName = (typeof EFFECTS)[number];
export type StageAction = (typeof STAGE_ACTIONS)[number];
export type Hook = 'onEnter' | 'onApprove' | 'onReject';
export type ReasonOn = 'reject' | 'hold' | 'send_back' | 'forward' | 'partial';

export const EMPTY_WORKFLOW: WorkflowDefinition = { version: 1, granularity: 'line', stages: [], onComplete: [], onSubmit: [] };
export const DEFAULT_ACTIONS: StageAction[] = ['approve', 'reject', 'hold', 'send_back'];
export const DEFAULT_REASONS: ReasonOn[] = ['reject', 'hold', 'send_back', 'partial'];
export const REASON_ON: ReasonOn[] = ['reject', 'hold', 'send_back', 'forward', 'partial'];

/** Module that ships an effect not yet available to this tenant (for "Available after <module>"). */
export const EFFECT_MODULE: Partial<Record<EffectName, string>> = {
  post_stock: 'store', block_stock: 'store', unblock_stock: 'store', return_to_vendor: 'grn',
  generate_pdf: 'print', send_email: 'messaging', send_whatsapp: 'messaging',
};

export interface Row {
  /** Parallel group id, null for a single stage. */
  group: string | null;
  /** Flat indexes into `stages`. */
  indexes: number[];
}

/** Consecutive stages with the same parallelGroup form one row (they run together). */
export function rowsOf(stages: readonly Stage[]): Row[] {
  const rows: Row[] = [];
  stages.forEach((s, i) => {
    const last = rows[rows.length - 1];
    if (s.parallelGroup && last && last.group === s.parallelGroup) last.indexes.push(i);
    else rows.push({ group: s.parallelGroup ?? null, indexes: [i] });
  });
  return rows;
}

export function rowIndexOfStage(stages: readonly Stage[], key: string): number {
  return rowsOf(stages).findIndex(r => r.indexes.some(i => stages[i]!.key === key));
}

// ------------------------------------------------------------------------------------------------ keys

export function keyFromName(name: string): string {
  let k = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!k) k = 'stage';
  if (!/^[a-z]/.test(k)) k = `s_${k}`;
  return k.slice(0, 31).replace(/_+$/, '');
}

export function uniqueStageKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const c = `${base.slice(0, 28)}_${i}`;
    if (!taken.has(c)) return c;
  }
}

function newGroupId(stages: readonly Stage[]): string {
  const taken = new Set(stages.map(s => s.parallelGroup).filter(Boolean));
  for (let i = 1; ; i++) if (!taken.has(`p${i}`)) return `p${i}`;
}

export function newStage(stages: readonly Stage[], name: string): Stage {
  const key = uniqueStageKey(keyFromName(name), new Set(stages.map(s => s.key)));
  return {
    key, name, enabled: true, actors: [], actions: [...DEFAULT_ACTIONS], quorum: 'any', allowSelfApproval: false,
    ifNoActor: 'assign_admins', requireReasonOn: [...DEFAULT_REASONS], editableLineFields: [],
    effects: { onEnter: [], onApprove: [], onReject: [] },
  };
}

/** Fill defaults a server definition may omit, so the editor never meets undefined arrays. */
export function normalize(def: WorkflowDefinition | null | undefined): WorkflowDefinition {
  const parsed = WorkflowDefinition.safeParse(def ?? EMPTY_WORKFLOW);
  if (parsed.success) return parsed.data;
  const d = (def ?? EMPTY_WORKFLOW) as WorkflowDefinition;
  return {
    version: d.version ?? 1, granularity: d.granularity ?? 'line', onComplete: d.onComplete ?? [], onSubmit: d.onSubmit ?? [],
    stages: (d.stages ?? []).map(s => ({
      ...s,
      enabled: s.enabled ?? true, actors: s.actors ?? [], actions: s.actions ?? [...DEFAULT_ACTIONS], quorum: s.quorum ?? 'any',
      allowSelfApproval: s.allowSelfApproval ?? false, ifNoActor: s.ifNoActor ?? 'assign_admins',
      requireReasonOn: s.requireReasonOn ?? [...DEFAULT_REASONS], editableLineFields: s.editableLineFields ?? [],
      effects: { onEnter: s.effects?.onEnter ?? [], onApprove: s.effects?.onApprove ?? [], onReject: s.effects?.onReject ?? [] },
    })),
  };
}

// ------------------------------------------------------------------------------------------------ structural edits

function flatten(rows: Stage[][]): Stage[] {
  return rows.flat();
}
function stageRows(stages: readonly Stage[]): Stage[][] {
  return rowsOf(stages).map(r => r.indexes.map(i => stages[i]!));
}
/** A group with one stage left is not parallel any more. */
function tidyGroups(rows: Stage[][]): Stage[][] {
  return rows.map(r => (r.length === 1 && r[0]!.parallelGroup ? [{ ...r[0]!, parallelGroup: undefined }] : r));
}

/** Insert a new single stage as row `rowIndex` (rows.length = at the end). */
export function insertStage(def: WorkflowDefinition, rowIndex: number, name: string): { def: WorkflowDefinition; key: string } {
  const s = newStage(def.stages, name);
  const rows = stageRows(def.stages);
  rows.splice(Math.max(0, Math.min(rowIndex, rows.length)), 0, [s]);
  return { def: { ...def, stages: flatten(rows) }, key: s.key };
}

/** Add a stage that runs in parallel with row `rowIndex`. */
export function addParallel(def: WorkflowDefinition, rowIndex: number, name: string): { def: WorkflowDefinition; key: string } {
  const rows = stageRows(def.stages);
  const row = rows[rowIndex];
  if (!row) return insertStage(def, rows.length, name);
  const group = row[0]!.parallelGroup ?? newGroupId(def.stages);
  const s = { ...newStage(def.stages, name), parallelGroup: group };
  rows[rowIndex] = [...row.map(x => ({ ...x, parallelGroup: group })), s];
  return { def: { ...def, stages: flatten(rows) }, key: s.key };
}

export function moveRow(def: WorkflowDefinition, from: number, to: number): WorkflowDefinition {
  const rows = stageRows(def.stages);
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return def;
  const [r] = rows.splice(from, 1);
  rows.splice(to, 0, r!);
  return { ...def, stages: flatten(rows) };
}

/** Move a stage left/right inside its parallel row. */
export function moveInRow(def: WorkflowDefinition, key: string, dir: -1 | 1): WorkflowDefinition {
  const i = def.stages.findIndex(s => s.key === key);
  const j = i + dir;
  const a = def.stages[i];
  const b = def.stages[j];
  if (!a || !b || !a.parallelGroup || a.parallelGroup !== b.parallelGroup) return def;
  const stages = [...def.stages];
  stages[i] = b;
  stages[j] = a;
  return { ...def, stages };
}

/** Take a stage out of its parallel row; it becomes its own row right after. */
export function detachStage(def: WorkflowDefinition, key: string): WorkflowDefinition {
  const rows = stageRows(def.stages);
  const ri = rows.findIndex(r => r.some(s => s.key === key));
  if (ri < 0 || rows[ri]!.length < 2) return def;
  const stage = rows[ri]!.find(s => s.key === key)!;
  rows[ri] = rows[ri]!.filter(s => s.key !== key);
  rows.splice(ri + 1, 0, [{ ...stage, parallelGroup: undefined }]);
  return { ...def, stages: flatten(tidyGroups(rows)) };
}

export function removeStage(def: WorkflowDefinition, key: string): WorkflowDefinition {
  const rows = stageRows(def.stages).map(r => r.filter(s => s.key !== key)).filter(r => r.length > 0);
  return { ...def, stages: flatten(tidyGroups(rows)) };
}

export function duplicateStage(def: WorkflowDefinition, key: string, copyName: (n: string) => string): { def: WorkflowDefinition; key: string } {
  const rows = stageRows(def.stages);
  const ri = rows.findIndex(r => r.some(s => s.key === key));
  const src = def.stages.find(s => s.key === key);
  if (ri < 0 || !src) return { def, key };
  const name = copyName(src.name).slice(0, 60);
  const k = uniqueStageKey(keyFromName(name), new Set(def.stages.map(s => s.key)));
  rows.splice(ri + 1, 0, [{ ...structuredClone(src), key: k, name, parallelGroup: undefined }]);
  return { def: { ...def, stages: flatten(rows) }, key: k };
}

/** Rename a stage key everywhere the definition refers to it (route_to, notify stage_actors). */
export function renameStageRefs(def: WorkflowDefinition, from: string, to: string): WorkflowDefinition {
  const fixEffect = (e: Effect): Effect => {
    if (e.effect === 'route_to' && e.stage === from) return { ...e, stage: to };
    if (e.effect === 'notify') return { ...e, to: e.to.map(r => (r.type === 'stage_actors' && r.stage === from ? { ...r, stage: to } : r)) };
    return e;
  };
  return {
    ...def,
    onSubmit: def.onSubmit.map(fixEffect),
    onComplete: def.onComplete.map(fixEffect),
    stages: def.stages.map(s => ({
      ...s,
      effects: { onEnter: s.effects.onEnter.map(fixEffect), onApprove: s.effects.onApprove.map(fixEffect), onReject: s.effects.onReject.map(fixEffect) },
    })),
  };
}

export function replaceStage(def: WorkflowDefinition, key: string, next: Stage): WorkflowDefinition {
  let d: WorkflowDefinition = { ...def, stages: def.stages.map(s => (s.key === key ? next : s)) };
  if (next.key !== key) d = renameStageRefs(d, key, next.key);
  return d;
}

// ------------------------------------------------------------------------------------------------ formula scope

/** The header form with the line form wrapped as the virtual grid `lines` (formula scope for conditions). */
export function combinedDefinition(header: FormDefinition | null | undefined, line: FormDefinition | null | undefined): FormDefinition {
  const fields: Field[] = (header?.fields ?? []).filter(f => !(isDataField(f) && f.removed) && f.key !== 'lines');
  const cols = (line?.fields ?? []).filter(f => isDataField(f) && !f.removed && f.type !== 'grid');
  if (cols.length) {
    fields.push({
      key: 'lines', type: 'grid', label: 'Lines', columns: cols, minRows: 0, maxRows: 200, system: false, required: false, readOnly: false,
      hidden: false, unique: false, removed: false, width: 12,
    } as unknown as Field);
  }
  return { version: header?.version ?? 1, fields, validations: [] };
}

export function headerUserFields(header: FormDefinition | null | undefined): { key: string; label: string }[] {
  return (header?.fields ?? [])
    .filter(f => f.type === 'lookup' && f.source.kind === 'user' && !f.removed)
    .map(f => ({ key: f.key, label: 'label' in f ? f.label : f.key }));
}

export function lineFieldOptions(line: FormDefinition | null | undefined): { key: string; label: string }[] {
  return (line?.fields ?? [])
    .filter(f => isDataField(f) && !f.removed && f.type !== 'grid' && f.type !== 'formula')
    .map(f => ({ key: f.key, label: 'label' in f ? f.label : f.key }));
}

// ------------------------------------------------------------------------------------------------ local checks

export interface Issue { path: string; code: WorkflowIssue['code'] | 'INVALID'; message: string }

export interface CheckContext {
  scope: FormulaScope | null;
  availableEffects: readonly string[];
  headerFields: Set<string> | null;
  lineFields: Set<string> | null;
  roleIds: Set<string> | null;
  msg: (code: string, vars?: Record<string, string | number>) => string;
}

function actorIssues(a: WorkflowActor, path: string, ctx: CheckContext, out: Issue[]) {
  if (a.type === 'role' && ctx.roleIds && !ctx.roleIds.has(a.roleId)) out.push({ path, code: 'UNKNOWN_ROLE', message: ctx.msg('unknownRole') });
  if (a.type === 'users' && a.userIds.length === 0) out.push({ path, code: 'INVALID', message: ctx.msg('noUsers') });
  if (a.type === 'field' && ctx.headerFields && !ctx.headerFields.has(a.field)) out.push({ path, code: 'UNKNOWN_FIELD', message: ctx.msg('unknownField', { field: a.field }) });
}

function effectIssues(list: Effect[], path: string, hook: Hook | 'onSubmit' | 'onComplete', def: WorkflowDefinition, selfKey: string | null, ctx: CheckContext, out: Issue[]) {
  list.forEach((e, i) => {
    const p = `${path}.${i}`;
    if (!ctx.availableEffects.includes(e.effect)) out.push({ path: p, code: 'EFFECT_UNAVAILABLE', message: ctx.msg('effectUnavailable', { effect: e.effect }) });
    if (e.effect === 'route_to') {
      if (hook !== 'onReject') out.push({ path: p, code: 'BAD_ROUTE', message: ctx.msg('routeOnlyReject') });
      else if (!def.stages.some(s => s.key === e.stage) || e.stage === selfKey) out.push({ path: p, code: 'BAD_ROUTE', message: ctx.msg('routeTarget') });
    }
    if (e.effect === 'notify') {
      if (!e.to.length) out.push({ path: p, code: 'INVALID', message: ctx.msg('notifyNoOne') });
      e.to.forEach((r, j) => {
        if (r.type === 'stage_actors' && !def.stages.some(s => s.key === r.stage)) out.push({ path: `${p}.to.${j}`, code: 'INVALID', message: ctx.msg('unknownStage', { stage: r.stage }) });
        else if (r.type !== 'submitter' && r.type !== 'stage_actors') actorIssues(r, `${p}.to.${j}`, ctx, out);
      });
    }
    if (e.effect === 'emit' && !/^[a-z][a-z0-9_.]{2,60}$/.test(e.event)) out.push({ path: p, code: 'INVALID', message: ctx.msg('badEvent') });
    if ((e.effect === 'send_email' || e.effect === 'send_whatsapp') && !e.template.trim()) out.push({ path: p, code: 'INVALID', message: ctx.msg('needTemplate') });
  });
}

export function localIssues(def: WorkflowDefinition, ctx: CheckContext): Issue[] {
  const out: Issue[] = [];
  const seen = new Map<string, number>();
  def.stages.forEach((s, i) => {
    const p = `stages.${i}`;
    if (!s.name.trim()) out.push({ path: `${p}.name`, code: 'INVALID', message: ctx.msg('nameRequired') });
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(s.key)) out.push({ path: `${p}.key`, code: 'INVALID', message: ctx.msg('badKey') });
    if (seen.has(s.key)) out.push({ path: `${p}.key`, code: 'DUPLICATE_STAGE', message: ctx.msg('duplicate', { key: s.key }) });
    seen.set(s.key, i);
    if (!s.actions.length) out.push({ path: `${p}.actions`, code: 'NO_ACTIONS', message: ctx.msg('noActions') });
    if (s.quorum === 'all' && !s.actors.some(a => a.type === 'role' || a.type === 'users')) out.push({ path: `${p}.quorum`, code: 'QUORUM_NEEDS_ACTORS', message: ctx.msg('quorumActors') });
    if (s.when?.trim() && ctx.scope) {
      const c = compile(s.when, ctx.scope, 'boolean');
      if (!c.ok) out.push({ path: `${p}.when`, code: 'BAD_CONDITION', message: c.errors[0]?.message ?? ctx.msg('badCondition') });
    }
    s.actors.forEach((a, j) => actorIssues(a, `${p}.actors.${j}`, ctx, out));
    if (s.sla?.escalateTo) actorIssues(s.sla.escalateTo, `${p}.sla.escalateTo`, ctx, out);
    if (s.sla && !(s.sla.hours > 0)) out.push({ path: `${p}.sla.hours`, code: 'INVALID', message: ctx.msg('slaHours') });
    if (ctx.lineFields) for (const f of s.editableLineFields) if (!ctx.lineFields.has(f)) out.push({ path: `${p}.editableLineFields`, code: 'UNKNOWN_FIELD', message: ctx.msg('unknownField', { field: f }) });
    (['onEnter', 'onApprove', 'onReject'] as const).forEach(h => effectIssues(s.effects[h], `${p}.effects.${h}`, h, def, s.key, ctx, out));
  });
  effectIssues(def.onSubmit, 'onSubmit', 'onSubmit', def, null, ctx, out);
  effectIssues(def.onComplete, 'onComplete', 'onComplete', def, null, ctx, out);
  // Parallel groups must be contiguous (rows built from consecutive stages).
  const groupRows = new Map<string, number>();
  rowsOf(def.stages).forEach((r, ri) => {
    if (!r.group) return;
    if (groupRows.has(r.group)) out.push({ path: `stages.${r.indexes[0]}.parallelGroup`, code: 'BAD_PARALLEL_GROUP', message: ctx.msg('splitGroup') });
    groupRows.set(r.group, ri);
  });
  return out;
}

export function mergeIssues(...lists: Issue[][]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const l of lists) for (const i of l) {
    const k = `${i.path}|${i.code}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

/** 'stages.2.when' -> the stage key at index 2 of `def` (the definition the issue was computed for). */
export function stageKeyForPath(def: WorkflowDefinition, path: string): string | null {
  const m = path.match(/^stages\.(\d+)/);
  return m ? def.stages[Number(m[1])]?.key ?? null : null;
}

export function scopeFor(def: FormDefinition): FormulaScope {
  return scopeFromDefinition(def);
}

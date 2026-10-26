/**
 * Definition validation (pure). Produces WorkflowIssue[] with stable codes; publish rejects when non-empty.
 */
import { compile } from '@procure/formula';
import type { Effect, FormulaScope, WorkflowActor, WorkflowIssue } from '@procure/schema';
import { Def, groupsOf, RESERVED_STAGE_KEYS } from './model';

export interface ValidationContext {
  /** Header form scope with the line form wrapped as grid `lines`. */
  scope: FormulaScope;
  roleIds: Set<string>;
  /** Active, non-deleted users. */
  userIds: Set<string>;
  /** Header lookup fields whose source is a user. */
  userFields: Set<string>;
  /** Line form data field keys (for editableLineFields). */
  lineFields: Set<string>;
  availableEffects: Set<string>;
}

type NotifyTarget = WorkflowActor | { type: 'submitter' } | { type: 'stage_actors'; stage: string };

export function validateDefinition(def: Def, ctx: ValidationContext): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const add = (path: string, code: WorkflowIssue['code'], message: string) => issues.push({ path, code, message });
  const keys = new Set<string>();
  def.stages.forEach((s, i) => {
    if (keys.has(s.key)) add(`stages.${i}.key`, 'DUPLICATE_STAGE', `Stage key "${s.key}" is used more than once.`);
    keys.add(s.key);
    if (RESERVED_STAGE_KEYS.has(s.key)) add(`stages.${i}.key`, 'RESERVED_STAGE_KEY', `"${s.key}" is reserved; choose another stage key.`);
  });

  const actor = (a: WorkflowActor, path: string) => {
    if (a.type === 'role' && !ctx.roleIds.has(a.roleId)) add(`${path}.roleId`, 'UNKNOWN_ROLE', 'This role does not exist (it may have been deleted).');
    if (a.type === 'users') a.userIds.forEach((u, k) => {
      if (!ctx.userIds.has(u)) add(`${path}.userIds.${k}`, 'UNKNOWN_USER', 'This user does not exist or is inactive.');
    });
    if (a.type === 'field' && !ctx.userFields.has(a.field)) {
      add(`${path}.field`, 'UNKNOWN_FIELD', `"${a.field}" is not a user lookup field on the header form.`);
    }
  };

  const effects = (list: Effect[], path: string, allowRoute: boolean) => list.forEach((e, k) => {
    const p = `${path}.${k}`;
    if (!ctx.availableEffects.has(e.effect)) add(p, 'EFFECT_UNAVAILABLE', `The effect "${e.effect}" is not available in your plan yet.`);
    if (e.effect === 'route_to') {
      if (!allowRoute) add(p, 'BAD_ROUTE', '"Route to stage" can only be used when a stage rejects.');
      else if (!keys.has(e.stage)) add(`${p}.stage`, 'BAD_ROUTE', `Stage "${e.stage}" does not exist.`);
    }
    if (e.effect === 'notify') (e.to as NotifyTarget[]).forEach((t, j) => {
      if (t.type === 'stage_actors') {
        if (!keys.has(t.stage)) add(`${p}.to.${j}.stage`, 'BAD_ROUTE', `Stage "${t.stage}" does not exist.`);
      } else if (t.type !== 'submitter') actor(t, `${p}.to.${j}`);
    });
  });

  def.stages.forEach((s, i) => {
    const base = `stages.${i}`;
    if (s.when !== undefined && s.when.trim() !== '') {
      const c = compile(s.when, ctx.scope, 'boolean');
      if (!c.ok) add(`${base}.when`, 'BAD_CONDITION', c.errors[0]?.message ?? 'The condition is not valid.');
      else if (c.resultType !== 'boolean' && c.resultType !== 'any') add(`${base}.when`, 'BAD_CONDITION', 'The condition must be true or false (for example total_amount > 100000).');
    }
    s.actors.forEach((a, k) => actor(a, `${base}.actors.${k}`));
    if (s.sla?.escalateTo) actor(s.sla.escalateTo, `${base}.sla.escalateTo`);
    if (!s.actions.includes('approve')) add(`${base}.actions`, 'NO_ACTIONS', 'A stage needs the "approve" action, otherwise nothing can move past it.');
    if (s.quorum === 'all' && (!s.actors.length || s.actors.some(a => a.type !== 'role' && a.type !== 'users'))) {
      add(`${base}.quorum`, 'QUORUM_NEEDS_ACTORS', '"Everyone must approve" needs explicit approvers (roles or named users).');
    }
    s.editableLineFields.forEach((f, k) => {
      if (!ctx.lineFields.has(f)) add(`${base}.editableLineFields.${k}`, 'UNKNOWN_FIELD', `"${f}" is not a field on the line form.`);
    });
    effects(s.effects.onEnter, `${base}.effects.onEnter`, false);
    effects(s.effects.onApprove, `${base}.effects.onApprove`, false);
    effects(s.effects.onReject, `${base}.effects.onReject`, true);
  });
  effects(def.onComplete, 'onComplete', false);
  effects(def.onSubmit, 'onSubmit', false);

  // Parallel groups must be contiguous: a group key may not reappear after another stage.
  const seen = new Set<string>();
  for (const g of groupsOf(def.stages)) {
    if (!g.key) continue;
    if (seen.has(g.key)) {
      const i = def.stages.findIndex(s => s.key === g.stages[0]);
      add(`stages.${i}.parallelGroup`, 'BAD_PARALLEL_GROUP', `Stages in parallel group "${g.key}" must be next to each other.`);
    }
    seen.add(g.key);
  }
  return issues;
}

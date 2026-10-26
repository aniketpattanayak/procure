import { Inject, Injectable } from '@nestjs/common';
import { evaluate, evaluateForm, scopeFromDefinition } from '@procure/formula';
import {
  EFFECTS, ErrorCode, FormDefinition, FormulaScope, SimulateResult, WorkflowDefinition, WorkflowDetail, WorkflowIssue,
} from '@procure/schema';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { RedisService } from '../../core/redis.service';
import { AppError } from '../../core/errors';
import { EFFECT_REGISTRY, EffectRegistry } from '../../core/ports';
import { composeDocumentDefinition, tenantToday } from '../forms';
import { ActorDoc, ActorsService } from './actors.service';
import { Def, docTab, parseDefinition, stageKeyPerm, stageViewPerm, statusLabelOf, StageDef } from './model';
import { validateDefinition, ValidationContext } from './validate';
import type { SimulateInput } from '@procure/schema';

export interface DocTypeRow { id: string; key: string; name: string; header_form_id: string; line_form_id: string | null }
export interface WfDefRow { id: string; doc_type_id: string; name: string; current_version_id: string | null; draft: unknown; version: number }
export interface VersionRow { id: string; version: number; definition: Def }

interface LooseField { key?: unknown; type?: unknown; removed?: unknown; source?: { kind?: unknown }; columns?: unknown }
const LAYOUT = new Set(['tab', 'section', 'divider', 'help']);
const dataFields = (def: unknown): LooseField[] => {
  const f = (def as { fields?: unknown } | null)?.fields;
  return Array.isArray(f) ? (f as LooseField[]).filter(x => typeof x?.key === 'string' && !LAYOUT.has(String(x.type)) && x.removed !== true) : [];
};

export const RETIRED_SUFFIX = ' (retired)';
/** Tenants that retained retired stage keys at publish (daily cleanup job input; actions also clean up inline). */
export const RETIRED_TENANTS_KEY = 'wf:retired:tenants';
const STAGE_KEY = /:(?:action\.stage_|view\.waiting_)([a-z][a-z0-9_]*)$/;
const stageOfKey = (key: string): string | null => STAGE_KEY.exec(key)?.[1] ?? null;

const fail = (message: string, issues: WorkflowIssue[]) =>
  new AppError(400, ErrorCode.VALIDATION, message, { issues }, issues.map(i => ({ path: i.path, message: i.message })));

/** Evaluates a stage `when` against header values + `lines` rows. Errors run the stage (fail towards more approval). */
export function evaluateWhen(stage: StageDef, input: { values: Record<string, unknown>; lines: Record<string, unknown>[]; lookups?: Record<string, Record<string, unknown> | null>; today: string }):
  { run: boolean; value?: boolean; error?: string } {
  if (!stage.when || !stage.when.trim()) return { run: true };
  const r = evaluate(stage.when, { values: { ...input.values, lines: input.lines }, lookups: input.lookups ?? {}, today: input.today });
  if (r.error) return { run: true, error: r.error.message };
  const value = r.value === true;
  return { run: value, value };
}

/**
 * Workflow definitions per document type: drafts, validation, publishing (immutable versions + stage permission
 * keys), versions and simulation. One `workflow_def` row per doc type, created on first use.
 */
@Injectable()
export class DefinitionsService {
  constructor(
    private readonly audit: AuditService,
    private readonly ent: EntitlementsService,
    private readonly actors: ActorsService,
    private readonly redis: RedisService,
    @Inject(EFFECT_REGISTRY) private readonly effects: EffectRegistry,
  ) {}

  async docType(tx: Tx, key: string): Promise<DocTypeRow> {
    const dt = await tx.selectFrom('app.doc_type').select(['id', 'key', 'name', 'header_form_id', 'line_form_id'])
      .where('key', '=', key).executeTakeFirst();
    if (!dt) throw AppError.notFound('Document type');
    return dt;
  }

  async docTypeById(tx: Tx, id: string): Promise<DocTypeRow> {
    const dt = await tx.selectFrom('app.doc_type').select(['id', 'key', 'name', 'header_form_id', 'line_form_id']).where('id', '=', id).executeTakeFirst();
    if (!dt) throw AppError.notFound('Document type');
    return dt;
  }

  /** The doc type's workflow_def row, created (no versions) when missing. */
  async ensureDef(tx: Tx, tenantId: string, dt: DocTypeRow, userId: string | null, lock = false): Promise<WfDefRow> {
    const q = () => {
      let b = tx.selectFrom('app.workflow_def').select(['id', 'doc_type_id', 'name', 'current_version_id', 'draft', 'version']).where('doc_type_id', '=', dt.id);
      if (lock) b = b.forUpdate();
      return b.executeTakeFirst();
    };
    let row = await q();
    if (!row) {
      await tx.insertInto('app.workflow_def').values({ tenant_id: tenantId, doc_type_id: dt.id, name: dt.name, created_by: userId, updated_by: userId })
        .onConflict(oc => oc.columns(['tenant_id', 'doc_type_id']).doNothing()).execute();
      row = await q();
    }
    return row!;
  }

  async versionById(tx: Tx, id: string): Promise<VersionRow> {
    const v = await tx.selectFrom('app.workflow_version').select(['id', 'version', 'definition']).where('id', '=', id).executeTakeFirstOrThrow();
    return { id: v.id, version: v.version, definition: parseDefinition(v.definition) };
  }

  /** Current published version; publishes an empty v1 (auto-approve) when the type never had a workflow. */
  async currentVersion(tx: Tx, tenantId: string, dt: DocTypeRow, userId: string | null): Promise<VersionRow> {
    const def = await this.ensureDef(tx, tenantId, dt, userId);
    if (def.current_version_id) return this.versionById(tx, def.current_version_id);
    const locked = await this.ensureDef(tx, tenantId, dt, userId, true);
    if (locked.current_version_id) return this.versionById(tx, locked.current_version_id);
    const empty = WorkflowDefinition.parse({ version: 1, stages: [] });
    const id = await this.insertVersion(tx, tenantId, locked, empty, 'Default (no approval stages)', userId);
    return { id, version: 1, definition: empty };
  }

  // ------------------------------------------------------------------------------------------- read

  async list(tx: Tx) {
    const rows = await tx.selectFrom('app.doc_type as dt')
      .leftJoin('app.workflow_def as w', 'w.doc_type_id', 'dt.id')
      .leftJoin('app.workflow_version as v', 'v.id', 'w.current_version_id')
      .select(['dt.key', 'dt.name as dt_name', 'w.name', 'w.draft', 'v.version', 'v.definition'])
      .orderBy('dt.name').execute();
    return rows.map(r => ({
      docTypeKey: r.key, name: r.name ?? r.dt_name, publishedVersion: r.version ?? null, hasDraft: r.draft != null,
      stageCount: r.definition ? parseDefinition(r.definition).stages.length : 0,
    }));
  }

  async detail(tx: Tx, tenantId: string, docTypeKey: string, userId: string | null): Promise<WorkflowDetail> {
    const dt = await this.docType(tx, docTypeKey);
    const def = await this.ensureDef(tx, tenantId, dt, userId);
    const published = def.current_version_id ? await this.versionById(tx, def.current_version_id) : null;
    const draft = def.draft != null ? parseDefinition(def.draft) : null;
    const ctx = draft ? await this.validationContext(tx, tenantId, dt) : null;
    return {
      id: def.id, docTypeKey: dt.key, name: def.name,
      published: published?.definition ?? null, publishedVersion: published?.version ?? null,
      draft, draftIssues: draft && ctx ? validateDefinition(draft, ctx) : [],
      availableEffects: [...ctx?.availableEffects ?? await this.availableEffects(tenantId)].filter((e): e is (typeof EFFECTS)[number] => (EFFECTS as readonly string[]).includes(e)),
      version: def.version,
    };
  }

  async versions(tx: Tx, docTypeKey: string) {
    const dt = await this.docType(tx, docTypeKey);
    const rows = await tx.selectFrom('app.workflow_version as v').innerJoin('app.workflow_def as w', 'w.id', 'v.workflow_id')
      .leftJoin('app.tenant_user as u', 'u.id', 'v.published_by')
      .select(['v.id', 'v.version', 'v.definition', 'v.change_note', 'v.published_at', 'u.name as published_by_name', 'w.current_version_id'])
      .where('w.doc_type_id', '=', dt.id).orderBy('v.version', 'desc').execute();
    return rows.map(r => ({
      id: r.id, version: r.version, changeNote: r.change_note, publishedAt: new Date(r.published_at).toISOString(),
      publishedBy: r.published_by_name ?? null, stageCount: parseDefinition(r.definition).stages.length, isCurrent: r.current_version_id === r.id,
    }));
  }

  async version(tx: Tx, docTypeKey: string, version: number): Promise<WorkflowDefinition> {
    const dt = await this.docType(tx, docTypeKey);
    const r = await tx.selectFrom('app.workflow_version as v').innerJoin('app.workflow_def as w', 'w.id', 'v.workflow_id')
      .select('v.definition').where('w.doc_type_id', '=', dt.id).where('v.version', '=', version).executeTakeFirst();
    if (!r) throw AppError.notFound('Workflow version');
    return parseDefinition(r.definition);
  }

  // ------------------------------------------------------------------------------------------- validation

  async availableEffects(tenantId: string): Promise<Set<string>> {
    const features = (await this.ent.state(tenantId))?.features ?? [];
    return new Set(this.effects.available(features));
  }

  private async formDef(tx: Tx, formId: string | null): Promise<FormDefinition | null> {
    if (!formId) return null;
    const r = await tx.selectFrom('app.form_def as f').leftJoin('app.form_version as v', 'v.id', 'f.current_version_id')
      .select(['v.definition', 'f.draft']).where('f.id', '=', formId).executeTakeFirst();
    return (r?.definition ?? null) as FormDefinition | null;
  }

  /** Header scope (+ `lines` grid from the line form) and the other lookups validation needs. */
  async validationContext(tx: Tx, tenantId: string, dt: DocTypeRow): Promise<ValidationContext> {
    const header = await this.formDef(tx, dt.header_form_id);
    const line = await this.formDef(tx, dt.line_form_id);
    const scope = this.scopeFor(header, line);
    const hf = dataFields(header);
    const roles = await tx.selectFrom('app.role').select('id').where('is_deleted', '=', false).execute();
    const users = await tx.selectFrom('app.tenant_user').select('id').where('is_active', '=', true).where('is_deleted', '=', false).execute();
    return {
      scope,
      roleIds: new Set(roles.map(r => r.id)),
      userIds: new Set(users.map(u => u.id)),
      userFields: new Set(hf.filter(f => f.type === 'lookup' && f.source?.kind === 'user').map(f => String(f.key))),
      lineFields: new Set(dataFields(line).map(f => String(f.key))),
      availableEffects: await this.availableEffects(tenantId),
    };
  }

  scopeFor(header: FormDefinition | null, line: FormDefinition | null): FormulaScope {
    const fields = [...(header?.fields ?? []).filter(f => f.key !== 'lines')];
    if (line) fields.push({ key: 'lines', type: 'grid', label: 'Lines', columns: line.fields } as unknown as FormDefinition['fields'][number]);
    return scopeFromDefinition({ ...(header ?? { fields: [] }), fields } as FormDefinition);
  }

  async validate(tx: Tx, tenantId: string, dt: DocTypeRow, def: Def): Promise<WorkflowIssue[]> {
    return validateDefinition(def, await this.validationContext(tx, tenantId, dt));
  }

  // ------------------------------------------------------------------------------------------- write

  async saveDraft(tx: Tx, tenantId: string, userId: string, docTypeKey: string, definition: Def, version: number): Promise<WorkflowDetail> {
    const dt = await this.docType(tx, docTypeKey);
    const def = await this.ensureDef(tx, tenantId, dt, userId, true);
    if (def.version !== version) throw AppError.versionConflict();
    await tx.updateTable('app.workflow_def').set({ draft: JSON.stringify(definition), draft_updated_at: new Date(), draft_updated_by: userId, updated_by: userId })
      .where('id', '=', def.id).execute();
    await this.audit.tenant(tx, { action: 'save_draft', entity: 'workflow', entityId: def.id, actorId: userId, after: { docType: dt.key, stages: definition.stages.map(s => s.key) } });
    return this.detail(tx, tenantId, docTypeKey, userId);
  }

  async discardDraft(tx: Tx, tenantId: string, userId: string, docTypeKey: string): Promise<WorkflowDetail> {
    const dt = await this.docType(tx, docTypeKey);
    const def = await this.ensureDef(tx, tenantId, dt, userId, true);
    if (def.draft != null) {
      await tx.updateTable('app.workflow_def').set({ draft: null, draft_updated_at: null, draft_updated_by: null, updated_by: userId }).where('id', '=', def.id).execute();
      await this.audit.tenant(tx, { action: 'discard_draft', entity: 'workflow', entityId: def.id, actorId: userId });
    }
    return this.detail(tx, tenantId, docTypeKey, userId);
  }

  /** Publishes the draft. Caller bumps permver after commit. */
  async publish(tx: Tx, tenantId: string, userId: string, docTypeKey: string, version: number, changeNote: string | null): Promise<WorkflowDetail> {
    const dt = await this.docType(tx, docTypeKey);
    const def = await this.ensureDef(tx, tenantId, dt, userId, true);
    if (def.version !== version) throw AppError.versionConflict();
    if (def.draft == null) throw AppError.conflict('There are no unpublished changes to publish.');
    const draft = parseDefinition(def.draft);
    await this.publishDefinition(tx, tenantId, dt, def, draft, changeNote, userId);
    return this.detail(tx, tenantId, docTypeKey, userId);
  }

  /** Validates and publishes `definition` as the next version (also used by the seed). Returns the version id. */
  async publishDefinition(tx: Tx, tenantId: string, dt: DocTypeRow, def: WfDefRow, definition: Def, changeNote: string | null, userId: string | null): Promise<string> {
    const issues = await this.validate(tx, tenantId, dt, definition);
    if (issues.length) throw fail('The workflow has problems that must be fixed before publishing.', issues);
    return this.insertVersion(tx, tenantId, def, definition, changeNote, userId, dt);
  }

  private async insertVersion(tx: Tx, tenantId: string, def: WfDefRow, definition: Def, changeNote: string | null, userId: string | null, dt?: DocTypeRow): Promise<string> {
    const max = await tx.selectFrom('app.workflow_version').select(sql<number>`coalesce(max(version), 0)::int`.as('v')).where('workflow_id', '=', def.id).executeTakeFirst();
    const next = (max?.v ?? 0) + 1;
    const stored = { ...definition, version: next };
    const v = await tx.insertInto('app.workflow_version').values({
      tenant_id: tenantId, workflow_id: def.id, version: next, definition: JSON.stringify(stored), change_note: changeNote, published_by: userId,
    }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('app.workflow_def').set({ current_version_id: v.id, draft: null, draft_updated_at: null, draft_updated_by: null, updated_by: userId })
      .where('id', '=', def.id).execute();
    const docType = dt ?? await this.docTypeById(tx, def.doc_type_id);
    const removed = await this.syncRegistry(tx, tenantId, docType, def.id, definition);
    await this.audit.tenant(tx, {
      action: 'publish', entity: 'workflow', entityId: def.id, actorId: userId,
      before: def.current_version_id ? { versionId: def.current_version_id } : null,
      after: { docType: docType.key, version: next, versionId: v.id, changeNote, stages: definition.stages.map(s => s.key), removedKeys: removed },
    });
    return v.id;
  }

  /**
   * Regenerates `doc.<type>:action.stage_<key>` + `doc.<type>:view.waiting_<key>` rows (source workflow) for the
   * published stages. Keys of stages that no longer exist are deleted with their grants — unless a running instance
   * (older version) still has qty pending/held at that stage: then they are kept, labelled " (retired)", and removed
   * by `cleanupRetired` once nothing references the stage. Returns the deleted keys.
   */
  async syncRegistry(tx: Tx, tenantId: string, dt: DocTypeRow, workflowId: string, definition: Def): Promise<string[]> {
    const tab = docTab(dt.key);
    const rows = definition.stages.flatMap((s, i) => [
      { key: stageKeyPerm(dt.key, s.key), kind: 'action' as const, label: `Act on ${s.name}`, sort_order: 100 + i },
      { key: stageViewPerm(dt.key, s.key), kind: 'view' as const, label: statusLabelOf(s), sort_order: 100 + i },
    ]);
    if (rows.length) {
      await tx.insertInto('app.permission_def').values(rows.map(r => ({
        tenant_id: tenantId, key: r.key, kind: r.kind, tab_key: tab, label: r.label, description: null, group_label: null,
        requires_feature: null, requires_setting: null, sort_order: r.sort_order, source: 'workflow' as const, source_id: workflowId,
      }))).onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet(eb => ({
        label: eb.ref('excluded.label'), sort_order: eb.ref('excluded.sort_order'), source: eb.ref('excluded.source'), source_id: eb.ref('excluded.source_id'),
      }))).execute();
    }
    const { deleted, retained } = await this.pruneStageKeys(tx, dt, new Set(definition.stages.map(s => s.key)));
    if (retained.length) await this.redis.client.sadd(RETIRED_TENANTS_KEY, tenantId).catch(() => undefined);
    return deleted;
  }

  /**
   * Workflow keys of `dt` whose stage is not in `current`: delete those no running instance references (and their
   * grants); label the others " (retired)".
   */
  private async pruneStageKeys(tx: Tx, dt: DocTypeRow, current: Set<string>): Promise<{ deleted: string[]; retained: string[] }> {
    const defs = await tx.selectFrom('app.permission_def').select(['key', 'label']).where('source', '=', 'workflow').where('tab_key', '=', docTab(dt.key)).execute();
    const stale = defs.map(d => ({ ...d, stage: stageOfKey(d.key) })).filter(d => d.stage !== null && !current.has(d.stage));
    if (!stale.length) return { deleted: [], retained: [] };
    const stages = [...new Set(stale.map(d => d.stage!))];
    const busy = new Set((await sql<{ stage_key: string }>`
      select distinct ls.stage_key from app.wf_line_state ls
      join app.wf_instance i on i.id = ls.instance_id and i.status = 'running'
      join app.document d on d.id = i.document_id and d.doc_type_id = ${dt.id}
      where ls.stage_key = any(${sql.val(stages)}::text[]) and (ls.pending_qty > 0 or ls.held_qty > 0)`.execute(tx)).rows.map(r => r.stage_key));
    const deleted = stale.filter(d => !busy.has(d.stage!)).map(d => d.key);
    const retained = stale.filter(d => busy.has(d.stage!));
    if (deleted.length) {
      await tx.deleteFrom('app.permission_grant').where('perm_key', 'in', deleted).execute();
      await tx.deleteFrom('app.permission_def').where('source', '=', 'workflow').where('key', 'in', deleted).execute();
    }
    for (const r of retained) {
      if (r.label.endsWith(RETIRED_SUFFIX)) continue;
      await tx.updateTable('app.permission_def').set({ label: `${r.label}${RETIRED_SUFFIX}` }).where('source', '=', 'workflow').where('key', '=', r.key).execute();
    }
    return { deleted, retained: retained.map(r => r.key) };
  }

  /**
   * Deletes retired stage keys of a doc type that no running instance references any more. Called at the end of
   * workflow actions and by the daily job. Bumps permver when something was deleted. Returns { deleted, remaining }.
   */
  async cleanupRetired(tx: Tx, tenantId: string, docTypeId: string): Promise<{ deleted: string[]; remaining: number }> {
    const dt = await this.docTypeById(tx, docTypeId);
    const has = await tx.selectFrom('app.permission_def').select('key').where('source', '=', 'workflow').where('tab_key', '=', docTab(dt.key))
      .where('label', 'like', `%${RETIRED_SUFFIX}`).limit(1).executeTakeFirst();
    if (!has) return { deleted: [], remaining: 0 };
    const wf = await tx.selectFrom('app.workflow_def').select('current_version_id').where('doc_type_id', '=', dt.id).executeTakeFirst();
    const current = wf?.current_version_id ? (await this.versionById(tx, wf.current_version_id)).definition.stages.map(s => s.key) : [];
    const r = await this.pruneStageKeys(tx, dt, new Set(current));
    if (r.deleted.length) {
      await this.audit.tenant(tx, { action: 'retire_cleanup', entity: 'workflow', entityId: dt.id, after: { docType: dt.key, deletedKeys: r.deleted } });
      await this.ent.bumpPermissions(tenantId);
    }
    return { deleted: r.deleted, remaining: r.retained.length };
  }

  /** Daily job body for one tenant: every doc type with retired keys. Returns the number of keys still retained. */
  async cleanupRetiredTenant(tx: Tx, tenantId: string): Promise<number> {
    const types = await tx.selectFrom('app.permission_def as p').innerJoin('app.doc_type as t', join => join.on(sql`p.tab_key = 'doc.' || t.key`))
      .select('t.id').distinct().where('p.source', '=', 'workflow').where('p.label', 'like', `%${RETIRED_SUFFIX}`).execute();
    let remaining = 0;
    for (const t of types) remaining += (await this.cleanupRetired(tx, tenantId, t.id)).remaining;
    return remaining;
  }

  // ------------------------------------------------------------------------------------------- simulate

  private async computeSample(tx: Tx, dt: DocTypeRow, values: Record<string, unknown>, lines: Record<string, unknown>[], today: string) {
    const header = await this.formDef(tx, dt.header_form_id);
    if (!header) return { values, lines };
    const line = await this.formDef(tx, dt.line_form_id);
    const composed = composeDocumentDefinition(header, line).def;
    try {
      const rows = lines.map((l, i) => ({ ...l, _row: `sim${i}` }));
      const ev = evaluateForm(composed, { values: { ...values, ...(line ? { lines: rows } : {}) }, today, defaultPrecision: 2 }) as { values: Record<string, unknown> };
      const keep = (v: unknown) => v !== null && v !== undefined && v !== '';
      const outValues = { ...values };
      for (const [k, v] of Object.entries(ev.values)) if (k !== 'lines' && keep(v) && !keep(outValues[k])) outValues[k] = v;
      const evRows = Array.isArray(ev.values.lines) ? ev.values.lines as Record<string, unknown>[] : [];
      const outLines = lines.map((l, i) => {
        const o = { ...l };
        for (const [k, v] of Object.entries(evRows[i] ?? {})) if (k !== '_row' && keep(v) && !keep(o[k])) o[k] = v;
        return o;
      });
      return { values: outValues, lines: outLines };
    } catch {
      return { values, lines }; // a sample the formulas cannot handle routes on what was given
    }
  }

  async simulate(tx: Tx, tenantId: string, docTypeKey: string, input: z.infer<typeof SimulateInput>): Promise<SimulateResult> {
    const dt = await this.docType(tx, docTypeKey);
    const wf = await this.ensureDef(tx, tenantId, dt, null);
    let def: Def | null = null;
    if (input.useDraft && wf.draft != null) def = parseDefinition(wf.draft);
    else if (wf.current_version_id) def = (await this.versionById(tx, wf.current_version_id)).definition;
    def ??= WorkflowDefinition.parse({ stages: [] });
    const today = await tenantToday(tx);
    const loc = typeof input.values.location === 'string'
      ? await tx.selectFrom('app.location_node').select(sql<string>`path::text`.as('path')).where('id', '=', input.values.location).executeTakeFirst().catch(() => undefined)
      : undefined;
    // QA3-BUG-009: formula fields (e.g. amount = qty × rate, total_amount = SUM(lines.amount)) are computed from the
    // sample like a real submit computes them; values the sample cannot compute keep what the caller sent.
    const { values, lines } = await this.computeSample(tx, dt, input.values, input.lines, today);
    const doc: ActorDoc = { docTypeKey: dt.key, locationPath: loc?.path ?? '', submittedBy: null, values };
    const out: SimulateResult['stages'] = [];
    for (const s of def.stages) {
      const base = { key: s.key, name: s.name, parallelGroup: s.parallelGroup ?? null };
      if (!s.enabled) { out.push({ ...base, outcome: 'disabled', actors: [] }); continue; }
      const w = evaluateWhen(s, { values, lines, today });
      if (!w.run) { out.push({ ...base, outcome: 'skipped_condition', actors: [], conditionValue: false }); continue; }
      const cond = { ...(w.value !== undefined ? { conditionValue: w.value } : {}), ...(w.error ? { error: w.error } : {}) };
      if (!loc) { out.push({ ...base, outcome: 'run', actors: await this.actors.describe(tx, s.actors), ...cond }); continue; }
      const users = await this.actors.eligibleUsers(tx, tenantId, s, doc, { limit: 20 });
      if (users.length) out.push({ ...base, outcome: 'run', actors: users.map(u => u.name), ...cond });
      else if (s.ifNoActor === 'skip') out.push({ ...base, outcome: 'no_actor_skip', actors: [], ...cond });
      else out.push({ ...base, outcome: 'no_actor_admins', actors: (await this.actors.activeAdmins(tx)).map(a => a.name), ...cond });
    }
    return { stages: out };
  }
}

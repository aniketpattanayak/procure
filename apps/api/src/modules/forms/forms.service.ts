import { Injectable } from '@nestjs/common';
import {
  ErrorCode, FormDefinition, FormDefinitionIssue, FormDetail, FormSummary, FormulaScope, FormVersionRow, MyPermissions, RenderableForm,
} from '@procure/schema';
import { sql } from 'kysely';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import {
  composeDocumentDefinition, DOC_LINES_KEY, docFormPart, docSiblingKey, isGrid, isLookup, masterAttributes, parseStoredDefinition,
} from './definition';
import { checkFormulas } from './formula.adapter';
import { checkStructure, MasterInfo, mergeForPublish } from './structure';

export interface FormRow {
  id: string;
  key: string;
  name: string;
  kind: 'master' | 'system' | 'transaction';
  is_system: boolean;
  current_version_id: string | null;
  draft: unknown;
  updated_at: Date;
  draft_updated_at: Date | null;
  version: number;
}

/** Who is acting. `perms: null` = the engine itself (provisioning, seed): no field-access restrictions. */
export interface Actor {
  tenantId: string;
  userId: string | null;
  perms: MyPermissions | null;
}

const FORM_COLS = ['id', 'key', 'name', 'kind', 'is_system', 'current_version_id', 'draft', 'updated_at', 'draft_updated_at', 'version'] as const;

const invalid = (message: string, errors: { path: string; message: string }[], meta?: Record<string, unknown>) =>
  new AppError(400, ErrorCode.VALIDATION, message, meta, errors);

/**
 * Form definitions: drafts, structural + formula checks, immutable published versions, renderable forms.
 * Every method takes the caller's transaction and filters by tenant explicitly, so the same code runs in request
 * transactions (RLS) and inside tenant provisioning (platform role).
 */
@Injectable()
export class FormsService {
  constructor(private readonly audit: AuditService) {}

  // ------------------------------------------------------------------ reads
  async list(tx: Tx, tenantId: string): Promise<FormSummary[]> {
    const rows = await tx.selectFrom('app.form_def as f').leftJoin('app.form_version as v', 'v.id', 'f.current_version_id')
      .select(FORM_COLS.map(c => `f.${c}` as const)).select('v.version as current_version')
      .where('f.tenant_id', '=', tenantId).orderBy('f.kind').orderBy('f.name').execute();
    return rows.map(r => toSummary(r as FormRow, r.current_version));
  }

  async load(tx: Tx, tenantId: string, key: string, lock = false): Promise<FormRow> {
    let q = tx.selectFrom('app.form_def').select([...FORM_COLS]).where('tenant_id', '=', tenantId).where('key', '=', key);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw AppError.notFound('Form');
    return r as FormRow;
  }

  async loadById(tx: Tx, tenantId: string, id: string): Promise<FormRow> {
    const r = await tx.selectFrom('app.form_def').select([...FORM_COLS]).where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirst();
    if (!r) throw AppError.notFound('Form');
    return r as FormRow;
  }

  /** Published version (id, number, definition). */
  async version(tx: Tx, tenantId: string, versionId: string) {
    const v = await tx.selectFrom('app.form_version').select(['id', 'form_id', 'version', 'definition'])
      .where('tenant_id', '=', tenantId).where('id', '=', versionId).executeTakeFirst();
    if (!v) throw AppError.notFound('Form version');
    return { id: v.id, formId: v.form_id, version: v.version, definition: parseStoredDefinition(v.definition) };
  }

  /** Definitions of several versions in one query (lists of records saved on different versions). */
  async versionsById(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, FormDefinition>> {
    const m = new Map<string, FormDefinition>();
    const uniq = [...new Set(ids)];
    if (!uniq.length) return m;
    const rows = await tx.selectFrom('app.form_version').select(['id', 'definition']).where('tenant_id', '=', tenantId).where('id', 'in', uniq).execute();
    for (const r of rows) m.set(r.id, parseStoredDefinition(r.definition));
    return m;
  }

  async current(tx: Tx, tenantId: string, form: FormRow) {
    if (!form.current_version_id) throw AppError.conflict(`The form "${form.name}" has not been published yet.`);
    return this.version(tx, tenantId, form.current_version_id);
  }

  async detail(tx: Tx, tenantId: string, key: string): Promise<FormDetail> {
    const form = await this.load(tx, tenantId, key);
    return this.toDetail(tx, tenantId, form);
  }

  private async toDetail(tx: Tx, tenantId: string, form: FormRow): Promise<FormDetail> {
    const cur = form.current_version_id ? await this.version(tx, tenantId, form.current_version_id) : null;
    const draft = form.draft ? parseStoredDefinition(form.draft) : null;
    const draftIssues = draft ? await this.issues(tx, tenantId, draft, form, cur?.definition ?? null) : [];
    return { ...toSummary(form, cur?.version ?? null), published: cur?.definition ?? null, draft, draftIssues, version: form.version };
  }

  async versions(tx: Tx, tenantId: string, key: string): Promise<FormVersionRow[]> {
    const form = await this.load(tx, tenantId, key);
    const rows = await tx.selectFrom('app.form_version as v')
      .leftJoin('app.tenant_user as u', j => j.onRef('u.id', '=', 'v.published_by').onRef('u.tenant_id', '=', 'v.tenant_id'))
      .select(['v.id', 'v.version', 'v.published_at', 'v.published_by', 'v.change_note', 'u.name as published_by_name'])
      .where('v.tenant_id', '=', tenantId).where('v.form_id', '=', form.id).orderBy('v.version', 'desc').execute();
    return rows.map(r => ({
      id: r.id, version: r.version, publishedAt: new Date(r.published_at).toISOString(), publishedBy: r.published_by,
      publishedByName: r.published_by_name ?? null, changeNote: r.change_note,
    }));
  }

  async versionDefinition(tx: Tx, tenantId: string, key: string, version: number): Promise<FormDefinition> {
    const form = await this.load(tx, tenantId, key);
    const v = await tx.selectFrom('app.form_version').select('definition')
      .where('tenant_id', '=', tenantId).where('form_id', '=', form.id).where('version', '=', version).executeTakeFirst();
    if (!v) throw AppError.notFound('Form version');
    return parseStoredDefinition(v.definition);
  }

  /**
   * Fields of master `masterKey` that published forms cascade on: every `filterBy.targetField` of a lookup (header or
   * grid column) whose source is that master, in the current version of any form.
   */
  async cascadeTargets(tx: Tx, tenantId: string, masterKey: string): Promise<Set<string>> {
    const rows = await tx.selectFrom('app.form_def as f').innerJoin('app.form_version as v', 'v.id', 'f.current_version_id')
      .select('v.definition').where('f.tenant_id', '=', tenantId)
      .where(sql<boolean>`v.definition::text like ${`%"masterKey": "${masterKey}"%`} or v.definition::text like ${`%"masterKey":"${masterKey}"%`}`)
      .execute();
    const out = new Set<string>();
    const visit = (f: { type: string; removed?: boolean }) => {
      if (!isLookup(f) || f.removed || f.source.kind !== 'master' || f.source.masterKey !== masterKey) return;
      for (const flt of f.filterBy) out.add(flt.targetField);
    };
    for (const r of rows) {
      for (const f of parseStoredDefinition(r.definition).fields) {
        visit(f);
        if (isGrid(f)) f.columns.forEach(visit);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ checks
  /** Masters of the tenant with their current definitions (for lookup/filter/autofill checks). */
  async mastersInfo(tx: Tx, tenantId: string): Promise<Map<string, MasterInfo>> {
    const rows = await tx.selectFrom('app.master_def as m').innerJoin('app.form_def as f', 'f.id', 'm.form_id')
      .leftJoin('app.form_version as v', 'v.id', 'f.current_version_id')
      .select(['m.key', 'm.is_active', 'v.definition']).where('m.tenant_id', '=', tenantId).execute();
    return new Map(rows.map(r => [r.key, { active: r.is_active, def: r.definition ? parseStoredDefinition(r.definition) : null }]));
  }

  /** Structural + formula issues for `def` as a new version of `form` (or of a new form of `kind`). */
  async issues(
    tx: Tx, tenantId: string, def: FormDefinition, form: (Pick<FormRow, 'id' | 'kind'> & { key?: string }) | null, published: FormDefinition | null,
    opts: { selfMasterKey?: string; masters?: Map<string, MasterInfo>; sibling?: FormDefinition | null } = {},
  ): Promise<FormDefinitionIssue[]> {
    const masters = opts.masters ?? await this.mastersInfo(tx, tenantId);
    let selfMasterKey = opts.selfMasterKey;
    if (!selfMasterKey && form?.id) {
      const m = await tx.selectFrom('app.master_def').select('key').where('tenant_id', '=', tenantId).where('form_id', '=', form.id).executeTakeFirst();
      selfMasterKey = m?.key;
    }
    const structural = checkStructure(def, { kind: form?.kind ?? 'master', published, masters, selfMasterKey });
    const part = docFormPart(form);
    if (part) return [...structural, ...await this.documentFormulaIssues(tx, tenantId, def, form!.key!, part, masters, opts.sibling)];
    const formula = checkFormulas(def, lookupAttributesFor(def, masters, selfMasterKey));
    return [...structural, ...formula];
  }

  /**
   * Document type forms (`<type>_header` / `<type>_line`, Phase 3): formulas are checked on the header with the line
   * form wrapped as the virtual grid `lines`, so `SUM(lines.amount)` and line formulas reading header fields resolve.
   * `sibling` = the other half (default: its current published version). Issue paths point into the form being
   * checked; problems the change causes in the other half are reported with a `header:` / `line:` path prefix.
   */
  private async documentFormulaIssues(
    tx: Tx, tenantId: string, def: FormDefinition, key: string, part: 'header' | 'line', masters: Map<string, MasterInfo>,
    sibling: FormDefinition | null | undefined,
  ): Promise<FormDefinitionIssue[]> {
    let other = sibling;
    if (other === undefined) {
      const s = await tx.selectFrom('app.form_def as f').leftJoin('app.form_version as v', 'v.id', 'f.current_version_id').select('v.definition')
        .where('f.tenant_id', '=', tenantId).where('f.key', '=', docSiblingKey(key, part)).executeTakeFirst();
      other = s?.definition ? parseStoredDefinition(s.definition) : null;
    }
    const empty: FormDefinition = { version: 1, fields: [], validations: [] };
    const header = part === 'header' ? def : other ?? empty;
    const line = part === 'line' ? def : other ?? null;
    const c = composeDocumentDefinition(header, line);
    const out: FormDefinitionIssue[] = [];
    if (part === 'header') {
      def.fields.forEach((f, i) => {
        if (f.key === DOC_LINES_KEY && !f.removed) out.push({ path: `fields.${i}.key`, code: 'RESERVED_KEY', message: `"${DOC_LINES_KEY}" is reserved for the document lines.` });
      });
    }
    const mine = part === 'header' ? 'header' : 'line';
    for (const issue of checkFormulas(c.def, lookupAttributesFor(c.def, masters))) {
      const m = /^fields\.(\d+)(.*)$/.exec(issue.path);
      let where: 'header' | 'line' = 'header';
      let path = issue.path;
      if (m && Number(m[1]) >= c.headerCount) {
        const col = /^\.columns\.(\d+)(.*)$/.exec(m[2]!);
        where = 'line';
        path = col ? `fields.${c.lineIndex[Number(col[1])]}${col[2]}` : 'fields';
      }
      out.push(where === mine ? { ...issue, path } : { ...issue, path: `${where}:${path}`, message: `${where === 'header' ? 'Header' : 'Line'} form: ${issue.message}` });
    }
    return out;
  }

  /** POST /config/forms/validate */
  async validate(tx: Tx, tenantId: string, def: FormDefinition, formKey?: string): Promise<FormDefinitionIssue[]> {
    if (!formKey) return this.issues(tx, tenantId, def, null, null);
    const form = await this.load(tx, tenantId, formKey);
    const cur = form.current_version_id ? await this.version(tx, tenantId, form.current_version_id) : null;
    return this.issues(tx, tenantId, def, form, cur?.definition ?? null);
  }

  // ------------------------------------------------------------------ writes
  async saveDraft(tx: Tx, actor: Actor, key: string, def: FormDefinition, version: number): Promise<FormDetail> {
    const form = await this.load(tx, actor.tenantId, key, true);
    if (form.version !== version) throw AppError.versionConflict();
    const cur = form.current_version_id ? await this.version(tx, actor.tenantId, form.current_version_id) : null;
    const draft = { ...def, version: (cur?.version ?? 0) + 1 };
    await tx.updateTable('app.form_def')
      .set({ draft: JSON.stringify(draft), draft_updated_at: new Date(), draft_updated_by: actor.userId, updated_by: actor.userId })
      .where('tenant_id', '=', actor.tenantId).where('id', '=', form.id).execute();
    await this.audit.tenant(tx, { action: 'draft_save', entity: 'form', entityId: form.id, after: { key, version: draft.version }, actorId: actor.userId });
    return this.detail(tx, actor.tenantId, key);
  }

  async discardDraft(tx: Tx, actor: Actor, key: string): Promise<FormDetail> {
    const form = await this.load(tx, actor.tenantId, key, true);
    if (form.draft) {
      await tx.updateTable('app.form_def').set({ draft: null, draft_updated_at: new Date(), draft_updated_by: actor.userId, updated_by: actor.userId })
        .where('tenant_id', '=', actor.tenantId).where('id', '=', form.id).execute();
      await this.audit.tenant(tx, { action: 'draft_discard', entity: 'form', entityId: form.id, after: { key }, actorId: actor.userId });
    }
    return this.detail(tx, actor.tenantId, key);
  }

  /**
   * Publishes the draft as version N+1: rejects with every issue, carries removed fields forward as `removed: true`,
   * points `current_version_id` at it and clears the draft. Caller bumps permver after commit.
   */
  async publish(tx: Tx, actor: Actor, key: string, version: number, changeNote?: string): Promise<FormDetail> {
    const form = await this.load(tx, actor.tenantId, key, true);
    if (form.version !== version) throw AppError.versionConflict();
    if (!form.draft) throw AppError.conflict('There are no unpublished changes to publish.');
    const draft = parseStoredDefinition(form.draft);
    await this.publishDefinition(tx, actor, form, draft, changeNote ?? null);
    return this.detail(tx, actor.tenantId, key);
  }

  /** Shared by publish, master creation and the template installer. Returns the new version id. */
  async publishDefinition(
    tx: Tx, actor: Actor, form: FormRow, def: FormDefinition, changeNote: string | null, selfMasterKey?: string, sibling?: FormDefinition | null,
  ): Promise<string> {
    const cur = form.current_version_id ? await this.version(tx, actor.tenantId, form.current_version_id) : null;
    const issues = await this.issues(tx, actor.tenantId, def, form, cur?.definition ?? null, { selfMasterKey, sibling });
    if (issues.length) {
      throw invalid('The form has problems that must be fixed before publishing.', issues.map(i => ({ path: i.path, message: i.message })), { issues });
    }
    const next = (cur?.version ?? 0) + 1;
    const merged = mergeForPublish(def, cur?.definition ?? null, next);
    const v = await tx.insertInto('app.form_version').values({
      tenant_id: actor.tenantId, form_id: form.id, version: next, definition: JSON.stringify(merged), change_note: changeNote, published_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await tx.updateTable('app.form_def')
      .set({ current_version_id: v.id, draft: null, draft_updated_at: null, draft_updated_by: null, updated_by: actor.userId })
      .where('tenant_id', '=', actor.tenantId).where('id', '=', form.id).execute();
    await this.audit.tenant(tx, {
      action: 'publish', entity: 'form', entityId: form.id, actorId: actor.userId,
      before: cur ? { version: cur.version } : null, after: { key: form.key, version: next, versionId: v.id, changeNote },
    });
    return v.id;
  }

  /** Creates a form and publishes version 1 (masters, system forms). */
  async createPublished(
    tx: Tx, actor: Actor,
    f: { key: string; name: string; kind: FormRow['kind']; isSystem: boolean; definition: FormDefinition; selfMasterKey?: string; sibling?: FormDefinition | null },
  ): Promise<{ form: FormRow; versionId: string }> {
    const exists = await tx.selectFrom('app.form_def').select('id').where('tenant_id', '=', actor.tenantId).where('key', '=', f.key).executeTakeFirst();
    if (exists) throw AppError.conflict(`A form with key "${f.key}" already exists.`, { field: 'key' });
    const row = await tx.insertInto('app.form_def').values({
      tenant_id: actor.tenantId, key: f.key, name: f.name, kind: f.kind, is_system: f.isSystem, created_by: actor.userId, updated_by: actor.userId,
    }).returning([...FORM_COLS]).executeTakeFirstOrThrow();
    const form = row as FormRow;
    await this.audit.tenant(tx, { action: 'create', entity: 'form', entityId: form.id, after: { key: f.key, name: f.name, kind: f.kind }, actorId: actor.userId });
    const versionId = await this.publishDefinition(tx, actor, form, f.definition, 'Initial version', f.selfMasterKey, f.sibling);
    return { form: await this.loadById(tx, actor.tenantId, form.id), versionId };
  }

  // ------------------------------------------------------------------ render
  async render(tx: Tx, actor: Actor, key: string, versionId?: string): Promise<RenderableForm> {
    const form = await this.load(tx, actor.tenantId, key);
    const v = versionId ? await this.version(tx, actor.tenantId, versionId) : await this.current(tx, actor.tenantId, form);
    if (v.formId !== form.id) throw AppError.notFound('Form version');
    const access = fieldAccessOf(actor.perms, key);
    return { formKey: key, formVersionId: v.id, definition: stripHidden(v.definition, access), readOnlyFields: Object.keys(access).filter(k => access[k] === 'readonly') };
  }
}

// ------------------------------------------------------------------ helpers

export function toSummary(r: FormRow, currentVersion: number | null): FormSummary {
  return {
    id: r.id, key: r.key, name: r.name, kind: r.kind, isSystem: r.is_system, currentVersion, hasDraft: r.draft !== null && r.draft !== undefined,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/** formKey -> fieldKey -> 'hidden' | 'readonly' for the caller (engine actor: nothing restricted). */
export function fieldAccessOf(perms: MyPermissions | null, formKey: string): Record<string, 'hidden' | 'readonly'> {
  return perms?.fieldAccess?.[formKey] ?? {};
}

/** Removes fields (and grid columns, keyed `<grid>.<col>`) hidden for the caller. */
export function stripHidden(def: FormDefinition, access: Record<string, 'hidden' | 'readonly'>): FormDefinition {
  if (!Object.values(access).includes('hidden')) return def;
  const out = structuredClone(def);
  out.fields = out.fields.filter(f => access[f.key] !== 'hidden');
  for (const f of out.fields) if (isGrid(f)) f.columns = f.columns.filter(c => access[`${f.key}.${c.key}`] !== 'hidden');
  return out;
}

/** Lookup attribute types for formula checks: header and grid-column lookups. */
export function lookupAttributesFor(def: FormDefinition, masters: Map<string, MasterInfo>, selfMasterKey?: string): FormulaScope['lookupAttributes'] {
  const out: FormulaScope['lookupAttributes'] = {};
  // Header lookups keyed by field key, grid-column lookups by '<grid>.<column>' (formula scope convention).
  const visit = (f: { key: string; type: string }, key: string) => {
    if (!isLookup(f)) return;
    const s = f.source;
    if (s.kind === 'master') out[key] = masterAttributes(s.masterKey === selfMasterKey ? def : masters.get(s.masterKey)?.def ?? null);
    else if (s.kind === 'user') out[key] = { name: 'text', email: 'text', phone: 'text' };
    else out[key] = { code: 'text', name: 'text' };
  };
  for (const f of def.fields) {
    visit(f, f.key);
    if (isGrid(f)) f.columns.forEach(c => visit(c, `${f.key}.${c.key}`));
  }
  return out;
}

export const tenantToday = async (tx: Tx): Promise<string> => {
  const r = await sql<{ timezone: string | null }>`select timezone from app.my_tenant_state()`.execute(tx);
  const tz = r.rows[0]?.timezone ?? 'Asia/Kolkata';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

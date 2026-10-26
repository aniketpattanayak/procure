import { Injectable } from '@nestjs/common';
import { DocTypeCreate, DocTypeSettings, DocTypeSummary, DocTypeUpdate, perm } from '@procure/schema';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { FormsService } from '../forms';
import { buildDocForm, headerSystemFields, lineSystemFields } from './forms-def';
import { NumberingService } from './numbering.service';
import { STATUS_LABELS, STATUS_TONES, waitingKey } from './status';
import { WorkflowLink } from './workflow-link';
import { DocumentHooks } from './hooks';
import {
  DOC_ACTIONS, DOC_TYPE_COLS, DOC_VIEWS, DocActor, docTab, DocTypeRow, headerFormKey, lineFormKey, settingsOf,
} from './types';

/**
 * Document types (contract "Document types & numbering"): a type = header form + optional line form + settings,
 * with generated permission keys (source `form`) and a default numbering series. Callers bump permver after commit.
 */
@Injectable()
export class DocTypesService {
  constructor(
    private readonly forms: FormsService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly wf: WorkflowLink,
    private readonly hooks: DocumentHooks,
  ) {}

  async find(tx: Tx, tenantId: string, key: string, lock = false): Promise<DocTypeRow | undefined> {
    let q = tx.selectFrom('app.doc_type').select([...DOC_TYPE_COLS]).where('tenant_id', '=', tenantId).where('key', '=', key);
    if (lock) q = q.forUpdate();
    return (await q.executeTakeFirst()) as DocTypeRow | undefined;
  }

  async load(tx: Tx, tenantId: string, key: string, lock = false): Promise<DocTypeRow> {
    const t = await this.find(tx, tenantId, key, lock);
    if (!t) throw AppError.notFound('Document type');
    return t;
  }

  async loadById(tx: Tx, tenantId: string, id: string): Promise<DocTypeRow> {
    const t = await tx.selectFrom('app.doc_type').select([...DOC_TYPE_COLS]).where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirst();
    if (!t) throw AppError.notFound('Document type');
    return t as DocTypeRow;
  }

  /** GET /doc-types: types the caller can view; config viewers (and the engine) see all, including inactive ones. */
  async list(tx: Tx, actor: DocActor): Promise<DocTypeSummary[]> {
    const rows = (await tx.selectFrom('app.doc_type').select([...DOC_TYPE_COLS]).where('tenant_id', '=', actor.tenantId)
      .orderBy('kind', 'desc').orderBy('name').execute()) as DocTypeRow[];
    const keys = new Set(actor.perms?.keys ?? []);
    const designer = !actor.perms || keys.has('config.doc_types:action.view');
    const visible = rows.filter(r => designer || (r.is_active && keys.has(perm.action(docTab(r.key), 'view'))));
    const out: DocTypeSummary[] = [];
    for (const r of visible) out.push(await this.summary(tx, r));
    return out;
  }

  /** Status keys + labels (draft, one per workflow stage of the current version, outcomes) in display order. */
  async statuses(tx: Tx, t: Pick<DocTypeRow, 'id'> & { key?: string }): Promise<DocTypeSummary['statuses']> {
    const stages = await this.wf.statusKeys(tx, t.id);
    const out: DocTypeSummary['statuses'] = [
      { key: 'draft', label: STATUS_LABELS.draft!, tone: STATUS_TONES.draft! },
      ...stages.map(s => ({ key: s.key, label: s.label, tone: 'blue' as const })),
      ...['on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'].map(k => ({ key: k, label: STATUS_LABELS[k]!, tone: STATUS_TONES[k]! })),
    ];
    // Phase 5 (DocumentHooks.extraStatuses): module statuses, e.g. PO partially_received / received.
    for (const x of t.key ? this.hooks.extraStatusesOf(t.key) : []) {
      if (out.some(o => o.key === x.key)) continue;
      const at = x.after ? out.findIndex(o => o.key === x.after) : -1;
      out.splice(at >= 0 ? at + 1 : out.length, 0, { key: x.key, label: x.label, tone: x.tone });
    }
    return out;
  }

  async summary(tx: Tx, t: DocTypeRow): Promise<DocTypeSummary> {
    return {
      id: t.id, key: t.key, name: t.name, pluralName: t.plural_name, description: t.description, kind: t.kind, isActive: t.is_active,
      headerFormKey: headerFormKey(t.key), lineFormKey: t.line_form_id ? lineFormKey(t.key) : null, settings: settingsOf(t),
      statuses: await this.statuses(tx, t), version: t.version,
    };
  }

  /** Writes (or refreshes labels of) the static registry rows of a type (tab, actions, outcome views). */
  async upsertRegistry(tx: Tx, tenantId: string, t: Pick<DocTypeRow, 'id' | 'key' | 'name' | 'plural_name' | 'module_key'>) {
    const tab = docTab(t.key);
    const rows = [
      { key: tab, kind: 'tab' as const, label: t.plural_name, group_label: 'Modules', sort_order: 300 },
      ...DOC_ACTIONS.map((a, i) => ({ key: perm.action(tab, a.name), kind: 'action' as const, label: a.label(t.name, t.plural_name), group_label: null, sort_order: i + 1 })),
      ...DOC_VIEWS.map((v, i) => ({ key: perm.view(tab, v.name), kind: 'view' as const, label: v.label, group_label: null, sort_order: i === 0 ? 1 : 100 + i })),
    ];
    await tx.insertInto('app.permission_def').values(rows.map(r => ({
      tenant_id: tenantId, key: r.key, kind: r.kind, tab_key: tab, label: r.label, description: null, group_label: r.group_label,
      requires_feature: t.module_key, requires_setting: null, sort_order: r.sort_order, source: 'form' as const, source_id: t.id,
    }))).onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet(eb => ({
      label: eb.ref('excluded.label'), group_label: eb.ref('excluded.group_label'), source_id: eb.ref('excluded.source_id'),
    }))).execute();
  }

  /** Custom document types count against `custom_forms` together with custom masters (one per type). */
  private async enforceLimit(tx: Tx, tenantId: string) {
    const r = await sql<{ lim: string | null }>`select app.lock_tenant_for_limit('custom_forms') as lim`.execute(tx);
    const lim = r.rows[0]?.lim;
    const limit = lim === null || lim === undefined ? null : Number(lim);
    if (limit === null) return;
    const used = await sql<{ n: string }>`
      select ((select count(*) from app.master_def where tenant_id = ${tenantId} and not is_system)
            + (select count(*) from app.doc_type where tenant_id = ${tenantId} and kind = 'custom'))::text as n`.execute(tx);
    const n = Number(used.rows[0]?.n ?? 0);
    if (n + 1 > limit) throw AppError.limitExceeded('custom_forms', limit, n, 'custom forms / masters / document types');
  }

  async create(tx: Tx, actor: DocActor, input: z.infer<typeof DocTypeCreate>, opts: { kind?: 'system' | 'custom'; moduleKey?: string | null } = {}): Promise<DocTypeSummary> {
    const kind = opts.kind ?? 'custom';
    if (kind === 'custom') await this.enforceLimit(tx, actor.tenantId);
    const hKey = headerFormKey(input.key);
    const lKey = lineFormKey(input.key);
    const clash = await this.find(tx, actor.tenantId, input.key)
      ?? await tx.selectFrom('app.form_def').select('id').where('tenant_id', '=', actor.tenantId).where('key', 'in', [hKey, lKey, input.key]).executeTakeFirst();
    if (clash) throw AppError.conflict(`The key "${input.key}" is already used by another document type or form.`, { field: 'key' });

    const header = buildDocForm('header', headerSystemFields(input.hasLines), input.headerDefinition);
    const line = input.hasLines ? buildDocForm('line', lineSystemFields(input.itemLines), input.lineDefinition) : null;
    const formActor = { tenantId: actor.tenantId, userId: actor.userId, perms: null };
    // Line form first (its formulas may read header fields), each checked against the other half.
    const lineForm = line
      ? await this.forms.createPublished(tx, formActor, { key: lKey, name: `${input.name} line`, kind: 'transaction', isSystem: kind === 'system', definition: line, sibling: header })
      : null;
    const headerForm = await this.forms.createPublished(tx, formActor, { key: hKey, name: input.name, kind: 'transaction', isSystem: kind === 'system', definition: header, sibling: line });

    const settings = DocTypeSettings.parse(input.settings ?? {});
    if (!input.hasLines) settings.itemWiseView = false;
    const row = (await tx.insertInto('app.doc_type').values({
      tenant_id: actor.tenantId, key: input.key, name: input.name, plural_name: input.pluralName, description: input.description ?? null,
      kind, module_key: opts.moduleKey ?? null, header_form_id: headerForm.form.id, line_form_id: lineForm?.form.id ?? null,
      settings: JSON.stringify(settings), created_by: actor.userId, updated_by: actor.userId,
    }).returning([...DOC_TYPE_COLS]).executeTakeFirstOrThrow()) as DocTypeRow;
    await this.upsertRegistry(tx, actor.tenantId, row);
    await this.numbering.createDefault(tx, actor, row, input.numberPattern);
    const out = await this.summary(tx, row);
    await this.audit.tenant(tx, { action: 'create', entity: 'doc_type', entityId: row.id, after: { key: row.key, name: row.name, kind, hasLines: input.hasLines, settings }, actorId: actor.userId });
    return out;
  }

  async update(tx: Tx, actor: DocActor, key: string, input: z.infer<typeof DocTypeUpdate>): Promise<DocTypeSummary> {
    const before = await this.load(tx, actor.tenantId, key, true);
    if (before.version !== input.version) throw AppError.versionConflict();
    const set: Record<string, unknown> = { updated_by: actor.userId };
    if (input.name !== undefined) set.name = input.name;
    if (input.pluralName !== undefined) set.plural_name = input.pluralName;
    if (input.description !== undefined) set.description = input.description;
    if (input.settings !== undefined) {
      const s = DocTypeSettings.parse(input.settings);
      if (!before.line_form_id) s.itemWiseView = false;
      set.settings = JSON.stringify(s);
    }
    await tx.updateTable('app.doc_type').set(set).where('tenant_id', '=', actor.tenantId).where('id', '=', before.id).execute();
    const after = await this.load(tx, actor.tenantId, key);
    if (input.name !== undefined) {
      await tx.updateTable('app.form_def').set({ name: after.name, updated_by: actor.userId }).where('tenant_id', '=', actor.tenantId).where('id', '=', after.header_form_id).execute();
      if (after.line_form_id) {
        await tx.updateTable('app.form_def').set({ name: `${after.name} line`, updated_by: actor.userId }).where('tenant_id', '=', actor.tenantId).where('id', '=', after.line_form_id).execute();
      }
    }
    await this.upsertRegistry(tx, actor.tenantId, after);
    await this.audit.tenant(tx, {
      action: 'update', entity: 'doc_type', entityId: after.id, actorId: actor.userId,
      before: { name: before.name, pluralName: before.plural_name, description: before.description, settings: settingsOf(before) },
      after: { name: after.name, pluralName: after.plural_name, description: after.description, settings: settingsOf(after) },
    });
    return this.summary(tx, after);
  }

  async setActive(tx: Tx, actor: DocActor, key: string, active: boolean): Promise<DocTypeSummary> {
    const t = await this.load(tx, actor.tenantId, key, true);
    if (t.is_active !== active) {
      await tx.updateTable('app.doc_type').set({ is_active: active, updated_by: actor.userId }).where('tenant_id', '=', actor.tenantId).where('id', '=', t.id).execute();
      await this.audit.tenant(tx, { action: active ? 'activate' : 'deactivate', entity: 'doc_type', entityId: t.id, before: { isActive: t.is_active }, after: { isActive: active }, actorId: actor.userId });
    }
    return this.summary(tx, await this.load(tx, actor.tenantId, key));
  }

  /** Stage order + waiting labels of the type's current workflow (empty without a workflow). */
  async stageInfo(tx: Tx, typeId: string): Promise<{ order: string[]; labels: Record<string, string> }> {
    const stages = await this.wf.statusKeys(tx, typeId);
    return { order: stages.map(s => s.key.replace(/^waiting_/, '')), labels: Object.fromEntries(stages.map(s => [s.key.startsWith('waiting_') ? s.key : waitingKey(s.key), s.label])) };
  }
}

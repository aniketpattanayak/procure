import { Injectable, OnModuleInit } from '@nestjs/common';
import type { CatalogueField, FormDefinition, MyPermissions, SourceCatalogue } from '@procure/schema';
import { Expression, RawBuilder, sql, SqlBool } from 'kysely';
import type { Tx } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { AppError } from '../../core/errors';
import { DocStore, DocTypesService } from '../documents';
import { FormsService, MastersService } from '../forms';
import { scopeCondition, ScopeService } from '../permissions';
import { poFollowupSource, vendorQuoteSource } from '../procurement';
import { installPackSources } from './pack/sources';
import { viewerFields } from './compiler';
import { capabilities, col, dateParts, formFields, lateral } from './fields';
import type { EngineSourceDef, ResolvedSource, RunActor, SourceContext, SourceField, SourceKind } from './types';

// ------------------------------------------------------------------ engine source registry (module-level)

const REGISTRY = new Map<string, EngineSourceDef>();

/**
 * Registers an engine source (ADR-0015). Call at module init (or import time); re-registering a key replaces it.
 * Engine source keys are global; their `viewKey` and `requiresFeature` gate who sees them.
 */
export function registerSource(def: EngineSourceDef): void {
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(def.key)) throw new Error(`invalid report source key ${def.key}`);
  REGISTRY.set(def.key, def);
}
export const registeredSources = (): EngineSourceDef[] => [...REGISTRY.values()];

/**
 * Extra allow-listed fields for an engine source registered by another module (the report pack's computed measures,
 * e.g. quote rank or days to expiry), added to the source each time it resolves. Keyed by source key; order-free
 * with respect to the module's own registration.
 */
type SourceExtension = (ctx: SourceContext, built: Omit<ResolvedSource, 'source' | 'label' | 'viewKey'>) => SourceField[];
const EXTENSIONS = new Map<string, SourceExtension[]>();
export function extendSource(key: string, ext: SourceExtension): void {
  EXTENSIONS.set(key, [...(EXTENSIONS.get(key) ?? []), ext]);
}

const DOC_TYPE_COLS = ['id', 'key', 'name', 'plural_name', 'description', 'kind', 'module_key', 'header_form_id', 'line_form_id', 'settings', 'is_active', 'version'] as const;
type DocTypeRow = Awaited<ReturnType<DocTypesService['load']>>;

const has = (perms: MyPermissions | null, key: string | null) => !key || !perms || perms.keys.includes(key);

/** Statuses of a doc type the viewer holds (`doc.<type>:view.<status>`); engine: all. */
function heldStatuses(perms: MyPermissions | null, typeKey: string, known: string[]): string[] {
  if (!perms) return known;
  const prefix = `doc.${typeKey}:view.`;
  return perms.keys.filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
}

function locationFields(t: { tenantId: string }, nodeId: RawBuilder<unknown>, loc: string, access: SourceField['access'], path: string[] = ['Location'], idPrefix = 'location'): SourceField[] {
  const p = sql.ref(`${loc}.path`);
  const full = lateral(`lp_${idPrefix}`, sql`select string_agg(a.name, ' / ' order by a.depth) as v from app.location_node a where a.tenant_id = ${t.tenantId} and a.path @> ${p}`);
  const top = lateral(`lt_${idPrefix}`, sql`select a.name as v from app.location_node a where a.tenant_id = ${t.tenantId} and a.path = subpath(${p}, 0, 1)`);
  return [
    { id: `${idPrefix}.name`, label: path.length > 1 ? path.join(' ') : 'Location', type: 'lookup', path, expr: sql.ref(`${loc}.name`), idExpr: nodeId, locationPath: p, access },
    { id: `${idPrefix}.code`, label: `${path.join(' ')} code`, type: 'text', path, expr: sql.ref(`${loc}.code`), idExpr: nodeId, locationPath: p, access },
    { id: `${idPrefix}.path`, label: `${path.join(' ')} (full path)`, type: 'text', path, idExpr: nodeId, locationPath: p, access, joins: [full], expr: col(full, 'v') },
    { id: `${idPrefix}.top`, label: `${path.join(' ')} (top level)`, type: 'text', path, access, joins: [top], expr: col(top, 'v') },
  ];
}

/** Name of a user referenced by `id` (lateral, memoizable): spread into a field definition. */
const userName = (tenantId: string, id: RawBuilder<unknown>, alias: string): Pick<SourceField, 'expr' | 'joins'> => {
  const j = lateral(alias, sql`select u.name from app.tenant_user u where u.tenant_id = ${tenantId} and u.id = ${id}`);
  return { expr: col(j, 'name'), joins: [j] };
};
/** Name and code of a master record referenced by `id`. */
const recordRef = (tenantId: string, id: RawBuilder<unknown>, alias: string) => {
  const j = lateral(alias, sql`select r.name, r.code::text as code from app.master_record r where r.tenant_id = ${tenantId} and r.id = ${id}`);
  return { name: { expr: col(j, 'name'), joins: [j] }, code: { expr: col(j, 'code'), joins: [j] } };
};

/**
 * Report source catalogue: built-in sources generated at run time from configuration (`doc:<type>`,
 * `doc_line:<type>`, `master:<key>`) plus engine sources registered by modules. Resolution applies the viewer's
 * permissions: source access, status views, data scope (declared, applied by the compiler) and field access.
 */
@Injectable()
export class ReportsCatalogue implements OnModuleInit {
  static registerSource = registerSource;

  constructor(
    private readonly types: DocTypesService,
    private readonly store: DocStore,
    private readonly masters: MastersService,
    private readonly forms: FormsService,
    private readonly scope: ScopeService,
    private readonly ent: EntitlementsService,
  ) {}

  registerSource(def: EngineSourceDef) {
    registerSource(def);
  }

  onModuleInit() {
    for (const def of this.engineSources()) registerSource(def);
    // Sources contributed by other modules as plain descriptors (structurally EngineSourceDef).
    registerSource(vendorQuoteSource() as unknown as EngineSourceDef);
    registerSource(poFollowupSource() as unknown as EngineSourceDef);
    // Standard report pack: generic computed sources + measures over the modules' tables (ADR-0015, no per-tenant SQL).
    installPackSources({ register: registerSource, extend: extendSource, timezone: t => this.timezone(t), locationFields });
  }

  async timezone(tenantId: string): Promise<string> {
    return (await this.ent.state(tenantId))?.timezone ?? 'Asia/Kolkata';
  }

  /** The tenant's plan features (entitlements). */
  tenantFeatures(tenantId: string): Promise<string[]> {
    return this.features(tenantId);
  }

  private async features(tenantId: string): Promise<string[]> {
    return (await this.ent.state(tenantId))?.features ?? [];
  }

  // ------------------------------------------------------------------ listing

  /** GET /reports/sources: every source the viewer may read, with fields filtered by field access. */
  async list(tx: Tx, actor: RunActor): Promise<SourceCatalogue[]> {
    const ctx: SourceContext = { ...actor, tx, timezone: await this.timezone(actor.tenantId), params: {}, range: null };
    const out: SourceCatalogue[] = [];
    const docTypes = (await tx.selectFrom('app.doc_type').select([...DOC_TYPE_COLS]).where('tenant_id', '=', actor.tenantId)
      .where('is_active', '=', true).orderBy('name').execute()) as DocTypeRow[];
    for (const t of docTypes) {
      if (!has(actor.perms, `doc.${t.key}:action.view`)) continue;
      out.push(toCatalogue(await this.docSource(ctx, t, 'doc'), actor.perms));
      if (t.line_form_id) out.push(toCatalogue(await this.docSource(ctx, t, 'doc_line'), actor.perms));
    }
    const masters = await tx.selectFrom('app.master_def').select('key').where('tenant_id', '=', actor.tenantId).where('is_active', '=', true).orderBy('name').execute();
    for (const m of masters) {
      if (!has(actor.perms, `master.${m.key}:action.view`)) continue;
      out.push(toCatalogue(await this.masterSource(ctx, m.key), actor.perms));
    }
    const feats = await this.features(actor.tenantId);
    for (const def of REGISTRY.values()) {
      if (def.requiresFeature && !feats.includes(def.requiresFeature)) continue;
      if (!has(actor.perms, def.viewKey)) continue;
      try {
        out.push(toCatalogue(await this.engine(ctx, def), actor.perms));
      } catch {
        // a module's source failing to build must not break the catalogue
      }
    }
    return out;
  }

  /** Resolves a source for a run; 404 when unknown, 403 when the viewer may not read it. */
  async resolve(tx: Tx, actor: RunActor, source: { kind: SourceKind; key: string }, run: Pick<SourceContext, 'params' | 'range'> = {}): Promise<ResolvedSource> {
    const ctx: SourceContext = { ...actor, tx, timezone: await this.timezone(actor.tenantId), params: run.params ?? {}, range: run.range ?? null };
    if (source.kind === 'doc' || source.kind === 'doc_line') {
      const t = await this.types.find(tx, actor.tenantId, source.key);
      if (!t) throw AppError.notFound('Report source');
      if (!has(actor.perms, `doc.${t.key}:action.view`)) throw AppError.forbidden(`You cannot see ${t.plural_name.toLowerCase()}.`);
      if (source.kind === 'doc_line' && !t.line_form_id) throw AppError.notFound('Report source');
      return this.docSource(ctx, t, source.kind);
    }
    if (source.kind === 'master') {
      const m = await this.masters.find(tx, actor.tenantId, source.key);
      if (!m) throw AppError.notFound('Report source');
      if (!has(actor.perms, `master.${m.key}:action.view`)) throw AppError.forbidden(`You cannot see ${m.plural_name.toLowerCase()}.`);
      return this.masterSource(ctx, m.key);
    }
    const def = REGISTRY.get(source.key);
    if (!def) throw AppError.notFound('Report source');
    if (def.requiresFeature && !(await this.features(actor.tenantId)).includes(def.requiresFeature)) throw AppError.notFound('Report source');
    if (!has(actor.perms, def.viewKey)) throw AppError.forbidden(`You cannot see ${def.label.toLowerCase()}.`);
    return this.engine(ctx, def);
  }

  private async engine(ctx: SourceContext, def: EngineSourceDef): Promise<ResolvedSource> {
    const built = await def.build(ctx);
    const extra = (EXTENSIONS.get(def.key) ?? []).flatMap(ext => ext(ctx, built));
    const fields = extra.length ? [...built.fields.filter(f => !extra.some(x => x.id === f.id)), ...extra] : built.fields;
    return { ...built, fields, source: { kind: 'engine', key: def.key }, label: def.label, viewKey: def.viewKey };
  }

  /**
   * Whether the viewer could run a report over this source (system reports are listed only then): the doc type /
   * master exists and the viewer holds its view key; an engine source exists, its plan feature is on and the viewer
   * holds its view key. Cheap — no source is built.
   */
  async available(tx: Tx, actor: RunActor, source: { kind: SourceKind; key: string }, cache: Map<string, boolean> = new Map()): Promise<boolean> {
    const k = `${source.kind}:${source.key}`;
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    let ok = false;
    if (source.kind === 'doc' || source.kind === 'doc_line') {
      const t = await tx.selectFrom('app.doc_type').select(['key', 'line_form_id', 'kind', 'module_key']).where('tenant_id', '=', actor.tenantId)
        .where('key', '=', source.key).where('is_active', '=', true).executeTakeFirst();
      ok = !!t && has(actor.perms, `doc.${t.key}:action.view`) && (source.kind === 'doc' || !!t.line_form_id)
        && (t.kind !== 'system' || !t.module_key || (await this.features(actor.tenantId)).includes(t.module_key));
    } else if (source.kind === 'master') {
      const m = await tx.selectFrom('app.master_def').select('key').where('tenant_id', '=', actor.tenantId).where('key', '=', source.key).where('is_active', '=', true).executeTakeFirst();
      ok = !!m && has(actor.perms, `master.${m.key}:action.view`);
    } else {
      const def = REGISTRY.get(source.key);
      ok = !!def && (!def.requiresFeature || (await this.features(actor.tenantId)).includes(def.requiresFeature)) && has(actor.perms, def.viewKey);
    }
    cache.set(k, ok);
    return ok;
  }

  private async currentDef(tx: Tx, tenantId: string, formId: string): Promise<FormDefinition> {
    const form = await this.forms.loadById(tx, tenantId, formId);
    return (await this.forms.current(tx, tenantId, form)).definition;
  }

  // ------------------------------------------------------------------ doc / doc_line

  async docSource(ctx: SourceContext, t: DocTypeRow, kind: 'doc' | 'doc_line'): Promise<ResolvedSource> {
    const { tx, tenantId, perms } = ctx;
    const tz = await this.timezone(tenantId);
    const b = await this.store.bundle(tx, tenantId, t);
    const statuses = await this.types.statuses(tx, t);
    const labels = Object.fromEntries(statuses.map(s => [s.key, s.label]));
    labels.submitted = labels.draft ?? 'Draft';
    const held = heldStatuses(perms, t.key, statuses.map(s => s.key));
    const H = b.headerKey;
    const hAcc = (k: string) => (b.headerFields.has(k) ? [{ formKey: H, fieldKey: k }] : undefined);
    const doc = sql.ref('d');
    const fields: SourceField[] = [
      { id: 'number', label: settingsLabel(t) ?? 'Number', type: 'text', path: ['Document'], expr: sql`${doc}.number` },
      { id: 'status', label: 'Status', type: 'status', path: ['Document'], expr: sql`${doc}.status_key`, labels, allowedValues: held },
    ];
    const dd: SourceField = { id: 'doc_date', label: b.headerFields.get('doc_date')?.label ?? 'Date', type: 'date', path: ['Document'], expr: sql`${doc}.doc_date`, access: hAcc('doc_date') };
    fields.push(dd, ...dateParts(dd, tz));
    if (b.headerSys.has('required_by')) {
      const rb: SourceField = { id: 'required_by', label: b.headerFields.get('required_by')?.label ?? 'Required by', type: 'date', path: ['Document'], expr: sql`${doc}.required_by`, access: hAcc('required_by') };
      fields.push(rb, ...dateParts(rb, tz));
    }
    if (b.headerSys.has('total_amount')) {
      fields.push({ id: 'total_amount', label: b.headerFields.get('total_amount')?.label ?? 'Total amount', type: 'currency', path: ['Document'], expr: sql`${doc}.total_amount`, access: hAcc('total_amount') });
    }
    fields.push({ id: 'currency', label: 'Currency', type: 'text', path: ['Document'], expr: sql`${doc}.currency` });
    fields.push(...locationFields(ctx, sql`${doc}.location_node_id`, 'loc', hAcc('location')));
    if (b.headerSys.has('party')) {
      const pl = b.headerFields.get('party')?.label ?? 'Party';
      const party = recordRef(tenantId, sql`${doc}.party_id`, 'party');
      fields.push(
        { id: 'party.name', label: pl, type: 'lookup', path: [pl], idExpr: sql`${doc}.party_id`, access: hAcc('party'), ...party.name },
        { id: 'party.code', label: `${pl} code`, type: 'text', path: [pl], idExpr: sql`${doc}.party_id`, access: hAcc('party'), ...party.code },
      );
    }
    const createdAt: SourceField = { id: 'created_at', label: 'Created at', type: 'datetime', path: ['Document'], expr: sql`${doc}.created_at` };
    const submittedAt: SourceField = { id: 'submitted_at', label: 'Submitted at', type: 'datetime', path: ['Document'], expr: sql`${doc}.submitted_at` };
    fields.push(
      { id: 'created_by.name', label: 'Created by', type: 'lookup', path: ['People'], idExpr: sql`${doc}.created_by`, ...userName(tenantId, sql`${doc}.created_by`, 'usr_created_by') },
      { id: 'submitted_by.name', label: 'Submitted by', type: 'lookup', path: ['People'], idExpr: sql`${doc}.submitted_by`, ...userName(tenantId, sql`${doc}.submitted_by`, 'usr_submitted_by') },
      createdAt, ...dateParts(createdAt, tz), submittedAt, ...dateParts(submittedAt, tz),
      ...ageFields(sql`${doc}.submitted_at`, tz, 'Age since submission', ['Document']),
      {
        id: 'wf.stage', label: 'Current approval stage', type: 'status', path: ['Workflow'],
        expr: sql`(case when ${doc}.status_key like 'waiting\\_%' then ${doc}.status_key end)`,
        labels: Object.fromEntries(statuses.filter(s => s.key.startsWith('waiting_')).map(s => [s.key, s.label])),
      },
      {
        id: 'overdue', label: 'Overdue', type: 'boolean', path: ['Workflow'],
        expr: sql`exists (select 1 from app.wf_instance i join app.wf_stage_state ss on ss.tenant_id = i.tenant_id and ss.instance_id = i.id
          where i.tenant_id = ${doc}.tenant_id and i.document_id = ${doc}.id and i.status = 'running' and ss.status = 'active' and ss.due_at < now())`,
      },
    );
    fields.push(...formFields(b.header, { idPrefix: 'custom.', json: sql`${doc}.custom`, formKey: H, path: ['Header'], skip: b.headerSys, tenantId, timezone: tz }));
    const link = sql`'/docs/' || ${t.key}::text || '/' || ${doc}.id::text`;
    const base = {
      dateField: 'doc_date', link, scope: { tabKey: `doc.${t.key}`, path: sql`loc.path` },
      viewKey: `doc.${t.key}:action.view`, defaultSort: [{ field: 'doc_date', dir: 'desc' as const }, { field: 'number', dir: 'desc' as const }],
    };
    if (kind === 'doc') {
      fields.push({
        id: 'line_count', label: 'Lines', type: 'number', path: ['Document'],
        expr: sql`(select count(*) from app.document_line x where x.tenant_id = ${doc}.tenant_id and x.document_id = ${doc}.id and not x.is_deleted)`,
      });
      return {
        ...base, source: { kind: 'doc', key: t.key }, label: t.plural_name,
        from: sql`app.document d join app.location_node loc on loc.id = d.location_node_id`,
        where: [
          sql<SqlBool>`d.tenant_id = ${tenantId}`, sql<SqlBool>`d.doc_type_id = ${t.id}`, sql<SqlBool>`not d.is_deleted`,
          held.length ? sql<SqlBool>`d.status_key = any(${held}::text[])` : sql<SqlBool>`false`,
        ],
        rowId: sql`d.id`, fields,
      };
    }

    // ---- item-wise (lines)
    const L = b.lineKey!;
    const lAcc = (k: string) => (b.lineFields.has(k) ? [{ formKey: L, fieldKey: k }] : undefined);
    const qtyAcc = lAcc('qty');
    const lineStatus = sql`(case when l.status_key = 'submitted' then 'draft' else l.status_key end)`;
    fields.push(
      { id: 'line.no', label: 'Line no.', type: 'number', path: ['Line'], expr: sql`l.line_no`, aggregatable: false },
      { id: 'line.status', label: 'Line status', type: 'status', path: ['Line'], expr: lineStatus, labels, allowedValues: held },
      { id: 'line.qty', label: b.lineFields.get('qty')?.label ?? 'Quantity', type: 'number', path: ['Line'], expr: sql`l.qty`, access: qtyAcc },
    );
    if (b.lineSys.has('rate')) fields.push({ id: 'line.rate', label: b.lineFields.get('rate')?.label ?? 'Rate', type: 'currency', path: ['Line'], expr: sql`l.rate`, access: lAcc('rate') });
    if (b.lineSys.has('amount')) fields.push({ id: 'line.amount', label: b.lineFields.get('amount')?.label ?? 'Amount', type: 'currency', path: ['Line'], expr: sql`l.amount`, access: lAcc('amount') });
    if (b.lineSys.has('required_date')) {
      const rd: SourceField = { id: 'line.required_date', label: b.lineFields.get('required_date')?.label ?? 'Required date', type: 'date', path: ['Line'], expr: sql`l.required_date`, access: lAcc('required_date') };
      fields.push(rd, ...dateParts(rd, tz));
    }
    const ll = lateral('line_loc', sql`select n.name, n.path from app.location_node n where n.tenant_id = ${tenantId} and n.id = l.location_node_id`);
    fields.push({ id: 'line.location.name', label: 'Line location', type: 'lookup', path: ['Line'], idExpr: sql`l.location_node_id`, locationPath: col(ll, 'path'), access: lAcc('location'),
      joins: [ll], expr: col(ll, 'name') });
    const q = (k: string) => sql`coalesce(s.${sql.raw(k)}, 0)`;
    const BUCKETS: [string, string][] = [
      ['requested', 'Requested'], ['approved', 'Approved'], ['held', 'Held'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'],
      ['short_closed', 'Short closed'], ['over_approved', 'Over approved'], ['selected', 'Selected'], ['ordered', 'Ordered'], ['received', 'Received'],
      ['accepted', 'Accepted'], ['rejected_at_receipt', 'Rejected at receipt'], ['issued', 'Issued'], ['returned', 'Returned'],
    ];
    for (const [k, label] of BUCKETS) fields.push({ id: `qty.${k}`, label, type: 'number', path: ['Quantities'], expr: q(k), access: qtyAcc });
    fields.push(
      { id: 'qty.pending_approval', label: 'Pending approval', type: 'number', path: ['Quantities'], access: qtyAcc,
        expr: sql`greatest(0, ${q('requested')} + ${q('over_approved')} - ${q('approved')} - ${q('rejected')} - ${q('cancelled')})` },
      { id: 'qty.pending_order', label: 'Pending order', type: 'number', path: ['Quantities'], access: qtyAcc,
        expr: sql`greatest(0, ${q('approved')} + ${q('over_approved')} - ${q('ordered')} - ${q('short_closed')})` },
      { id: 'qty.pending_receipt', label: 'Pending receipt', type: 'number', path: ['Quantities'], access: qtyAcc,
        expr: sql`greatest(0, ${q('ordered')} - ${q('received')})` },
    );
    if (b.lineSys.has('item')) {
      const ia = lAcc('item');
      fields.push(
        { id: 'item.code', label: 'Item code', type: 'text', path: ['Item'], expr: sql`it.code::text`, idExpr: sql`l.item_id`, access: ia },
        { id: 'item.name', label: 'Item', type: 'lookup', path: ['Item'], expr: sql`it.name`, idExpr: sql`l.item_id`, access: ia },
      );
      const item = await this.masters.find(tx, tenantId, 'item');
      if (item) {
        const def = await this.currentDef(tx, tenantId, item.form_id);
        fields.push(...formFields(def, { idPrefix: 'item.', json: sql`it.data`, formKey: 'item', path: ['Item'], extraAccess: ia, tenantId, timezone: tz })
          .map(f => ({ ...f, label: f.path.length > 1 ? f.label : `Item ${f.label.toLowerCase()}` })));
      }
    }
    if (b.lineSys.has('uom')) {
      const uom = recordRef(tenantId, sql`l.uom_id`, 'uom');
      fields.push(
        { id: 'uom.code', label: 'Unit', type: 'text', path: ['Line'], idExpr: sql`l.uom_id`, access: lAcc('uom'), ...uom.code },
        { id: 'uom.name', label: 'Unit name', type: 'lookup', path: ['Line'], idExpr: sql`l.uom_id`, access: lAcc('uom'), ...uom.name },
      );
    }
    fields.push(...formFields(b.line!, { idPrefix: 'line.custom.', json: sql`l.custom`, formKey: L, path: ['Line'], skip: b.lineSys, tenantId, timezone: tz }));
    return {
      ...base, source: { kind: 'doc_line', key: t.key }, label: `${t.plural_name} (item-wise)`,
      from: sql`app.document_line l join app.document d on d.id = l.document_id join app.location_node loc on loc.id = d.location_node_id
        left join app.line_qty_summary s on s.line_id = l.id left join app.master_record it on it.id = l.item_id`,
      where: [
        sql<SqlBool>`l.tenant_id = ${tenantId}`, sql<SqlBool>`l.doc_type_id = ${t.id}`, sql<SqlBool>`not l.is_deleted`, sql<SqlBool>`not d.is_deleted`,
        held.length ? sql<SqlBool>`${lineStatus} = any(${held}::text[])` : sql<SqlBool>`false`,
      ],
      rowId: sql`l.id`, fields,
      defaultSort: [{ field: 'doc_date', dir: 'desc' }, { field: 'number', dir: 'desc' }, { field: 'line.no', dir: 'asc' }],
    };
  }

  // ------------------------------------------------------------------ master

  async masterSource(ctx: SourceContext, key: string): Promise<ResolvedSource> {
    const { tx, tenantId, perms } = ctx;
    const m = await this.masters.load(tx, tenantId, key);
    const tz = await this.timezone(tenantId);
    const def = await this.currentDef(tx, tenantId, m.form_id);
    const views = !perms ? ['active', 'inactive'] : ['active', 'inactive'].filter(v => perms.keys.includes(`master.${key}:view.${v}`));
    const actives = views.map(v => v === 'active');
    const created: SourceField = { id: 'created_at', label: 'Created at', type: 'datetime', path: ['Record'], expr: sql`r.created_at` };
    const updated: SourceField = { id: 'updated_at', label: 'Updated at', type: 'datetime', path: ['Record'], expr: sql`r.updated_at` };
    const fields: SourceField[] = [
      { id: 'code', label: 'Code', type: 'text', path: ['Record'], expr: sql`r.code::text` },
      { id: 'name', label: 'Name', type: 'text', path: ['Record'], expr: sql`r.name` },
      { id: 'active', label: 'Active', type: 'boolean', path: ['Record'], expr: sql`r.is_active` },
      created, ...dateParts(created, tz), updated,
      ...formFields(def, { idPrefix: 'data.', json: sql`r.data`, formKey: key, path: [m.name], tenantId, timezone: tz }),
    ];
    return {
      source: { kind: 'master', key }, label: m.plural_name, viewKey: `master.${key}:action.view`,
      from: sql`app.master_record r`,
      where: [
        sql<SqlBool>`r.tenant_id = ${tenantId}`, sql<SqlBool>`r.master_id = ${m.id}`, sql<SqlBool>`not r.is_deleted`,
        actives.length ? sql<SqlBool>`r.is_active = any(${actives}::boolean[])` : sql<SqlBool>`false`,
      ],
      rowId: sql`r.id`, fields, dateField: 'created_at', defaultSort: [{ field: 'code', dir: 'asc' }],
      link: sql`'/masters/' || ${key}::text || '/' || r.id::text`,
    };
  }

  // ------------------------------------------------------------------ engine sources of this module

  /** Doc types the viewer can list, with their held statuses + scope condition (for multi-type sources). */
  private async viewableTypes(ctx: SourceContext, locPath: RawBuilder<unknown>) {
    const rows = (await ctx.tx.selectFrom('app.doc_type').select([...DOC_TYPE_COLS]).where('tenant_id', '=', ctx.tenantId).execute()) as DocTypeRow[];
    const out: { t: DocTypeRow; held: string[]; labels: Record<string, string>; cond: Expression<SqlBool> }[] = [];
    for (const t of rows) {
      if (!has(ctx.perms, `doc.${t.key}:action.view`)) continue;
      const statuses = await this.types.statuses(ctx.tx, t);
      const held = heldStatuses(ctx.perms, t.key, statuses.map(s => s.key));
      if (!held.length) continue;
      const scope = ctx.perms ? scopeCondition(locPath, this.scope.nodeFilter(ctx.perms, `doc.${t.key}`)) : sql<SqlBool>`true`;
      out.push({ t, held, labels: Object.fromEntries(statuses.map(s => [s.key, s.label])), cond: sql<SqlBool>`(d.doc_type_id = ${t.id} and d.status_key = any(${held}::text[]) and ${scope})` });
    }
    return out;
  }

  private engineSources(): EngineSourceDef[] {
    const docCommon = async (ctx: SourceContext, tz: string) => {
      const types = await this.viewableTypes(ctx, sql`loc.path`);
      const labels: Record<string, string> = {};
      for (const v of types) for (const [k, l] of Object.entries(v.labels)) labels[k] ??= l;
      const typeNames = Object.fromEntries(types.map(v => [v.t.key, v.t.name]));
      const where = types.length ? sql<SqlBool>`(${sql.join(types.map(v => v.cond), sql` or `)})` : sql<SqlBool>`false`;
      const docDate: SourceField = { id: 'doc_date', label: 'Date', type: 'date', path: ['Document'], expr: sql`d.doc_date` };
      const fields: SourceField[] = [
        { id: 'doc_type.key', label: 'Document type key', type: 'text', path: ['Document'], expr: sql`dt.key`, allowedValues: Object.keys(typeNames) },
        { id: 'doc_type.name', label: 'Document type', type: 'text', path: ['Document'], expr: sql`dt.name` },
        // plan feature (module) of a system type: 'indent', 'vendor_quotes', 'purchase', 'grn', 'store'; null = custom type
        { id: 'doc_type.module', label: 'Module', type: 'text', path: ['Document'], expr: sql`dt.module_key` },
        { id: 'number', label: 'Number', type: 'text', path: ['Document'], expr: sql`d.number` },
        { id: 'total_amount', label: 'Total amount', type: 'currency', path: ['Document'], expr: sql`d.total_amount` },
        docDate, ...dateParts(docDate, tz),
        ...locationFields(ctx, sql`d.location_node_id`, 'loc', undefined),
        { id: 'submitted_by.name', label: 'Submitted by', type: 'lookup', path: ['People'], idExpr: sql`d.submitted_by`, ...userName(ctx.tenantId, sql`d.submitted_by`, 'usr_submitted_by') },
      ];
      return { types, labels, where, fields };
    };

    const documents: EngineSourceDef = {
      key: 'documents', label: 'All documents', viewKey: null,
      build: async ctx => {
        const tz = await this.timezone(ctx.tenantId);
        const c = await docCommon(ctx, tz);
        const created: SourceField = { id: 'created_at', label: 'Created at', type: 'datetime', path: ['Document'], expr: sql`d.created_at` };
        return {
          from: sql`app.document d join app.doc_type dt on dt.id = d.doc_type_id join app.location_node loc on loc.id = d.location_node_id`,
          where: [sql<SqlBool>`d.tenant_id = ${ctx.tenantId}`, sql<SqlBool>`not d.is_deleted`, c.where],
          rowId: sql`d.id`,
          fields: [
            ...c.fields,
            { id: 'status', label: 'Status', type: 'status', path: ['Document'], expr: sql`(case when d.status_key = 'submitted' then 'draft' else d.status_key end)`, labels: c.labels, allowedValues: Object.keys(c.labels) },
            { id: 'created_by.name', label: 'Created by', type: 'lookup', path: ['People'], idExpr: sql`d.created_by`, ...userName(ctx.tenantId, sql`d.created_by`, 'usr_created_by') },
            created, ...dateParts(created, tz),
            { id: 'submitted_at', label: 'Submitted at', type: 'datetime', path: ['Document'], expr: sql`d.submitted_at` },
            {
              id: 'overdue', label: 'Overdue', type: 'boolean', path: ['Workflow'],
              expr: sql`exists (select 1 from app.wf_instance i join app.wf_stage_state ss on ss.tenant_id = i.tenant_id and ss.instance_id = i.id
                where i.tenant_id = d.tenant_id and i.document_id = d.id and i.status = 'running' and ss.status = 'active' and ss.due_at < now())`,
            },
          ],
          dateField: 'doc_date', defaultSort: [{ field: 'doc_date', dir: 'desc' }],
          link: sql`'/docs/' || dt.key || '/' || d.id::text`,
        };
      },
    };

    const workflowPending: EngineSourceDef = {
      key: 'workflow_pending', label: 'Pending approvals', viewKey: 'approvals:action.view',
      build: async ctx => {
        const tz = await this.timezone(ctx.tenantId);
        const c = await docCommon(ctx, tz);
        const entered: SourceField = { id: 'entered_at', label: 'Waiting since', type: 'datetime', path: ['Approval'], expr: sql`ss.entered_at` };
        const UUIDRE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
        return {
          from: sql`app.wf_stage_state ss
            join app.wf_instance i on i.id = ss.instance_id and i.status = 'running'
            join app.document d on d.id = i.document_id and not d.is_deleted
            join app.doc_type dt on dt.id = d.doc_type_id
            join app.location_node loc on loc.id = d.location_node_id
            join app.workflow_version v on v.id = i.workflow_version_id
            left join lateral (
              select x.user_id from (
                select ur.user_id from jsonb_array_elements(v.definition -> 'stages') st
                  cross join jsonb_array_elements(coalesce(st -> 'actors', '[]'::jsonb)) a
                  join app.user_role ur on a ->> 'type' = 'role' and ur.role_id::text = a ->> 'roleId'
                  where st ->> 'key' = ss.stage_key
                union
                select u.value::uuid from jsonb_array_elements(v.definition -> 'stages') st
                  cross join jsonb_array_elements(coalesce(st -> 'actors', '[]'::jsonb)) a
                  cross join jsonb_array_elements_text(case when a ->> 'type' = 'users' then a -> 'userIds' else '[]'::jsonb end) u(value)
                  where st ->> 'key' = ss.stage_key and u.value ~ ${UUIDRE}
                union
                select su.reporting_manager_id from jsonb_array_elements(v.definition -> 'stages') st
                  cross join jsonb_array_elements(coalesce(st -> 'actors', '[]'::jsonb)) a
                  join app.tenant_user su on su.id = d.submitted_by
                  where st ->> 'key' = ss.stage_key and a ->> 'type' = 'reporting_manager'
                union
                select (d.custom ->> (a ->> 'field'))::uuid from jsonb_array_elements(v.definition -> 'stages') st
                  cross join jsonb_array_elements(coalesce(st -> 'actors', '[]'::jsonb)) a
                  where st ->> 'key' = ss.stage_key and a ->> 'type' = 'field' and (d.custom ->> (a ->> 'field')) ~ ${UUIDRE}
                union
                -- a stage without actors is decided by whoever holds its stage key (doc.<type>:action.stage_<stage>)
                select ur.user_id from app.permission_grant g join app.user_role ur on ur.role_id = g.role_id
                  where g.tenant_id = d.tenant_id and g.effect = 'allow' and g.perm_key = 'doc.' || dt.key || ':action.stage_' || ss.stage_key
                    and coalesce((select jsonb_array_length(coalesce(st -> 'actors', '[]'::jsonb)) from jsonb_array_elements(v.definition -> 'stages') st
                                   where st ->> 'key' = ss.stage_key limit 1), 0) = 0
                union
                select wa.user_id from app.wf_assignment wa where wa.instance_id = i.id and wa.stage_key = ss.stage_key and wa.is_active
              ) x where x.user_id is not null
            ) ap on true
            left join app.tenant_user au on au.id = ap.user_id`,
          where: [sql<SqlBool>`ss.tenant_id = ${ctx.tenantId}`, sql<SqlBool>`ss.status = 'active'`, c.where],
          rowId: sql`ss.instance_id::text || ':' || ss.stage_key || ':' || coalesce(ap.user_id::text, '')`,
          fields: [
            ...c.fields,
            { id: 'stage', label: 'Stage', type: 'text', path: ['Approval'],
              expr: sql`coalesce((select st ->> 'name' from jsonb_array_elements(v.definition -> 'stages') st where st ->> 'key' = ss.stage_key limit 1), ss.stage_key)` },
            { id: 'stage.key', label: 'Stage key', type: 'text', path: ['Approval'], expr: sql`ss.stage_key` },
            { id: 'approver.name', label: 'Approver', type: 'lookup', path: ['Approval'], idExpr: sql`ap.user_id`, expr: sql`au.name` },
            { id: 'approver.email', label: 'Approver email', type: 'text', path: ['Approval'], expr: sql`au.email::text` },
            entered, ...dateParts(entered, tz),
            { id: 'due_at', label: 'Due at', type: 'datetime', path: ['Approval'], expr: sql`ss.due_at` },
            { id: 'overdue', label: 'Overdue', type: 'boolean', path: ['Approval'], expr: sql`coalesce(ss.due_at < now(), false)` },
            { id: 'days_pending', label: 'Days pending', type: 'number', path: ['Approval'], expr: sql`round((extract(epoch from (now() - ss.entered_at)) / 86400)::numeric, 1)` },
          ],
          dateField: 'entered_at', defaultSort: [{ field: 'entered_at', dir: 'asc' }],
          link: sql`'/docs/' || dt.key || '/' || d.id::text`,
        };
      },
    };

    const audit: EngineSourceDef = {
      key: 'audit', label: 'Audit trail', viewKey: 'admin.audit:action.view',
      build: async ctx => {
        const tz = await this.timezone(ctx.tenantId);
        const at: SourceField = { id: 'at', label: 'When', type: 'datetime', path: ['Event'], expr: sql`a.at` };
        return {
          from: sql`app.audit_log a left join app.tenant_user u on u.id = a.actor_id`,
          where: [sql<SqlBool>`a.tenant_id = ${ctx.tenantId}`],
          rowId: sql`a.id`,
          fields: [
            at, ...dateParts(at, tz),
            { id: 'action', label: 'Action', type: 'text', path: ['Event'], expr: sql`a.action` },
            { id: 'entity', label: 'Record type', type: 'text', path: ['Event'], expr: sql`a.entity` },
            { id: 'entity_id', label: 'Record id', type: 'text', path: ['Event'], expr: sql`a.entity_id`, groupable: false },
            { id: 'actor.name', label: 'By', type: 'lookup', path: ['Event'], idExpr: sql`a.actor_id`, expr: sql`coalesce(u.name, case when a.actor_id is null then 'System' end)` },
            { id: 'actor.email', label: 'By (email)', type: 'text', path: ['Event'], expr: sql`u.email::text` },
            { id: 'impersonated', label: 'Support session', type: 'boolean', path: ['Event'], expr: sql`(a.impersonated_by is not null)` },
            { id: 'ip', label: 'IP address', type: 'text', path: ['Event'], expr: sql`a.ip` },
          ],
          dateField: 'at', defaultSort: [{ field: 'at', dir: 'desc' }],
        };
      },
    };

    const users: EngineSourceDef = {
      key: 'users', label: 'Users and roles', viewKey: 'admin.users:action.view',
      build: async ctx => {
        const views = !ctx.perms ? [true, false] : (['active', 'inactive'] as const).filter(v => ctx.perms!.keys.includes(`admin.users:view.${v}`)).map(v => v === 'active');
        const last: SourceField = { id: 'last_login_at', label: 'Last sign-in', type: 'datetime', path: ['User'], expr: sql`u.last_login_at` };
        return {
          from: sql`app.tenant_user u left join (app.user_role ur join app.role r on r.id = ur.role_id and not r.is_deleted) on ur.user_id = u.id`,
          where: [sql<SqlBool>`u.tenant_id = ${ctx.tenantId}`, sql<SqlBool>`not u.is_deleted`, views.length ? sql<SqlBool>`u.is_active = any(${views}::boolean[])` : sql<SqlBool>`false`],
          rowId: sql`u.id::text || ':' || coalesce(r.id::text, '')`,
          fields: [
            { id: 'name', label: 'Name', type: 'text', path: ['User'], expr: sql`u.name` },
            { id: 'email', label: 'Email', type: 'text', path: ['User'], expr: sql`u.email::text` },
            { id: 'phone', label: 'Phone', type: 'text', path: ['User'], expr: sql`u.phone` },
            { id: 'active', label: 'Active', type: 'boolean', path: ['User'], expr: sql`u.is_active` },
            { id: 'tenant_admin', label: 'Company administrator', type: 'boolean', path: ['User'], expr: sql`u.is_tenant_admin` },
            { id: 'role.name', label: 'Role', type: 'lookup', path: ['Role'], idExpr: sql`r.id`, expr: sql`r.name` },
            { id: 'role.key', label: 'Role key', type: 'text', path: ['Role'], expr: sql`r.key` },
            { id: 'manager.name', label: 'Reporting manager', type: 'lookup', path: ['User'], idExpr: sql`u.reporting_manager_id`, ...userName(ctx.tenantId, sql`u.reporting_manager_id`, 'usr_reporting_manager_id') },
            last,
            { id: 'created_at', label: 'Created at', type: 'datetime', path: ['User'], expr: sql`u.created_at` },
          ],
          dateField: 'created_at', defaultSort: [{ field: 'name', dir: 'asc' }],
          link: sql`'/admin/users/' || u.id::text`,
        };
      },
    };
    return [documents, workflowPending, audit, users];
  }
}

/** Ageing buckets (coded so they sort; labelled for display). */
export const AGE_BUCKETS: Record<string, string> = {
  a_0_7: '0–7 days', b_8_15: '8–15 days', c_16_30: '16–30 days', d_31_60: '31–60 days', e_over_60: 'Over 60 days',
};

/** `age_days` (whole days from a timestamp to today, tenant calendar) and `age_bucket` of that age. */
export function ageFields(at: RawBuilder<unknown>, tz: string, label: string, path: string[]): SourceField[] {
  const days = sql`((now() at time zone ${tz})::date - ((${at}) at time zone ${tz})::date)`;
  return [
    { id: 'age_days', label: `${label} (days)`, type: 'number', path, expr: days, aggregatable: true },
    {
      id: 'age_bucket', label: `${label} (bucket)`, type: 'status', path, labels: AGE_BUCKETS,
      expr: sql`(case when ${at} is null then null when ${days} <= 7 then 'a_0_7' when ${days} <= 15 then 'b_8_15'
        when ${days} <= 30 then 'c_16_30' when ${days} <= 60 then 'd_31_60' else 'e_over_60' end)`,
    },
  ];
}

function settingsLabel(t: DocTypeRow): string | null {
  const s = (t.settings ?? {}) as { numberLabel?: unknown };
  return typeof s.numberLabel === 'string' && s.numberLabel ? s.numberLabel : null;
}

export function toCatalogue(src: ResolvedSource, perms: MyPermissions | null): SourceCatalogue {
  return {
    source: src.source, label: src.label,
    fields: viewerFields(src.fields, perms).map((f): CatalogueField => ({ id: f.id, label: f.label, type: f.type, path: f.path, ...capabilities(f) })),
  };
}

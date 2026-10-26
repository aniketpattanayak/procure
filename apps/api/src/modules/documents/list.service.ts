import { Injectable } from '@nestjs/common';
import { DataField, DocListQuery, FormDefinition, DocListRow, ErrorCode, ItemListRow, Page, SavedViewConfig } from '@procure/schema';
import { Expression, RawBuilder, sql, SqlBool } from 'kysely';
import { z } from 'zod';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { getTenantSetting } from '../identity';
import { canonicalDecimal, isGrid, RecordEngine } from '../forms';
import { scopeCondition } from '../permissions';
import { bucketsFromRow, toQuantityBuckets } from './qty';
import { stageOfStatus, statusLabel } from './status';
import { dateStr, DocStore, FormBundle, numForField } from './store';
import { DocActor, docAction, DocTypeRow, docView, has, settingsOf } from './types';

type Query = z.infer<typeof DocListQuery>;
const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = new Set(['number', 'decimal', 'currency', 'percentage']);

const STATUS_ORDER = ['draft', '*waiting', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'];

function encodeCursor(v: string | null, id: string) {
  return Buffer.from(JSON.stringify({ v, id })).toString('base64url');
}
function decodeCursor(c: string): { v: string | null; id: string } {
  try {
    const x = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { v: unknown; id: unknown };
    if ((typeof x.v !== 'string' && x.v !== null) || typeof x.id !== 'string' || !UUID.test(x.id)) throw new Error('bad');
    return { v: x.v, id: x.id };
  } catch {
    throw bad('cursor', 'The page cursor is invalid. Start again from the first page.');
  }
}

/** Value for a `custom @> {...}` containment filter from a query-string value. */
function filterValue(f: DataField, raw: string): unknown {
  if (f.type === 'checkbox' || f.type === 'toggle') return raw === 'true';
  if (NUMERIC.has(f.type) || f.type === 'formula') {
    const canon = canonicalDecimal(raw);
    if (canon === null) return raw;
    const places = f.type === 'number' ? 0 : ((f as { precision?: number }).precision ?? 2);
    const [i, d = ''] = canon.split('.');
    return d.length > places ? raw : places ? `${i}.${d.padEnd(places, '0')}` : i;
  }
  if (f.type === 'multiselect' || f.type === 'multilookup' || f.type === 'files') return [raw];
  if (f.type === 'lookup') return raw.toLowerCase();
  return raw;
}

export interface ListInput extends Query {
  /** f.<field> filters. */
  fields: Record<string, string>;
  /** Ad-hoc `columns=a,b` (column chooser): returned in `columns` on top of the configured / saved-view ones. */
  extraColumns?: string[];
}

/**
 * GET /docs/:type (document-wise and item-wise) and /counts. Every query filters by tenant, type, data scope
 * (document location within the caller's scope for `doc.<type>`) and the status views the caller holds.
 */
@Injectable()
export class DocListService {
  constructor(private readonly store: DocStore, private readonly engine: RecordEngine) {}

  /** Status keys the caller may list (view keys `doc.<type>:view.<status>`); engine actors: every status. */
  heldStatuses(actor: DocActor, type: DocTypeRow, known: string[]): string[] {
    if (!actor.perms) return known;
    const prefix = `${docView(type.key, '')}`;
    return actor.perms.keys.filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
  }

  private orderStatuses(keys: string[], stageOrder: string[]): string[] {
    const rank = (k: string) => {
      const st = stageOfStatus(k);
      if (st) return 1 + (stageOrder.includes(st) ? stageOrder.indexOf(st) : stageOrder.length) / 1000;
      const i = STATUS_ORDER.indexOf(k);
      return i === -1 ? 99 : i;
    };
    return [...new Set(keys)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  /** Applies a saved view (filters/sort/columns) under the explicit query parameters. */
  async withSavedView(tx: Tx, actor: DocActor, input: ListInput): Promise<{ q: ListInput; columns: string[] | null }> {
    if (!input.savedView) return { q: input, columns: null };
    const v = await tx.selectFrom('app.saved_view').select(['owner_user_id', 'shared_role_ids', 'config', 'scope_key'])
      .where('tenant_id', '=', actor.tenantId).where('id', '=', input.savedView).executeTakeFirst();
    let visible = !!v && (v.owner_user_id === actor.userId || !actor.perms);
    if (v && !visible && v.owner_user_id === null) {
      const roles = v.shared_role_ids ?? [];
      if (!roles.length) visible = true;
      else if (actor.userId) {
        const mine = await tx.selectFrom('app.user_role').select('role_id').where('tenant_id', '=', actor.tenantId).where('user_id', '=', actor.userId).where('role_id', 'in', roles).executeTakeFirst();
        visible = !!mine;
      }
    }
    if (!v || !visible) throw bad('savedView', 'The saved view was not found.');
    const cfg = SavedViewConfig.parse(v.config ?? {});
    const merged: ListInput = { ...input, fields: { ...input.fields } };
    for (const [k, raw] of Object.entries(cfg.filters ?? {})) {
      if (raw === undefined || raw === null) continue;
      if (k.startsWith('f.')) {
        if (merged.fields[k.slice(2)] === undefined) merged.fields[k.slice(2)] = String(raw);
      } else if ((merged as unknown as Record<string, unknown>)[k] === undefined && ['status', 'q', 'location', 'from', 'to', 'item', 'party'].includes(k)) {
        (merged as unknown as Record<string, unknown>)[k] = raw;
      }
    }
    if (!merged.sort && cfg.sort) merged.sort = cfg.sort;
    return { q: merged, columns: cfg.columns ?? null };
  }

  private statusFilter(actor: DocActor, type: DocTypeRow, requested: Query['status'], known: string[]): string[] {
    const held = this.heldStatuses(actor, type, known);
    if (requested === undefined) return held;
    const want = (Array.isArray(requested) ? requested : String(requested).split(',')).map(s => s.trim()).filter(Boolean);
    const missing = want.filter(s => !held.includes(s));
    if (missing.length) throw AppError.forbidden(`You cannot see documents in status ${missing.join(', ')}.`);
    return want;
  }

  /** Conditions shared by both views and the counts (alias d = document, loc = its location). */
  private conditions(actor: DocActor, b: FormBundle, q: ListInput, itemView: boolean): Expression<SqlBool>[] {
    const tid = actor.tenantId;
    const conds: Expression<SqlBool>[] = [scopeCondition('loc.path', this.store.scopeFilter(actor, b.type.key))];
    if (q.location) conds.push(sql<SqlBool>`loc.path <@ (select n.path from app.location_node n where n.tenant_id = ${tid} and n.id = ${q.location})`);
    if (q.from) conds.push(sql<SqlBool>`d.doc_date >= ${q.from}::date`);
    if (q.to) conds.push(sql<SqlBool>`d.doc_date <= ${q.to}::date`);
    if (q.party) conds.push(sql<SqlBool>`d.party_id = ${q.party}::uuid`);
    if (q.item) {
      conds.push(itemView ? sql<SqlBool>`l.item_id = ${q.item}::uuid`
        : sql<SqlBool>`exists (select 1 from app.document_line x where x.tenant_id = ${tid} and x.document_id = d.id and not x.is_deleted and x.item_id = ${q.item}::uuid)`);
    }
    const hidden = this.store.hiddenFields(actor, b);
    if (q.q) {
      const pat = `%${q.q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
      // QA3-BUG-006: search matches the values of fields the caller may read (never key names, hidden fields, formulas
      // derived from hidden fields, or reserved `__` keys).
      const searchable = (col: RawBuilder<unknown>, skip: Set<string>) => sql<SqlBool>`exists (select 1 from jsonb_each_text(${col}) e
        where e.value ilike ${pat} and left(e.key, 2) <> '__' and e.key <> all(${sql.val([...skip])}::text[]))`;
      const header = searchable(sql.ref('d.custom'), hidden.header);
      conds.push(itemView
        ? sql<SqlBool>`(d.number ilike ${pat} or it.code::text ilike ${pat} or it.name ilike ${pat} or ${searchable(sql.ref('l.custom'), hidden.line)} or ${header})`
        : sql<SqlBool>`(d.number ilike ${pat} or ${header})`);
    }
    for (const [key, raw] of Object.entries(q.fields)) {
      const hf = b.headerFields.get(key);
      const lf = b.lineFields.get(key);
      if (hf && !b.headerSys.has(key) && !isGrid(hf) && !hidden.header.has(key)) {
        conds.push(sql<SqlBool>`d.custom @> ${JSON.stringify({ [key]: filterValue(hf, raw) })}::jsonb`);
      } else if (itemView && lf && !b.lineSys.has(key) && !hidden.line.has(key)) {
        conds.push(sql<SqlBool>`l.custom @> ${JSON.stringify({ [key]: filterValue(lf, raw) })}::jsonb`);
      } else throw bad(`f.${key}`, `Cannot filter by "${key}".`);
    }
    return conds;
  }

  private sortSpec(
    b: FormBundle, sort: string | undefined, itemView: boolean, columns: string[], hidden: { header: Set<string>; line: Set<string> },
  ): { key: string; expr: RawBuilder<unknown>; cast: string; desc: boolean } {
    const spec = sort ?? '-created_at';
    const desc = spec.startsWith('-');
    const key = desc ? spec.slice(1) : spec;
    // QA3-BUG-006: ordering by a field the caller cannot read would reveal it.
    const lineSort = itemView && ['qty', 'required_date', 'item'].includes(key);
    if (lineSort ? hidden.line.has(key) : hidden.header.has(key)) throw bad('sort', `Cannot sort by "${key}".`);
    const t = itemView ? 'l' : 'd';
    const sys: Record<string, [string, string]> = {
      number: [`coalesce(d.number, '')`, 'text'],
      doc_date: ['d.doc_date', 'date'],
      created_at: [`${t}.created_at`, 'timestamptz'],
      submitted_at: [`coalesce(d.submitted_at, 'epoch'::timestamptz)`, 'timestamptz'],
      required_by: [`coalesce(d.required_by, '0001-01-01'::date)`, 'date'],
      total_amount: ['coalesce(d.total_amount, 0)', 'numeric'],
      status: [`${t}.status_key`, 'text'],
      ...(itemView ? {
        line_no: ['l.line_no', 'int'], qty: ['l.qty', 'numeric'], required_date: [`coalesce(l.required_date, '0001-01-01'::date)`, 'date'],
        item: [`coalesce(it.name, '')`, 'text'],
      } : {}),
    };
    const s = sys[key];
    if (s) return { key, expr: sql.raw(s[0]), cast: s[1], desc };
    const f = b.headerFields.get(key);
    if (f && !b.headerSys.has(key) && columns.includes(key) && !isGrid(f)) {
      const numeric = NUMERIC.has(f.type) || (f.type === 'formula' && (f as { resultType?: string }).resultType === 'number');
      return numeric
        ? { key, expr: sql`coalesce((d.custom->>${key})::numeric, 0)`, cast: 'numeric', desc }
        : { key, expr: sql`coalesce(d.custom->>${key}, '')`, cast: 'text', desc };
    }
    throw bad('sort', `Cannot sort by "${key}".`);
  }

  async list(tx: Tx, actor: DocActor, type: DocTypeRow, input: ListInput): Promise<Page<DocListRow> | Page<ItemListRow>> {
    const { q, columns: viewColumns } = await this.withSavedView(tx, actor, input);
    const b = await this.store.bundle(tx, actor.tenantId, type);
    const info = await this.store.types.stageInfo(tx, type.id);
    const known = (await this.store.types.statuses(tx, type)).map(s => s.key);
    const statuses = this.statusFilter(actor, type, q.status, known);
    const s = settingsOf(type);
    const itemView = q.view === 'item';
    if (itemView && !b.line) throw bad('view', 'This document type has no lines.');
    const columns = (viewColumns ?? (itemView ? s.itemColumns : s.documentColumns));
    const extra = q.extraColumns ?? [];
    const unknown = extra.filter(k => !(b.headerFields.has(k) && !b.headerFields.get(k)!.removed) && !(itemView && b.lineFields.has(k) && !b.lineFields.get(k)!.removed));
    if (unknown.length) throw bad('columns', `Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
    const hidden = this.store.hiddenFields(actor, b);
    const sort = this.sortSpec(b, q.sort, itemView, columns, hidden);
    const conds = this.conditions(actor, b, q, itemView);
    if (!statuses.length) return { data: [], nextCursor: null };
    const cast = sql.raw(sort.cast);
    const dir = sort.desc ? sql`desc` : sql`asc`;
    const idCol = itemView ? sql.ref('l.id') : sql.ref('d.id');
    // Keyset condition (on the sort expression + id only): kept apart so the item-wise page query can apply it on the index.
    const cursorConds: Expression<SqlBool>[] = [];
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      const cmp = sort.desc ? sql`<` : sql`>`;
      cursorConds.push(sql<SqlBool>`(${sort.expr}, ${idCol}) ${cmp} (${c.v}::${cast}, ${c.id}::uuid)`);
    }
    const tid = actor.tenantId;
    if (!itemView) {
      const rows = await tx.selectFrom('app.document as d').innerJoin('app.location_node as loc', 'loc.id', 'd.location_node_id')
        .leftJoin('app.tenant_user as u', 'u.id', 'd.created_by')
        .select(['d.id', 'd.number', 'd.status_key', 'd.doc_date', 'd.location_node_id', 'loc.name as loc_name', 'd.total_amount', 'd.custom', 'd.required_by', 'd.party_id',
          'd.form_version_id', 'd.created_at', 'd.submitted_at', 'u.name as created_by_name'])
        .select(sql<string>`(select count(*) from app.document_line x where x.tenant_id = d.tenant_id and x.document_id = d.id and not x.is_deleted)::text`.as('line_count'))
        .select(sql<boolean>`exists (select 1 from app.wf_instance i join app.wf_stage_state ss on ss.tenant_id = i.tenant_id and ss.instance_id = i.id
            where i.tenant_id = d.tenant_id and i.document_id = d.id and i.status = 'running' and ss.status = 'active' and ss.due_at < now())`.as('overdue'))
        .select(sql<string | null>`(${sort.expr})::text`.as('sort_value'))
        .where('d.tenant_id', '=', tid).where('d.doc_type_id', '=', type.id).where('d.is_deleted', '=', false)
        .where(eb => actor.userId
          ? eb.or([eb('d.status_key', 'in', statuses), eb('d.created_by', '=', actor.userId)])
          : eb('d.status_key', 'in', statuses))
        .where(eb => eb.and([...conds, ...cursorConds]))
        .orderBy(sql`${sort.expr} ${dir}`).orderBy(sql`d.id ${dir}`).limit(q.limit + 1).execute();
      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      const custom = [...new Set([...columns.filter(c => b.headerFields.has(c) && !b.headerSys.has(c)), ...extra])];
      const display = await this.columnValues(tx, actor, b.headerKey, b.header, page.map(r => this.headerData(b, r)), custom, hidden.header);
      const last = page[page.length - 1];
      return {
        data: page.map((r, i): DocListRow => ({
          id: r.id, number: r.number, statusKey: r.status_key, statusLabel: statusLabel(r.status_key, info.labels), docDate: dateStr(r.doc_date)!,
          location: { id: r.location_node_id, name: r.loc_name }, totalAmount: r.total_amount === null || hidden.header.has('total_amount') ? null : String(r.total_amount),
          lineCount: Number(r.line_count), createdBy: r.created_by_name ?? null, createdAt: new Date(r.created_at).toISOString(),
          submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null, columns: display[i]!, overdue: !!r.overdue,
        })),
        nextCursor: more && last ? encodeCursor(last.sort_value, last.id) : null,
      };
    }
    const itemRows = () => tx.selectFrom('app.document_line as l').innerJoin('app.document as d', 'd.id', 'l.document_id')
      .innerJoin('app.location_node as loc', 'loc.id', 'd.location_node_id')
      .leftJoin('app.line_qty_summary as s', 's.line_id', 'l.id')
      .leftJoin('app.master_record as it', 'it.id', 'l.item_id')
      .leftJoin('app.master_record as um', 'um.id', 'l.uom_id')
      .select(['l.id', 'l.document_id', 'd.number', 'l.line_no', 'l.status_key', 'l.item_id', 'it.code as item_code', 'it.name as item_name',
        'um.code as uom_code', 'd.location_node_id', 'loc.name as loc_name', 'l.required_date', 'l.custom', 'd.custom as doc_custom', 'd.form_version_id',
        'd.doc_date', 'd.required_by', 'd.party_id', 'd.total_amount', 'l.uom_id', 'l.qty as line_qty', 'l.rate', 'l.amount', 'l.location_node_id as line_location',
        's.requested', 's.approved', 's.held', 's.rejected', 's.cancelled', 's.short_closed', 's.over_approved', 's.selected', 's.ordered',
        's.received', 's.accepted', 's.rejected_at_receipt', 's.issued', 's.returned'])
      .select(sql<string | null>`(${sort.expr})::text`.as('sort_value'))
      .where('l.tenant_id', '=', tid).where('l.doc_type_id', '=', type.id).where('l.is_deleted', '=', false).where('d.is_deleted', '=', false);
    let rows: Awaited<ReturnType<ReturnType<typeof itemRows>['execute']>>;
    if (sort.key === 'created_at') {
      // QA3-BUG-017: the default order walks document_line_itemwise(_all) (tenant, type[, status], created_at desc, id)
      // and stops after one page; the document/location/search conditions are a per-line correlated check (OFFSET 0
      // keeps the planner from flattening it into a join over every matching line), and summaries + masters are
      // fetched for the page's lines only.
      const page = await tx.selectFrom('app.document_line as l').select(['l.id', sql<string | null>`(${sort.expr})::text`.as('sort_value')])
        .where('l.tenant_id', '=', tid).where('l.doc_type_id', '=', type.id).where('l.is_deleted', '=', false).where('l.status_key', 'in', statuses)
        .where(eb => eb.and([sql<SqlBool>`true`, ...cursorConds]))
        .where(sql<SqlBool>`exists (select 1 from app.document d join app.location_node loc on loc.id = d.location_node_id
          left join app.master_record it on it.id = l.item_id
          where d.id = l.document_id and d.tenant_id = ${tid} and not d.is_deleted ${conds.length ? sql`and ${sql.join(conds, sql` and `)}` : sql``} offset 0)`)
        .orderBy(sql`${sort.expr} ${dir}`).orderBy(sql`l.id ${dir}`).limit(q.limit + 1).execute();
      const order = new Map(page.map((r, i) => [r.id, i]));
      rows = page.length ? (await itemRows().where('l.id', 'in', page.map(r => r.id)).execute()).sort((a, b) => order.get(a.id)! - order.get(b.id)!) : [];
    } else {
      rows = await itemRows().where('l.status_key', 'in', statuses).where(eb => eb.and([...conds, ...cursorConds]))
        .orderBy(sql`${sort.expr} ${dir}`).orderBy(sql`l.id ${dir}`).limit(q.limit + 1).execute();
    }
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    const headerCols = [...new Set([...columns.filter(c => b.headerFields.has(c) && !b.headerSys.has(c)), ...extra.filter(c => b.headerFields.has(c))])];
    const lineCols = [...new Set([...columns.filter(c => b.lineFields.has(c) && !b.lineSys.has(c)), ...extra.filter(c => b.lineFields.has(c) && !b.headerFields.has(c))])];
    const display = await this.columnValues(tx, actor, b.headerKey, b.header, page.map(r => this.headerData(b, { ...r, custom: r.doc_custom })), headerCols, hidden.header);
    const lineDisplay = await this.columnValues(tx, actor, b.lineKey!, b.line!, page.map(r => this.lineData(b, r)), lineCols, hidden.line);
    const last = page[page.length - 1];
    const returnsReopen = await getTenantSetting(tx, 'rtv.reopens_po');
    return {
      data: page.map((r, i): ItemListRow => ({
        lineId: r.id, documentId: r.document_id, number: r.number, lineNo: r.line_no, statusKey: r.status_key === 'submitted' ? 'draft' : r.status_key,
        statusLabel: statusLabel(r.status_key, info.labels),
        item: r.item_id ? { id: r.item_id, code: r.item_code ?? '', name: r.item_name ?? '' } : null, uom: r.uom_code ?? null,
        location: { id: r.location_node_id, name: r.loc_name }, requiredDate: dateStr(r.required_date),
        qty: toQuantityBuckets(bucketsFromRow(r as never), { returnsReopen }),
        columns: { ...display[i]!, ...lineDisplay[i]! },
      })),
      nextCursor: more && last ? encodeCursor(last.sort_value, last.id) : null,
    };
  }

  /** Header values by form keys (system columns + custom) for display decoration. */
  private headerData(b: FormBundle, r: { custom: unknown; location_node_id: string; doc_date: unknown; required_by: unknown; party_id: string | null; total_amount: string | null }) {
    const out: Record<string, unknown> = { ...((r.custom as Record<string, unknown>) ?? {}) };
    const sys: Record<string, unknown> = {
      location: r.location_node_id, doc_date: dateStr(r.doc_date), required_by: dateStr(r.required_by), party: r.party_id,
      total_amount: numForField(r.total_amount, b.headerFields.get('total_amount')),
    };
    for (const [k, v] of Object.entries(sys)) if (b.headerSys.has(k) && v !== null && v !== undefined) out[k] = v;
    return out;
  }

  private lineData(b: FormBundle, r: { custom: unknown; item_id: string | null; uom_id: string | null; line_qty: string; rate: string | null; amount: string | null; required_date: unknown; line_location: string }) {
    const out: Record<string, unknown> = { ...((r.custom as Record<string, unknown>) ?? {}) };
    const sys: Record<string, unknown> = {
      item: r.item_id, uom: r.uom_id, qty: numForField(r.line_qty, b.lineFields.get('qty')), rate: numForField(r.rate, b.lineFields.get('rate')),
      amount: numForField(r.amount, b.lineFields.get('amount')), required_date: dateStr(r.required_date), location: r.line_location,
    };
    for (const [k, v] of Object.entries(sys)) if (b.lineSys.has(k) && v !== null && v !== undefined) out[k] = v;
    return out;
  }

  /** Display values of the requested columns of one form (lookup labels resolved); hidden fields are never returned. */
  private async columnValues(tx: Tx, actor: DocActor, formKey: string, def: FormDefinition, rows: Record<string, unknown>[], keys: string[], hidden: Set<string>) {
    if (!keys.length || !rows.length) return rows.map(() => ({}));
    const visible = keys.filter(k => !hidden.has(k));
    const dec = await this.engine.decorate(tx, actor.tenantId, actor.perms, formKey, rows.map(data => ({ data, def })));
    return dec.map(d => Object.fromEntries(visible.map(k => {
      const v = d.data[k];
      const label = typeof v === 'string' ? d.refs[k]?.[v] : Array.isArray(v) ? (v as unknown[]).map(x => (typeof x === 'string' ? d.refs[k]?.[x] ?? x : x)).join(', ') : undefined;
      return [k, label ?? v ?? null];
    })));
  }

  async counts(tx: Tx, actor: DocActor, type: DocTypeRow, input: ListInput): Promise<{ statusKey: string; label: string; count: number }[]> {
    const { q } = await this.withSavedView(tx, actor, input);
    const b = await this.store.bundle(tx, actor.tenantId, type);
    const info = await this.store.types.stageInfo(tx, type.id);
    const known = (await this.store.types.statuses(tx, type)).map(s => s.key);
    const held = this.orderStatuses(this.heldStatuses(actor, type, known), info.order);
    if (!held.length) return [];
    const itemView = q.view === 'item';
    if (itemView && !b.line) throw bad('view', 'This document type has no lines.');
    const conds = this.conditions(actor, b, q, itemView);
    const tid = actor.tenantId;
    let rows: { status_key: string; n: string }[];
    if (itemView) {
      rows = await tx.selectFrom('app.document_line as l').innerJoin('app.document as d', 'd.id', 'l.document_id')
        .innerJoin('app.location_node as loc', 'loc.id', 'd.location_node_id').leftJoin('app.master_record as it', 'it.id', 'l.item_id')
        .select(['l.status_key', sql<string>`count(*)::text`.as('n')])
        .where('l.tenant_id', '=', tid).where('l.doc_type_id', '=', type.id).where('l.is_deleted', '=', false).where('d.is_deleted', '=', false)
        .where('l.status_key', 'in', held).where(eb => eb.and(conds)).groupBy('l.status_key').execute();
    } else {
      rows = await tx.selectFrom('app.document as d').innerJoin('app.location_node as loc', 'loc.id', 'd.location_node_id')
        .select(['d.status_key', sql<string>`count(*)::text`.as('n')])
        .where('d.tenant_id', '=', tid).where('d.doc_type_id', '=', type.id).where('d.is_deleted', '=', false)
        .where(eb => actor.userId
          ? eb.or([eb('d.status_key', 'in', held), eb('d.created_by', '=', actor.userId)])
          : eb('d.status_key', 'in', held))
        .where(eb => eb.and(conds)).groupBy('d.status_key').execute();
    }
    const by = new Map(rows.map(r => [r.status_key, Number(r.n)]));
    return held.map(k => ({ statusKey: k, label: statusLabel(k, info.labels), count: by.get(k) ?? 0 }));
  }

  /** Whether the caller may list this type at all (view action). */
  canList(actor: DocActor, type: DocTypeRow) {
    return has(actor, docAction(type.key, 'view'));
  }
}

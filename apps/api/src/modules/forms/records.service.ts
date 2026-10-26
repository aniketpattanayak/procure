import { Injectable } from '@nestjs/common';
import {
  ErrorCode, FormDefinition, OptionRow, Page, RecordDeleteBlocked, RecordRow,
} from '@procure/schema';
import { RawBuilder, sql } from 'kysely';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { FilesService } from '../files';
import { DataField } from '@procure/schema';
import { dataFields, isGrid, NUMERIC_TYPES } from './definition';
import { Actor, FormRow, FormsService, tenantToday } from './forms.service';
import { MasterRow, settingsOf } from './masters.service';
import { RecordEngine, uniqueLockKey, validationFailed } from './record-engine';
import { canonicalDecimal, decimalPlaces, numericPlaces, toPlaces, ValueIssue } from './validators';

export interface RecordDbRow {
  id: string;
  master_id: string;
  code: string;
  name: string;
  is_active: boolean;
  data: Record<string, unknown>;
  form_version_id: string;
  created_at: Date;
  updated_at: Date;
  version: number;
}

export interface RecordInput {
  code?: string;
  name: string;
  data: Record<string, unknown>;
  version?: number;
}

/** Per-call cache so imports of thousands of rows load the form and the tenant date once. */
export interface SaveCache {
  form?: FormRow;
  current?: { id: string; definition: FormDefinition };
  today?: string;
}

export interface ListParams {
  cursor?: string;
  limit: number;
  q?: string;
  view: 'active' | 'inactive' | 'all';
  sort?: string;
  filters: Record<string, string>;
}

const REC_COLS = ['id', 'master_id', 'code', 'name', 'is_active', 'data', 'form_version_id', 'created_at', 'updated_at', 'version'] as const;
const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);

/** Postgres tsquery from free text: every word as a prefix, AND-ed. Only letters/digits survive. */
export function prefixQuery(q: string): string | null {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
  return words.length ? words.map(w => `${w}:*`).join(' & ') : null;
}

/** Literal parts and sequence width of a code pattern like 'ITM-{SEQ:5}' / '{YY}{MM}-{SEQ:4}'. */
export function expandCodePattern(pattern: string, today: string): { prefix: string; suffix: string; width: number } {
  const [y, m] = today.split('-') as [string, string];
  const withDates = pattern.replace(/\{YYYY\}/g, y).replace(/\{YY\}/g, y.slice(2)).replace(/\{MM\}/g, m);
  const seq = /\{SEQ(?::(\d))?\}/.exec(withDates);
  if (!seq) return { prefix: withDates, suffix: '', width: 4 };
  return { prefix: withDates.slice(0, seq.index), suffix: withDates.slice(seq.index + seq[0].length), width: Number(seq[1] ?? 4) };
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class RecordsService {
  constructor(
    private readonly forms: FormsService,
    private readonly engine: RecordEngine,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ reads
  async loadRow(tx: Tx, tenantId: string, master: MasterRow, id: string, lock = false): Promise<RecordDbRow> {
    let q = tx.selectFrom('app.master_record').select([...REC_COLS])
      .where('tenant_id', '=', tenantId).where('master_id', '=', master.id).where('id', '=', id).where('is_deleted', '=', false);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw AppError.notFound(master.name);
    return r as RecordDbRow;
  }

  /** RecordRow[] with refs/files filled in batch and hidden fields removed; each rendered with its own version. */
  async toRows(tx: Tx, actor: Actor, master: MasterRow, rows: RecordDbRow[]): Promise<RecordRow[]> {
    const defs = await this.forms.versionsById(tx, actor.tenantId, rows.map(r => r.form_version_id));
    const decorated = await this.engine.decorate(tx, actor.tenantId, actor.perms, master.key,
      rows.map(r => ({ data: r.data ?? {}, def: defs.get(r.form_version_id) ?? { version: 1, fields: [], validations: [] } })));
    return rows.map((r, i) => ({
      id: r.id, code: r.code, name: r.name, isActive: r.is_active, data: decorated[i]!.data, refs: decorated[i]!.refs, files: decorated[i]!.files,
      formVersionId: r.form_version_id, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), version: r.version,
    }));
  }

  async get(tx: Tx, actor: Actor, master: MasterRow, id: string): Promise<RecordRow> {
    return (await this.toRows(tx, actor, master, [await this.loadRow(tx, actor.tenantId, master, id)]))[0]!;
  }

  async list(tx: Tx, actor: Actor, master: MasterRow, p: ListParams): Promise<Page<RecordRow>> {
    const form = await this.forms.loadById(tx, actor.tenantId, master.form_id);
    const def = (await this.forms.current(tx, actor.tenantId, form)).definition;
    const fields = new Map(dataFields(def).map(f => [f.key, f]));
    const access = actor.perms?.fieldAccess?.[master.key] ?? {};

    let qb = tx.selectFrom('app.master_record as r').select(REC_COLS.map(c => `r.${c}` as const))
      .where('r.tenant_id', '=', actor.tenantId).where('r.master_id', '=', master.id).where('r.is_deleted', '=', false);
    if (p.view !== 'all') qb = qb.where('r.is_active', '=', p.view === 'active');
    if (p.q) {
      // Prefix tsquery over code + name words (GIN on `search`); text without letters/digits matches nothing.
      const tsq = prefixQuery(p.q);
      qb = qb.where(tsq ? sql<boolean>`r.search @@ to_tsquery('simple', ${tsq})` : sql<boolean>`false`);
    }
    for (const [key, raw] of Object.entries(p.filters)) {
      if (key === 'code' || key === 'name') {
        qb = qb.where(key === 'code' ? sql<boolean>`r.code = ${raw}::citext` : sql<boolean>`r.name = ${raw}`);
        continue;
      }
      const f = fields.get(key);
      if (!f || isGrid(f) || access[key] === 'hidden') throw bad(`f.${key}`, `Cannot filter by "${key}".`);
      qb = qb.where(sql<boolean>`r.data @> ${JSON.stringify({ [key]: filterValue(f, raw) })}::jsonb`);
    }

    // sort + keyset cursor over (sort expression, id)
    const sortSpec = p.sort ?? settingsOf(master).defaultSort;
    const desc = sortSpec.startsWith('-');
    const sortKey = desc ? sortSpec.slice(1) : sortSpec;
    let expr: RawBuilder<unknown>;
    let cast: string;
    if (sortKey === 'name') [expr, cast] = [sql`r.name`, 'text'];
    else if (sortKey === 'code') [expr, cast] = [sql`r.code`, 'citext'];
    else if (sortKey === 'created_at' || sortKey === 'updated_at') [expr, cast] = [sql`${sql.ref(`r.${sortKey}`)}`, 'timestamptz'];
    else {
      const f = fields.get(sortKey);
      // Data-key sorts read every record of the master (no index on the expression); allowed for list columns only.
      // Very large masters should get an expression index on that key (ADR-0006 note).
      if (!f || isGrid(f) || access[sortKey] === 'hidden' || !settingsOf(master).listColumns.includes(sortKey)) {
        throw bad('sort', `Cannot sort by "${sortKey}". Only code, name, dates and list columns can be sorted.`);
      }
      if (NUMERIC_TYPES.has(f.type) || (f.type === 'formula' && f.resultType === 'number')) {
        [expr, cast] = [sql`coalesce((r.data->>${sortKey})::numeric, 0)`, 'numeric'];
      } else [expr, cast] = [sql`coalesce(r.data->>${sortKey}, '')`, 'text'];
    }
    const castSql = sql.raw(cast);
    if (p.cursor) {
      const c = decodeRecordCursor(p.cursor);
      const cmp = desc ? sql`<` : sql`>`;
      qb = qb.where(sql<boolean>`(${expr}, r.id) ${cmp} (${c.v}::${castSql}, ${c.id}::uuid)`);
    }
    const dir = desc ? sql`desc` : sql`asc`;
    const rows = await qb.select(sql<string>`(${expr})::text`.as('sort_value'))
      .orderBy(sql`${expr} ${dir}`).orderBy(sql`r.id ${dir}`).limit(p.limit + 1).execute();
    const more = rows.length > p.limit;
    const pageRows = more ? rows.slice(0, p.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: await this.toRows(tx, actor, master, pageRows as unknown as RecordDbRow[]),
      nextCursor: more && last ? Buffer.from(JSON.stringify({ v: last.sort_value, id: last.id })).toString('base64url') : null,
    };
  }

  // ------------------------------------------------------------------ writes
  /**
   * The full save pipeline for one master record. Returns the stored row (callers decorate it for the response).
   * `existing` = update (re-saved under the current form version; removed fields' data kept).
   */
  async save(tx: Tx, actor: Actor, master: MasterRow, input: RecordInput, existing: RecordDbRow | null, cache: SaveCache = {}): Promise<RecordDbRow> {
    const tid = actor.tenantId;
    if (!existing && !master.is_active) throw AppError.conflict(`"${master.plural_name}" is inactive; new records cannot be added.`);
    cache.form ??= await this.forms.loadById(tx, tid, master.form_id);
    cache.current ??= await this.forms.current(tx, tid, cache.form);
    cache.today ??= await tenantToday(tx);
    const def = cache.current.definition;
    const settings = settingsOf(master);

    const name = input.name.trim();
    let code = input.code?.trim() || existing?.code || '';
    const errors: ValueIssue[] = [];
    if (!name) errors.push({ path: 'name', message: `${settings.nameLabel} is required.` });
    if (!code && !settings.codePattern) errors.push({ path: 'code', message: `${settings.codeLabel} is required.` });

    let prepared;
    try {
      prepared = await this.engine.prepare(tx, tid, {
        def, formKey: master.key, prev: existing?.data ?? {}, incoming: input.data ?? {}, isCreate: !existing,
        owner: { kind: 'master_record', id: existing?.id ?? null }, extraValues: { code, name }, today: cache.today, perms: actor.perms,
      });
    } catch (e) {
      if (e instanceof AppError && e.code === ErrorCode.VALIDATION && errors.length) throw validationFailed([...errors, ...(e.errors ?? [])]);
      throw e;
    }
    if (errors.length) throw validationFailed(errors);

    // code: generated from the pattern when not typed; unique among live records of this master
    if (!code) code = await this.nextCode(tx, tid, master, settings.codePattern!, cache.today);
    const dup = await tx.selectFrom('app.master_record').select('id')
      .where('tenant_id', '=', tid).where('master_id', '=', master.id).where('is_deleted', '=', false)
      .where(sql<boolean>`code = ${code}::citext`).$if(!!existing, q => q.where('id', '<>', existing!.id)).executeTakeFirst();
    if (dup) {
      throw new AppError(409, ErrorCode.CONFLICT, `${settings.codeLabel} "${code}" is already used.`, { field: 'code' },
        [{ path: 'code', message: `${settings.codeLabel} "${code}" is already used.` }]);
    }

    // unique fields (advisory lock per master + field so concurrent saves serialise)
    for (const f of dataFields(def)) {
      if (!f.unique || isGrid(f)) continue;
      const v = prepared.data[f.key];
      if (v === undefined || v === null || v === '') continue;
      await uniqueLockKey(master.id, f.key).execute(tx);
      const cond = typeof v === 'string'
        ? sql<boolean>`lower(data->>${f.key}) = lower(${v})`
        : sql<boolean>`data->${f.key} = ${JSON.stringify(v)}::jsonb`;
      const other = await tx.selectFrom('app.master_record').select('code')
        .where('tenant_id', '=', tid).where('master_id', '=', master.id).where('is_deleted', '=', false).where(cond)
        .$if(!!existing, q => q.where('id', '<>', existing!.id)).executeTakeFirst();
      if (other) {
        const msg = `${f.label} must be unique; ${Array.isArray(v) ? v.join(', ') : String(v)} is already used by ${other.code}.`;
        throw new AppError(409, ErrorCode.CONFLICT, msg, { field: f.key }, [{ path: f.key, message: msg }]);
      }
    }

    let row: RecordDbRow;
    if (existing) {
      const res = await tx.updateTable('app.master_record').set({
        code, name, data: JSON.stringify(prepared.data), form_version_id: cache.current.id, updated_by: actor.userId,
      }).where('tenant_id', '=', tid).where('id', '=', existing.id).where('is_deleted', '=', false)
        .$if(input.version !== undefined, q => q.where('version', '=', input.version!))
        .returning([...REC_COLS]).executeTakeFirst();
      if (!res) throw AppError.versionConflict();
      row = res as RecordDbRow;
    } else {
      row = (await tx.insertInto('app.master_record').values({
        tenant_id: tid, master_id: master.id, code, name, data: JSON.stringify(prepared.data), form_version_id: cache.current.id,
        created_by: actor.userId, updated_by: actor.userId,
      }).returning([...REC_COLS]).executeTakeFirstOrThrow()) as RecordDbRow;
    }
    await this.engine.writeRefs(tx, tid, { kind: 'master_record', id: row.id }, prepared.refs);
    await this.files.syncAttachments(tx, tid, { kind: 'master_record', id: row.id }, prepared.files);
    await this.audit.tenant(tx, {
      action: existing ? 'update' : 'create', entity: 'master_record', entityId: row.id, actorId: actor.userId,
      before: existing ? snapshot(master, existing) : undefined, after: snapshot(master, row),
    });
    return row;
  }

  private async nextCode(tx: Tx, tenantId: string, master: MasterRow, pattern: string, today: string): Promise<string> {
    const { prefix, suffix, width } = expandCodePattern(pattern, today);
    await sql`select pg_advisory_xact_lock(hashtextextended(${`code:${master.id}`}, 0))`.execute(tx);
    const re = `^${reEscape(prefix)}([0-9]+)${reEscape(suffix)}$`;
    const r = await sql<{ n: string | null }>`
      select max(substring(code::text from ${re})::bigint)::text as n from app.master_record
      where tenant_id = ${tenantId} and master_id = ${master.id} and code::text ~ ${re}`.execute(tx);
    const next = Number(r.rows[0]?.n ?? 0) + 1;
    return `${prefix}${String(next).padStart(width, '0')}${suffix}`;
  }

  async create(tx: Tx, actor: Actor, master: MasterRow, input: RecordInput): Promise<RecordRow> {
    const row = await this.save(tx, actor, master, input, null);
    return (await this.toRows(tx, actor, master, [row]))[0]!;
  }

  async update(tx: Tx, actor: Actor, master: MasterRow, id: string, input: RecordInput & { version: number }): Promise<RecordRow> {
    const existing = await this.loadRow(tx, actor.tenantId, master, id, true);
    if (existing.version !== input.version) throw AppError.versionConflict();
    const row = await this.save(tx, actor, master, input, existing);
    return (await this.toRows(tx, actor, master, [row]))[0]!;
  }

  async setActive(tx: Tx, actor: Actor, master: MasterRow, id: string, active: boolean): Promise<RecordRow> {
    const before = await this.loadRow(tx, actor.tenantId, master, id, true);
    if (before.is_active !== active) {
      await tx.updateTable('app.master_record').set({ is_active: active, updated_by: actor.userId })
        .where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
      await this.audit.tenant(tx, {
        action: active ? 'activate' : 'deactivate', entity: 'master_record', entityId: id, actorId: actor.userId,
        before: { isActive: before.is_active }, after: { isActive: active, master: master.key, code: before.code },
      });
    }
    return this.get(tx, actor, master, id);
  }

  /** Where a record is referenced (live sources only), grouped by source. */
  async usage(tx: Tx, tenantId: string, recordId: string): Promise<RecordDeleteBlocked['usedBy']> {
    const r = await sql<{ kind: string; label: string; count: string }>`
      select 'master_record' as kind, d.plural_name as label, count(distinct x.from_id)::text as count
        from app.record_ref x
        join app.master_record s on s.id = x.from_id and s.tenant_id = x.tenant_id and not s.is_deleted
        join app.master_def d on d.id = s.master_id
       where x.tenant_id = ${tenantId} and x.to_kind = 'master_record' and x.to_id = ${recordId} and x.from_kind = 'master_record'
       group by d.plural_name
      union all
      select 'tenant_user', 'Users', count(distinct x.from_id)::text
        from app.record_ref x
        join app.tenant_user u on u.id = x.from_id and u.tenant_id = x.tenant_id and not u.is_deleted
       where x.tenant_id = ${tenantId} and x.to_kind = 'master_record' and x.to_id = ${recordId} and x.from_kind = 'tenant_user'
      having count(*) > 0
      union all
      select x.from_kind, x.from_kind, count(distinct x.from_id)::text
        from app.record_ref x
       where x.tenant_id = ${tenantId} and x.to_kind = 'master_record' and x.to_id = ${recordId}
         and x.from_kind not in ('master_record', 'tenant_user')
       group by x.from_kind
       order by 2`.execute(tx);
    return r.rows.map(x => ({ kind: x.kind, label: x.label, count: Number(x.count) })).filter(x => x.count > 0);
  }

  /** Soft delete; blocked with 409 RECORD_IN_USE while anything live references the record. */
  async remove(tx: Tx, actor: Actor, master: MasterRow, id: string, reason: string): Promise<void> {
    const before = await this.loadRow(tx, actor.tenantId, master, id, true);
    const usedBy = await this.usage(tx, actor.tenantId, id);
    if (usedBy.length) {
      const blocked: RecordDeleteBlocked = { code: 'RECORD_IN_USE', usedBy };
      const where = usedBy.map(u => `${u.count} ${u.label}`).join(', ');
      throw new AppError(409, 'RECORD_IN_USE', `"${before.name}" is used by ${where}. Deactivate it instead.`, blocked as unknown as Record<string, unknown>);
    }
    await tx.updateTable('app.master_record').set({ is_deleted: true, deleted_reason: reason, updated_by: actor.userId })
      .where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    await this.engine.writeRefs(tx, actor.tenantId, { kind: 'master_record', id }, []);
    await this.audit.tenant(tx, { action: 'delete', entity: 'master_record', entityId: id, actorId: actor.userId, before: snapshot(master, before), after: { reason } });
  }

  // ------------------------------------------------------------------ options (dropdown feed)
  async options(
    tx: Tx, actor: Actor, master: MasterRow,
    q: { q?: string; limit: number; filter?: string | string[]; include?: string | string[]; attrs?: string | string[] },
  ): Promise<OptionRow[]> {
    const form = await this.forms.loadById(tx, actor.tenantId, master.form_id);
    const def = (await this.forms.current(tx, actor.tenantId, form)).definition;
    const fields = new Map(dataFields(def).map(f => [f.key, f]));
    const access = actor.perms?.fieldAccess?.[master.key] ?? {};
    const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

    let qb = tx.selectFrom('app.master_record as r').select(['r.id', 'r.code', 'r.name', 'r.is_active', 'r.data'])
      .where('r.tenant_id', '=', actor.tenantId).where('r.master_id', '=', master.id).where('r.is_deleted', '=', false);
    const filters = list(q.filter);
    // QA2-BUG-004: only fields that some published lookup to this master cascades on (filterBy.targetField), and that
    // the caller can see, may be filtered on; anything else would be an oracle for values the caller cannot read.
    const cascade = filters.length ? await this.forms.cascadeTargets(tx, actor.tenantId, master.key) : new Set<string>();
    const containment: Record<string, unknown> = {};
    for (const flt of filters) {
      const i = flt.indexOf(':');
      if (i < 1) throw bad('filter', 'Use filter=<field>:<value>.');
      const key = flt.slice(0, i);
      const value = flt.slice(i + 1);
      if (!cascade.has(key) || access[key] === 'hidden') throw bad('filter', `Options of "${master.key}" cannot be filtered by "${key}".`);
      if (value === '') return []; // parent not chosen yet
      if (key === 'code' || key === 'name') {
        qb = qb.where(key === 'code' ? sql<boolean>`r.code = ${value}::citext` : sql<boolean>`r.name = ${value}`);
        continue;
      }
      const f = fields.get(key);
      if (!f || isGrid(f)) throw bad('filter', `"${master.key}" has no field "${key}".`);
      containment[key] = filterValue(f, value);
    }
    // One containment predicate (GIN jsonb_path_ops) + prefix tsquery on `search` (GIN); ordered by name with LIMIT
    // (QA2-BUG-009: no OR with a LIKE, which forced a seq scan).
    if (Object.keys(containment).length) qb = qb.where(sql<boolean>`r.data @> ${JSON.stringify(containment)}::jsonb`);
    if (q.q) {
      const tsq = prefixQuery(q.q);
      if (!tsq) return [];
      qb = qb.where(sql<boolean>`r.search @@ to_tsquery('simple', ${tsq})`);
    }
    let rows = await qb.where('r.is_active', '=', true).orderBy('r.name').orderBy('r.id').limit(q.limit).execute();
    const include = list(q.include).filter(id => !rows.some(r => r.id === id));
    if (include.length) {
      const extra = await tx.selectFrom('app.master_record as r').select(['r.id', 'r.code', 'r.name', 'r.is_active', 'r.data'])
        .where('r.tenant_id', '=', actor.tenantId).where('r.master_id', '=', master.id).where('r.is_deleted', '=', false)
        .where('r.id', 'in', include).execute();
      rows = [...rows, ...extra];
    }
    const attrs = list(q.attrs).filter(a => a === 'code' || a === 'name' || (fields.has(a) && access[a] !== 'hidden'));
    return rows.map(r => {
      const o: OptionRow = { id: r.id, code: r.code, name: r.name, label: `${r.code} - ${r.name}`, isActive: r.is_active };
      if (attrs.length) {
        const data = (r.data ?? {}) as Record<string, unknown>;
        o.attrs = Object.fromEntries(attrs.map(a => [a, a === 'code' ? r.code : a === 'name' ? r.name : data[a] ?? null]));
      }
      return o;
    });
  }
}

// ------------------------------------------------------------------ helpers

/** Value shape for `data @> {...}` containment from a query-string value. */
export function filterValue(f: DataField, raw: string): unknown {
  if (f.type === 'checkbox' || f.type === 'toggle') return raw === 'true';
  if (NUMERIC_TYPES.has(f.type)) {
    const canon = canonicalDecimal(raw);
    const places = numericPlaces(f as { type: string; precision?: number });
    // stored values are normalised to the field's precision; a value with more places can never match
    return canon === null || decimalPlaces(canon) > places ? raw : toPlaces(canon, places);
  }
  if (f.type === 'multiselect' || f.type === 'multilookup' || f.type === 'files') return [raw];
  if (f.type === 'lookup') return raw.toLowerCase();
  return raw;
}

function decodeRecordCursor(c: string): { v: string; id: string } {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { v: unknown; id: unknown };
    if (typeof v.v !== 'string' || typeof v.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(v.id)) throw new Error('bad');
    return { v: v.v, id: v.id };
  } catch {
    throw new AppError(400, ErrorCode.VALIDATION, 'The page cursor is invalid. Start again from the first page.');
  }
}

function snapshot(master: MasterRow, r: RecordDbRow) {
  return { master: master.key, code: r.code, name: r.name, isActive: r.is_active, data: r.data, formVersionId: r.form_version_id };
}


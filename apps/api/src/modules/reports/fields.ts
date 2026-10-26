import type { DataField, FormDefinition } from '@procure/schema';
import { RawBuilder, sql } from 'kysely';
import { dataFields, isGrid } from '../forms';
import type { FieldJoin, FieldType, SourceField } from './types';

/**
 * Catalogue fields generated from a form definition (custom header/line fields, item attributes, master data).
 * Stored values are JSON text; every cast is guarded so a malformed value reads as NULL instead of failing the query.
 */
const NUM_RE = '^-?[0-9]+(\\.[0-9]+)?$';
const DATE_RE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
const TS_RE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}';
const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const asNumeric = (t: RawBuilder<unknown>) => sql`(case when ${t} ~ ${NUM_RE} then (${t})::numeric end)`;
export const asDate = (t: RawBuilder<unknown>) => sql`(case when ${t} ~ ${DATE_RE} then (${t})::date end)`;
export const asTimestamp = (t: RawBuilder<unknown>) => sql`(case when ${t} ~ ${TS_RE} then (${t})::timestamptz end)`;
export const asBool = (t: RawBuilder<unknown>) => sql`(case when ${t} in ('true', 'false') then (${t})::boolean end)`;
export const asUuid = (t: RawBuilder<unknown>) => sql`(case when ${t} ~ ${UUID_RE} then (${t})::uuid end)`;

/** `left join lateral (<body>) alias on true` — a per-row lookup the planner can memoize. */
export function lateral(alias: string, body: RawBuilder<unknown>): FieldJoin {
  const a = alias.replace(/[^a-z0-9_]/gi, '_').slice(0, 60);
  return { alias: a, sql: sql`left join lateral (${body}) ${sql.ref(a)} on true` };
}
export const col = (j: FieldJoin, c: string) => sql.ref(`${j.alias}.${c}`);

/** Year-month ('2026-10') and year of a date/timestamp expression (timestamps in the tenant timezone). */
export function dateParts(f: Pick<SourceField, 'id' | 'label' | 'path' | 'expr' | 'type' | 'access' | 'joins'>, timezone: string): SourceField[] {
  const local = f.type === 'datetime' ? sql`((${f.expr}) at time zone ${timezone})` : f.expr;
  return [
    { id: `${f.id}.month`, label: `${f.label} (month)`, type: 'text', path: f.path, expr: sql`to_char(${local}, 'YYYY-MM')`, access: f.access, joins: f.joins, aggregatable: false },
    { id: `${f.id}.year`, label: `${f.label} (year)`, type: 'text', path: f.path, expr: sql`to_char(${local}, 'YYYY')`, access: f.access, joins: f.joins, aggregatable: false },
  ];
}

const NUMERIC = new Set(['number', 'decimal', 'percentage']);

function typeOf(f: DataField): FieldType | null {
  if (NUMERIC.has(f.type)) return 'number';
  if (f.type === 'currency') return 'currency';
  if (f.type === 'date') return 'date';
  if (f.type === 'datetime') return 'datetime';
  if (f.type === 'checkbox' || f.type === 'toggle') return 'boolean';
  if (f.type === 'formula') {
    const rt = (f as { resultType?: string }).resultType ?? 'number';
    return rt === 'number' ? 'number' : rt === 'date' ? 'date' : rt === 'boolean' ? 'boolean' : 'text';
  }
  if (['text', 'textarea', 'select', 'radio', 'email', 'phone', 'url', 'gstin', 'pan', 'regex', 'time'].includes(f.type)) return 'text';
  if (f.type === 'lookup') return 'lookup';
  return null; // multiselect, multilookup, files, grids, daterange: not reportable
}

export interface FormFieldsSpec {
  /** Field id prefix, e.g. 'custom.' / 'line.custom.' / 'item.' / 'data.'. */
  idPrefix: string;
  /** JSONB column holding the values, e.g. sql`d.custom`. */
  json: RawBuilder<unknown>;
  /** Form key for field access. */
  formKey: string;
  /** UI path prefix, e.g. ['Header'] / ['Item']. */
  path: string[];
  /** Keys to skip (system fields mapped to columns). */
  skip?: Set<string>;
  /** Extra access coordinates every generated field also depends on (e.g. the line form's item field). */
  extraAccess?: { formKey: string; fieldKey: string }[];
  /** Tenant id (explicit filter for lookup subqueries; RLS applies too). */
  tenantId: string;
  timezone: string;
}

/** Catalogue fields for every reportable data field of a form definition. */
export function formFields(def: FormDefinition, s: FormFieldsSpec): SourceField[] {
  const out: SourceField[] = [];
  for (const f of dataFields(def)) {
    if (f.removed || isGrid(f) || s.skip?.has(f.key)) continue;
    const type = typeOf(f);
    if (!type) continue;
    const raw = sql`(${s.json} ->> ${f.key})`;
    const access = [{ formKey: s.formKey, fieldKey: f.key }, ...(s.extraAccess ?? [])];
    const id = `${s.idPrefix}${f.key}`;
    const label = f.label;
    if (type === 'lookup') {
      const src = (f as Extract<DataField, { type: 'lookup' }>).source;
      const ref = asUuid(raw);
      const lk = `lk_${s.idPrefix}${f.key}`;
      if (src.kind === 'master') {
        // joined on text: no per-row uuid guard, and the planner flattens it into a hash join
        const j = lateral(lk, sql`select r.name, r.code::text as code from app.master_record r where r.tenant_id = ${s.tenantId} and r.id::text = ${raw}`);
        out.push({ id: `${id}.name`, label, type: 'lookup', path: [...s.path, label], idExpr: ref, access, joins: [j], expr: col(j, 'name') });
        out.push({ id: `${id}.code`, label: `${label} code`, type: 'text', path: [...s.path, label], idExpr: ref, access, joins: [j], expr: col(j, 'code') });
      } else if (src.kind === 'location') {
        const j = lateral(lk, sql`select n.name, n.code, n.path from app.location_node n where n.tenant_id = ${s.tenantId} and n.id::text = ${raw}`);
        out.push({ id: `${id}.name`, label, type: 'lookup', path: [...s.path, label], idExpr: ref, locationPath: col(j, 'path'), access, joins: [j], expr: col(j, 'name') });
        out.push({ id: `${id}.code`, label: `${label} code`, type: 'text', path: [...s.path, label], idExpr: ref, locationPath: col(j, 'path'), access, joins: [j], expr: col(j, 'code') });
      } else {
        const j = lateral(lk, sql`select u.name from app.tenant_user u where u.tenant_id = ${s.tenantId} and u.id::text = ${raw}`);
        out.push({ id: `${id}.name`, label, type: 'lookup', path: [...s.path, label], idExpr: ref, access, joins: [j], expr: col(j, 'name') });
      }
      continue;
    }
    const expr = type === 'number' || type === 'currency' ? asNumeric(raw)
      : type === 'date' ? asDate(raw) : type === 'datetime' ? asTimestamp(raw) : type === 'boolean' ? asBool(raw) : raw;
    const options = (f as { options?: { value: string; label: string }[] }).options;
    const field: SourceField = {
      id, label, type, path: s.path, expr, access,
      ...(options ? { labels: Object.fromEntries(options.map(o => [o.value, o.label])) } : {}),
    };
    out.push(field);
    if (type === 'date' || type === 'datetime') out.push(...dateParts(field, s.timezone));
  }
  return out;
}

/** Default capabilities of a field type. */
export function capabilities(f: SourceField): { groupable: boolean; filterable: boolean; aggregatable: boolean } {
  const numeric = f.type === 'number' || f.type === 'currency';
  return {
    groupable: f.groupable ?? f.type !== 'datetime',
    filterable: f.filterable ?? true,
    aggregatable: f.aggregatable ?? numeric,
  };
}

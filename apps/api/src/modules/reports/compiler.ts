import { ErrorCode, ReportDefinition, ReportResult } from '@procure/schema';
import type { MyPermissions } from '@procure/schema';
import { Expression, RawBuilder, sql, SqlBool } from 'kysely';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { NodeFilter, scopeCondition } from '../permissions';
import { capabilities } from './fields';
import { DatePreset, DateRange, isDateStr, presetRange } from './presets';
import type { FieldType, ResolvedSource, SourceField } from './types';

/**
 * Report compiler (ADR-0015): a `ReportDefinition` over a `ResolvedSource` becomes one parameterised query built
 * with Kysely's `sql` template. Field ids select catalogue expressions only; every user-supplied value (filters,
 * params, cursors) is a bound parameter cast to the field's SQL type. GROUP BY uses output ordinals, the outer query
 * orders and pages over the inner query's output columns (keyset, nulls last, stable tiebreak).
 */
export type Agg = 'none' | 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct';
type Def = ReportDefinition;
type Filter = Def['filters'][number];

export const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);

export interface CompileContext {
  timezone: string;
  fyStartMonth: number;
  /** 'YYYY-MM-DD' in the tenant timezone. */
  today: string;
  perms: MyPermissions | null;
  /** Data-scope filter for a tab (ScopeService.nodeFilter); unused when perms is null. */
  nodeFilter: (perms: MyPermissions, tabKey: string) => NodeFilter;
}

export interface RunOptions {
  params?: Record<string, unknown>;
  cursor?: string;
  limit: number;
  /** Explicit date range replacing the preset (KPI previous period). */
  dateRange?: DateRange | null;
  /** Skip totals / groups / chart (export batches). */
  rowsOnly?: boolean;
}

export interface OutCol {
  key: string;            // c0, c1 … in SQL
  field: SourceField;
  label: string;
  aggregate: Agg;
  type: FieldType;
  sqlType: string;
  hidden: boolean;        // added for grouping/sorting, not returned
  expr: RawBuilder<unknown>;
}

const SQL_TYPE: Record<FieldType, string> = {
  number: 'numeric', currency: 'numeric', date: 'date', datetime: 'timestamptz', boolean: 'boolean', text: 'text', status: 'text', lookup: 'text',
};
const COMPARABLE = new Set<FieldType>(['number', 'currency', 'date', 'datetime', 'text', 'status', 'lookup']);
const TEXTUAL = new Set<FieldType>(['text', 'status', 'lookup']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUM = /^-?\d{1,18}(\.\d{1,10})?$/;
const MAX_IN = 500;

/** Fields the viewer may use: hidden fields (field access) are removed entirely. */
export function viewerFields(fields: SourceField[], perms: MyPermissions | null): SourceField[] {
  if (!perms) return fields;
  const fa = perms.fieldAccess ?? {};
  return fields.filter(f => !(f.access ?? []).some(a => fa[a.formKey]?.[a.fieldKey] === 'hidden'));
}

// ------------------------------------------------------------------ values

function scalar(f: SourceField, v: unknown, path: string, op: string): RawBuilder<unknown> {
  const t = f.type;
  if (v === null || v === undefined || (typeof v === 'object')) throw bad(path, `"${f.label}" needs a value for "${op}".`);
  if (t === 'number' || t === 'currency') {
    const s = typeof v === 'number' ? String(v) : String(v).trim();
    if (!NUM.test(s)) throw bad(path, `"${f.label}" needs a number.`);
    return sql`${s}::numeric`;
  }
  if (t === 'date') {
    if (!isDateStr(v)) throw bad(path, `"${f.label}" needs a date (YYYY-MM-DD).`);
    return sql`${v}::date`;
  }
  if (t === 'datetime') {
    if (isDateStr(v)) return sql`${v}::date`;
    const d = new Date(String(v));
    if (typeof v !== 'string' || Number.isNaN(d.getTime())) throw bad(path, `"${f.label}" needs a date and time.`);
    return sql`${d.toISOString()}::timestamptz`;
  }
  if (t === 'boolean') {
    if (v === true || v === 'true') return sql`true`;
    if (v === false || v === 'false') return sql`false`;
    throw bad(path, `"${f.label}" needs true or false.`);
  }
  const s = String(v);
  if (s.length > 500) throw bad(path, `"${f.label}": value is too long.`);
  return sql`${s}::text`;
}

/** Left side for a comparison: datetimes compared with a plain date use the tenant-local day. */
function lhs(f: SourceField, v: unknown, tz: string): RawBuilder<unknown> {
  if (f.type === 'datetime' && isDateStr(v)) return sql`((${f.expr}) at time zone ${tz})::date`;
  return f.expr;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, m => `\\${m}`);

function filterCondition(f: SourceField, flt: Filter, value: unknown, path: string, tz: string): Expression<SqlBool> {
  const op = flt.op;
  const list = (): unknown[] => {
    if (!Array.isArray(value) || !value.length) throw bad(path, `"${f.label}" needs a list of values for "${op}".`);
    if (value.length > MAX_IN) throw bad(path, `At most ${MAX_IN} values.`);
    return value;
  };
  const restricted = (vals: unknown[]) => {
    if (!f.allowedValues) return;
    const missing = vals.map(String).filter(v => !f.allowedValues!.includes(v));
    if (missing.length) throw AppError.forbidden(`You cannot see records in status ${missing.join(', ')}.`);
  };
  const byId = (v: unknown) => !!f.idExpr && typeof v === 'string' && UUID.test(v);
  switch (op) {
    case 'eq': case 'ne': {
      restricted(op === 'eq' ? [value] : []);
      if (byId(value)) return op === 'eq' ? sql<SqlBool>`${f.idExpr!} = ${value}::uuid` : sql<SqlBool>`${f.idExpr!} is distinct from ${value}::uuid`;
      const v = scalar(f, value, path, op);
      return op === 'eq' ? sql<SqlBool>`${lhs(f, value, tz)} = ${v}` : sql<SqlBool>`${lhs(f, value, tz)} is distinct from ${v}`;
    }
    case 'in': case 'not_in': {
      const vals = list();
      if (op === 'in') restricted(vals);
      if (vals.every(byId)) {
        return op === 'in' ? sql<SqlBool>`${f.idExpr!} = any(${vals.map(String)}::uuid[])` : sql<SqlBool>`not (${f.idExpr!} = any(${vals.map(String)}::uuid[]))`;
      }
      const parts = vals.map((v, i) => scalar(f, v, `${path}.${i}`, op));
      const arr = sql`array[${sql.join(parts)}]`;
      return op === 'in' ? sql<SqlBool>`${f.expr} = any(${arr})` : sql<SqlBool>`(${f.expr} is null or not (${f.expr} = any(${arr})))`;
    }
    case 'gt': case 'gte': case 'lt': case 'lte': {
      if (!COMPARABLE.has(f.type)) throw bad(path, `"${f.label}" cannot be compared with "${op}".`);
      const cmp = sql.raw({ gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]);
      return sql<SqlBool>`${lhs(f, value, tz)} ${cmp} ${scalar(f, value, path, op)}`;
    }
    case 'between': {
      if (!COMPARABLE.has(f.type)) throw bad(path, `"${f.label}" cannot be used with "between".`);
      if (!Array.isArray(value) || value.length !== 2) throw bad(path, `"between" needs [from, to].`);
      const [a, b] = value as [unknown, unknown];
      return sql<SqlBool>`(${lhs(f, a, tz)} >= ${scalar(f, a, `${path}.0`, op)} and ${lhs(f, b, tz)} <= ${scalar(f, b, `${path}.1`, op)})`;
    }
    case 'contains': case 'starts_with': {
      if (!TEXTUAL.has(f.type)) throw bad(path, `"${f.label}" is not text.`);
      if (typeof value !== 'string' || !value.length || value.length > 200) throw bad(path, `"${f.label}" needs some text.`);
      const pat = op === 'contains' ? `%${likeEscape(value)}%` : `${likeEscape(value)}%`;
      return sql<SqlBool>`(${f.expr})::text ilike ${pat}`;
    }
    case 'is_empty':
      return TEXTUAL.has(f.type) ? sql<SqlBool>`coalesce((${f.expr})::text, '') = ''` : sql<SqlBool>`${f.expr} is null`;
    case 'not_empty':
      return TEXTUAL.has(f.type) ? sql<SqlBool>`coalesce((${f.expr})::text, '') <> ''` : sql<SqlBool>`${f.expr} is not null`;
    case 'within_location': {
      if (!f.locationPath) throw bad(path, `"${f.label}" is not a location.`);
      if (typeof value !== 'string' || !UUID.test(value)) throw bad(path, `"${f.label}" needs a location id.`);
      return sql<SqlBool>`${f.locationPath} <@ (select n.path from app.location_node n where n.id = ${value}::uuid)`;
    }
  }
}

function dateCondition(f: SourceField, r: DateRange, tz: string): Expression<SqlBool> {
  if (f.type === 'datetime') {
    return sql<SqlBool>`(${f.expr} >= (${r.from}::date)::timestamp at time zone ${tz} and ${f.expr} < ((${r.to}::date) + 1)::timestamp at time zone ${tz})`;
  }
  return sql<SqlBool>`${f.expr} between ${r.from}::date and ${r.to}::date`;
}

// ------------------------------------------------------------------ cursor

interface Cursor { v: (string | null)[]; n: number }
function encodeCursor(c: Cursor) {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
function decodeCursor(raw: string, width: number): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (!Array.isArray(c.v) || c.v.length !== width || c.v.some(x => x !== null && typeof x !== 'string') || !Number.isInteger(c.n) || c.n < 0) throw new Error('bad');
    return c;
  } catch {
    throw bad('page.cursor', 'The page cursor is invalid. Start again from the first page.');
  }
}

// ------------------------------------------------------------------ compile

export interface Compiled {
  cols: OutCol[];
  aggregateMode: boolean;
  base: { from: RawBuilder<unknown>; where: Expression<SqlBool>[] };
  sortKeys: { col: string; dir: 'asc' | 'desc'; sqlType: string }[];
  hasRowId: boolean;
  hasLink: boolean;
  groupCols: OutCol[];
  rowLimit: number;
  def: Def;
  inner: RawBuilder<unknown>;
  /** Aggregate mode with groups: the same query with `grouping sets ((groups…, _m), ())` — the extra row (NULL _m) is the grand total. */
  innerWithTotals: RawBuilder<unknown> | null;
}

/** Weighted ratio of sums for a ratio field (`SourceField.ratio`), rounded like `avg`. */
function ratioOfSums(r: NonNullable<SourceField['ratio']>): RawBuilder<unknown> {
  return sql`round((sum(${r.num}) * ${sql.lit(r.scale ?? 1)} / nullif(sum(${r.den}), 0))::numeric, 4)`;
}

/** Aggregate of a field: ratio fields average as a weighted ratio of sums; everything else as `aggExpr`. */
export function fieldAgg(f: SourceField, agg: Agg): RawBuilder<unknown> {
  if (f.ratio && agg === 'avg') return ratioOfSums(f.ratio);
  return aggExpr(agg, f.expr);
}

/** Column total of a numeric detail column (sum; a ratio field's weighted ratio). */
const detailTotal = (f: SourceField, e: RawBuilder<unknown>) => (f.ratio ? ratioOfSums(f.ratio) : sql`sum(${e})`);

function aggExpr(agg: Agg, e: RawBuilder<unknown>): RawBuilder<unknown> {
  switch (agg) {
    case 'none': return e;
    case 'sum': return sql`sum(${e})`;
    case 'avg': return sql`round(avg(${e})::numeric, 4)`;
    case 'min': return sql`min(${e})`;
    case 'max': return sql`max(${e})`;
    case 'count': return sql`count(*)`;
    case 'count_distinct': return sql`count(distinct ${e})`;
  }
}

const PRESETS = ['none', 'today', 'this_week', 'this_month', 'last_month', 'this_fy', 'last_30_days', 'last_90_days'];

/**
 * The run's date range: an explicit range (KPI previous period) wins; else `params.dateFrom` + `params.dateTo`
 * (custom period, both YYYY-MM-DD, from ≤ to); else `params.datePreset`; else the definition's preset.
 */
export function runRange(def: Pick<Def, 'datePreset'>, params: Record<string, unknown>, ctx: Pick<CompileContext, 'today' | 'fyStartMonth'>, explicit?: DateRange | null): DateRange | null {
  if (explicit !== undefined) return explicit;
  const { dateFrom, dateTo } = params;
  if (dateFrom !== undefined || dateTo !== undefined) {
    if (!isDateStr(dateFrom) || !isDateStr(dateTo)) throw bad('params.dateFrom', 'A custom period needs dateFrom and dateTo (YYYY-MM-DD).');
    if (dateFrom > dateTo) throw bad('params.dateTo', 'The period ends before it starts.');
    return { from: dateFrom, to: dateTo };
  }
  const p = params.datePreset;
  const preset = (typeof p === 'string' && PRESETS.includes(p) ? p : def.datePreset) as DatePreset;
  return presetRange(preset, ctx.today, ctx.fyStartMonth);
}

export function compile(src: ResolvedSource, def: Def, ctx: CompileContext, opts: Pick<RunOptions, 'params' | 'dateRange'> = {}): Compiled {
  const fields = viewerFields(src.fields, ctx.perms);
  const byId = new Map(fields.map(f => [f.id, f]));
  const joins = new Map<string, RawBuilder<unknown>>();
  const use = (f: SourceField) => {
    for (const j of f.joins ?? []) if (!joins.has(j.alias)) joins.set(j.alias, j.sql);
    return f;
  };
  const field = (id: string, path: string): SourceField => {
    const f = byId.get(id);
    if (!f) throw bad(path, `Unknown field "${id}" for ${src.label}.`);
    return use(f);
  };
  const params = opts.params ?? {};

  // columns
  const aggregateMode = def.columns.some(c => c.aggregate !== 'none');
  const cols: OutCol[] = [];
  const mk = (f: SourceField, agg: Agg, label: string | undefined, hidden: boolean): OutCol => {
    const type: FieldType = agg === 'count' || agg === 'count_distinct' ? 'number' : f.type;
    return { key: `c${cols.length}`, field: f, label: label ?? f.label, aggregate: agg, type, sqlType: agg === 'count' || agg === 'count_distinct' ? 'numeric' : SQL_TYPE[type], hidden, expr: fieldAgg(f, agg) };
  };
  def.columns.forEach((c, i) => {
    const f = field(c.field, `definition.columns.${i}.field`);
    const caps = capabilities(f);
    const agg = c.aggregate as Agg;
    if ((agg === 'sum' || agg === 'avg') && !caps.aggregatable) throw bad(`definition.columns.${i}.aggregate`, `"${f.label}" cannot be summed or averaged.`);
    if (agg === 'sum' && f.ratio) throw bad(`definition.columns.${i}.aggregate`, `"${f.label}" is a ratio: use the average (weighted) instead of the sum.`);
    if ((agg === 'min' || agg === 'max') && !COMPARABLE.has(f.type)) throw bad(`definition.columns.${i}.aggregate`, `"${f.label}" has no minimum or maximum.`);
    cols.push(mk(f, agg, c.label, false));
  });

  // grouping
  const groupIds = def.groupBy.map((g, i) => {
    const f = field(g, `definition.groupBy.${i}`);
    if (!capabilities(f).groupable) throw bad(`definition.groupBy.${i}`, `Cannot group by "${f.label}".`);
    return g;
  });
  if (new Set(groupIds).size !== groupIds.length) throw bad('definition.groupBy', 'A field is listed twice in the grouping.');
  if (aggregateMode) {
    cols.forEach((c, i) => {
      if (c.aggregate === 'none' && !groupIds.includes(c.field.id)) {
        throw bad(`definition.columns.${i}.aggregate`, `"${c.label}" must be grouped or summarised (sum, count …) when the report has totals per group.`);
      }
    });
    for (const g of groupIds) if (!cols.some(c => c.field.id === g && c.aggregate === 'none')) cols.unshift(mk(use(byId.get(g)!), 'none', undefined, true));
    cols.forEach((c, i) => { c.key = `c${i}`; });
  }
  const groupCols = groupIds.map(g => cols.find(c => c.field.id === g && c.aggregate === 'none')!).filter(Boolean);

  // filters
  const where: Expression<SqlBool>[] = [...src.where];
  if (src.scope && ctx.perms) where.push(scopeCondition(src.scope.path, ctx.nodeFilter(ctx.perms, src.scope.tabKey)));
  def.filters.forEach((flt, i) => {
    const path = `definition.filters.${i}`;
    const f = field(flt.field, `${path}.field`);
    if (!capabilities(f).filterable) throw bad(`${path}.field`, `Cannot filter by "${f.label}".`);
    let value = flt.value;
    if (flt.param) {
      const given = params[flt.param.key];
      if (given !== undefined && given !== null && given !== '') value = given;
    }
    const needsValue = flt.op !== 'is_empty' && flt.op !== 'not_empty';
    if (needsValue && (value === undefined || value === null || value === '')) {
      if (flt.param?.required) throw bad(`params.${flt.param.key}`, `"${flt.param.label}" is required.`);
      if (flt.param) return; // optional parameter left empty: no filter
      throw bad(`${path}.value`, `"${f.label}" needs a value.`);
    }
    where.push(filterCondition(f, flt, value, flt.param && params[flt.param.key] !== undefined ? `params.${flt.param.key}` : `${path}.value`, ctx.timezone));
  });

  // date range (see runRange); a source that consumes it (period balances) applied it in its FROM already
  const range = runRange(def, params, ctx, opts.dateRange);
  if (range && !src.consumesDateRange) {
    if (!src.dateField) throw bad('definition.datePreset', `${src.label} has no date to filter on.`);
    const df = byId.get(src.dateField);
    if (!df) throw bad('definition.datePreset', 'The date field of this source is not available to you.');
    use(df);
    where.push(dateCondition(df, range, ctx.timezone));
  }

  // sorting
  const sortSpec = def.sort.length ? def.sort : aggregateMode
    ? groupCols.map(c => ({ field: c.field.id, dir: 'asc' as const }))
    : (src.defaultSort?.filter(s => byId.has(s.field)) ?? []);
  const sortKeys: Compiled['sortKeys'] = [];
  sortSpec.forEach((s, i) => {
    const f = field(s.field, `definition.sort.${i}.field`);
    let col = cols.find(c => c.field.id === f.id && (aggregateMode ? true : c.aggregate === 'none'));
    if (!col) {
      if (aggregateMode) throw bad(`definition.sort.${i}.field`, `Sort by a column of the report ("${f.label}" is not one).`);
      col = mk(f, 'none', undefined, true);
      col.key = `c${cols.length}`;
      cols.push(col);
    }
    if (!sortKeys.some(k => k.col === col!.key)) sortKeys.push({ col: col.key, dir: s.dir, sqlType: col.sqlType });
  });
  if (!aggregateMode && groupCols.length) {
    // detail rows grouped: group fields lead the order
    const lead = groupCols.filter(g => !sortKeys.some(k => k.col === g.key)).map(g => ({ col: g.key, dir: 'asc' as const, sqlType: g.sqlType }));
    sortKeys.unshift(...lead);
  }
  if (aggregateMode) for (const g of groupCols) if (!sortKeys.some(k => k.col === g.key)) sortKeys.push({ col: g.key, dir: 'asc', sqlType: g.sqlType });

  // chart fields must be columns
  if (def.chart) {
    const isCol = (id: string) => cols.some(c => c.field.id === id && !c.hidden);
    if (!isCol(def.chart.x)) throw bad('definition.chart.x', `The chart axis "${def.chart.x}" must be a column of the report.`);
    def.chart.series.forEach((s, i) => {
      const c = cols.find(x => x.field.id === s && !x.hidden);
      if (!c) throw bad(`definition.chart.series.${i}`, `The chart series "${s}" must be a column of the report.`);
      if (c.type !== 'number' && c.type !== 'currency') throw bad(`definition.chart.series.${i}`, `The chart series "${c.label}" must be a number.`);
    });
  }

  const select = cols.map(c => sql`${c.expr} as ${sql.ref(c.key)}`);
  const hasRowId = !aggregateMode;
  const hasLink = !aggregateMode && !!src.link;
  if (hasRowId) select.push(sql`(${src.rowId})::text as _rid`);
  if (hasLink) select.push(sql`${src.link!} as _link`);
  const from = joins.size ? sql`${src.from} ${sql.join([...joins.values()], sql` `)}` : src.from;
  const cond = where.length ? sql`${sql.join(where, sql` and `)}` : sql`true`;
  const groupBy = aggregateMode && groupCols.length ? sql` group by ${sql.join(groupCols.map(g => sql.lit(cols.indexOf(g) + 1)))}` : sql``;
  const inner = sql`select ${sql.join(select)} from ${from} where ${cond}${groupBy}`;
  let innerWithTotals: RawBuilder<unknown> | null = null;
  if (aggregateMode && groupCols.length) {
    const ords = [...groupCols.map(g => cols.indexOf(g) + 1), select.length + 1].map(n => sql.lit(n));
    innerWithTotals = sql`select ${sql.join(select)}, true as _m from ${from} where ${cond} group by grouping sets ((${sql.join(ords)}), ())`;
  }
  return { cols, aggregateMode, base: { from, where }, sortKeys, hasRowId, hasLink, groupCols, rowLimit: def.rowLimit, def, inner, innerWithTotals };
}

// ------------------------------------------------------------------ execute

type Row = Record<string, unknown>;

function keysetPredicate(c: Compiled, cur: Cursor): RawBuilder<unknown> {
  const keys = [...c.sortKeys.map(k => ({ ...k, ref: sql.ref(`t.${k.col}`) })), ...(c.hasRowId ? [{ col: '_rid', dir: 'asc' as const, sqlType: 'text', ref: sql.ref('t._rid') }] : [])];
  const ors: RawBuilder<unknown>[] = [];
  keys.forEach((k, i) => {
    const v = cur.v[i] ?? null;
    if (v === null) return; // nothing sorts after NULL within this key (nulls last)
    const typed = sql`${v}::${sql.raw(k.sqlType)}`;
    const gt = k.dir === 'asc' ? sql`(${k.ref} > ${typed} or ${k.ref} is null)` : sql`(${k.ref} < ${typed} or ${k.ref} is null)`;
    const eqs = keys.slice(0, i).map((p, j) => {
      const pv = cur.v[j] ?? null;
      return pv === null ? sql`${p.ref} is null` : sql`${p.ref} = ${pv}::${sql.raw(p.sqlType)}`;
    });
    ors.push(eqs.length ? sql`(${sql.join([...eqs, gt], sql` and `)})` : gt);
  });
  return ors.length ? sql`(${sql.join(ors, sql` or `)})` : sql`false`;
}

function dateOut(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}

/** Decimal string without trailing zeros, keeping at least `minPlaces` decimals ('120000.0000' → '120000.00'). */
export function canonical(s: string, minPlaces: number): string {
  const m = /^(-?\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return s;
  let frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length < minPlaces) frac = frac.padEnd(minPlaces, '0');
  return frac ? `${m[1]}.${frac}` : m[1]!;
}

/** JSON-friendly cell value: numerics stay exact strings (counts become numbers), dates 'YYYY-MM-DD', labels applied. */
export function cell(c: Pick<OutCol, 'type' | 'aggregate' | 'field'>, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (c.aggregate === 'count' || c.aggregate === 'count_distinct') return Number(v);
  switch (c.type) {
    case 'date': return dateOut(v);
    case 'datetime': return v instanceof Date ? v.toISOString() : String(v);
    case 'boolean': return v === true || v === 't' || v === 'true';
    case 'number': return canonical(String(v), 0);
    case 'currency': return canonical(String(v), 2);
    default: {
      const s = String(v);
      return c.field.labels?.[s] ?? s;
    }
  }
}

export interface PageResult { rows: Row[]; nextCursor: string | null; truncated: boolean; served: number; totalRow?: Row }

/** One page of rows (keyset). `limit` is capped by the definition's rowLimit across pages. */
export async function fetchPage(tx: Tx, c: Compiled, cursorRaw: string | undefined, limit: number, withTotals = false): Promise<PageResult> {
  const width = c.sortKeys.length + (c.hasRowId ? 1 : 0);
  const cur = cursorRaw ? decodeCursor(cursorRaw, width) : { v: [], n: 0 };
  const remaining = c.rowLimit - cur.n;
  if (remaining <= 0) return { rows: [], nextCursor: null, truncated: true, served: cur.n };
  const take = Math.min(limit, remaining);
  const order = [
    ...c.sortKeys.map(k => sql`(${sql.ref(`t.${k.col}`)} is null), ${sql.ref(`t.${k.col}`)} ${sql.raw(k.dir)}`),
    ...(c.hasRowId ? [sql`t._rid asc`] : []),
  ];
  const keyCols = c.sortKeys.map((k, i) => sql`(${sql.ref(`t.${k.col}`)})::text as ${sql.ref(`k${i}`)}`);
  const where = cursorRaw ? keysetPredicate(c, cur) : sql`true`;
  const keySel = keyCols.length ? sql`, ${sql.join(keyCols)}` : sql``;
  const orderBy = order.length ? sql`order by ${sql.join(order)}` : sql``;
  const totalsInline = withTotals && !cursorRaw && !!c.innerWithTotals;
  const q = totalsInline
    // one pass: the page of groups plus the grand-total row of the same grouping sets
    ? sql<Row>`with g as (${c.innerWithTotals!})
      (select t.*${keySel}, false as _tot from g t where t._m is not null ${orderBy} limit ${take + 1})
      union all
      (select t.*${c.sortKeys.length ? sql`, ${sql.join(c.sortKeys.map((_, i) => sql`null::text as ${sql.ref(`k${i}`)}`))}` : sql``}, true as _tot from g t where t._m is null)`
    : sql<Row>`select t.*${keySel} from (${c.inner}) t where ${where} ${orderBy} limit ${take + 1}`;
  let res: Awaited<ReturnType<typeof q.execute>>;
  try {
    res = await q.execute(tx);
  } catch (e) {
    // QA47-BUG-011: a tampered cursor value that does not cast to the sort column's type (class 22 data exception)
    // is the client's fault → 400 instead of a 500.
    if (cursorRaw && /^22/.test(String((e as { code?: string }).code ?? ''))) throw bad('page.cursor', 'The page cursor is invalid. Start again from the first page.');
    throw e;
  }
  const totalRow = totalsInline ? res.rows.find(r => r._tot === true) : undefined;
  const fetched = totalsInline ? res.rows.filter(r => r._tot !== true) : res.rows;
  const more = fetched.length > take;
  const rows = more ? fetched.slice(0, take) : fetched;
  const served = cur.n + rows.length;
  const last = rows[rows.length - 1];
  let nextCursor: string | null = null;
  let truncated = false;
  if (more && last) {
    if (served >= c.rowLimit) truncated = true;
    else {
      const v = c.sortKeys.map((_, i) => (last[`k${i}`] ?? null) as string | null);
      if (c.hasRowId) v.push(String(last._rid));
      nextCursor = encodeCursor({ v, n: served });
    }
  }
  return { rows, nextCursor, truncated, served, totalRow };
}

export async function totals(tx: Tx, c: Compiled): Promise<unknown[]> {
  const parts = c.cols.filter(x => !x.hidden).map(x => {
    if (c.aggregateMode) return x.aggregate === 'none' ? sql`null` : fieldAgg(x.field, x.aggregate);
    return x.type === 'number' || x.type === 'currency' ? detailTotal(x.field, x.expr) : sql`null`;
  });
  const cond = c.base.where.length ? sql.join(c.base.where, sql` and `) : sql`true`;
  const r = await sql<Row>`select ${sql.join(parts.map((p, i) => sql`${p} as ${sql.ref(`t${i}`)}`))} from ${c.base.from} where ${cond}`.execute(tx);
  const row = r.rows[0] ?? {};
  return c.cols.filter(x => !x.hidden).map((x, i) => {
    const v = row[`t${i}`];
    if (v === null || v === undefined) return null;
    return cell(c.aggregateMode ? x : { ...x, aggregate: 'none' }, v);
  });
}

export async function groups(tx: Tx, c: Compiled): Promise<NonNullable<ReportResult['groups']>> {
  if (c.aggregateMode || !c.groupCols.length) return [];
  const visible = c.cols.filter(x => !x.hidden);
  const sums = visible.map(x => (x.type === 'number' || x.type === 'currency' ? detailTotal(x.field, x.expr) : sql`null`));
  const cond = c.base.where.length ? sql.join(c.base.where, sql` and `) : sql`true`;
  const g = c.groupCols.map((x, i) => sql`${x.expr} as ${sql.ref(`g${i}`)}`);
  const r = await sql<Row>`select ${sql.join(g)}, count(*) as n, ${sql.join(sums.map((s, i) => sql`${s} as ${sql.ref(`s${i}`)}`))}
    from ${c.base.from} where ${cond} group by ${sql.join(c.groupCols.map((_, i) => sql.lit(i + 1)))}
    order by ${sql.join(c.groupCols.map((_, i) => sql`${sql.lit(i + 1)} nulls last`))} limit 1000`.execute(tx);
  return r.rows.map(row => ({
    key: c.groupCols.map((x, i) => cell(x, row[`g${i}`])),
    rowCount: Number(row.n),
    totals: visible.map((x, i) => (row[`s${i}`] === null || row[`s${i}`] === undefined ? null : cell({ ...x, aggregate: 'none' }, row[`s${i}`]))),
  }));
}

export function shapeRows(c: Compiled, rows: Row[]): unknown[][] {
  const visible = c.cols.filter(x => !x.hidden);
  return rows.map(r => visible.map(x => cell(x, r[x.key])));
}

export function chartOf(c: Compiled, rows: unknown[][]): ReportResult['chart'] | undefined {
  const ch = c.def.chart;
  if (!ch) return undefined;
  const visible = c.cols.filter(x => !x.hidden);
  const xi = visible.findIndex(x => x.field.id === ch.x);
  const si = ch.series.map(s => visible.findIndex(x => x.field.id === s));
  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  // Grouped by a second field (e.g. month × location): one series per value of that field, x = distinct axis values.
  const split = c.aggregateMode ? c.groupCols.find(g => g.field.id !== ch.x && !g.hidden) : undefined;
  const ki = split ? visible.indexOf(split) : -1;
  if (ki >= 0) {
    const label = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
    const xs = [...new Map(rows.map(r => [label(r[xi]), r[xi]])).values()];
    const keys = [...new Set(rows.map(r => label(r[ki])))];
    const at = new Map(rows.map(r => [`${label(r[xi])}\u0000${label(r[ki])}`, r]));
    return {
      x: xs,
      series: keys.flatMap(k => si.map(i => ({
        name: si.length > 1 ? `${k} · ${visible[i]!.label}` : k,
        values: xs.map(x => num(at.get(`${label(x)}\u0000${k}`)?.[i])),
      }))),
    };
  }
  return { x: rows.map(r => r[xi]), series: si.map(i => ({ name: visible[i]!.label, values: rows.map(r => num(r[i])) })) };
}

export function resultColumns(c: Compiled): ReportResult['columns'] {
  return c.cols.filter(x => !x.hidden).map(x => ({ field: x.field.id, label: x.label, type: x.type, aggregate: x.aggregate }));
}

/** Runs a compiled report: one page + (first page) totals, groups and chart. */
/** Per-transaction limits for report statements: 15 s timeout, enough sort memory for grouped reports. */
export async function limits(tx: Tx, analytic = false) {
  await sql`set local statement_timeout = '15s'`.execute(tx);
  await sql`set local work_mem = '64MB'`.execute(tx);
  // RLS predicates hide the tenant's row count from the planner (estimates collapse to a few rows), which makes it
  // pick nested loops over whole tables; full-scan statements (grouping, totals) are far faster as hash joins.
  // Re-measured after 0014 (parallel-safe RLS function): still ~2x faster with nested loops off.
  if (analytic) await sql`set local enable_nestloop = off`.execute(tx);
}

export async function execute(tx: Tx, c: Compiled, opts: RunOptions): Promise<ReportResult> {
  const first = !opts.cursor && !opts.rowsOnly;
  await limits(tx, c.aggregateMode);
  const inlineTotals = first && c.def.totals && !!c.innerWithTotals;
  const page = await fetchPage(tx, c, opts.cursor, opts.limit, inlineTotals);
  const rows = shapeRows(c, page.rows);
  if (first && !c.aggregateMode) await limits(tx, true); // totals / groups scan everything
  let totalsRow: unknown[] | null = null;
  if (first && c.def.totals) {
    if (inlineTotals) {
      const t = page.totalRow ?? {};
      totalsRow = c.cols.filter(x => !x.hidden).map(x => (x.aggregate === 'none' ? null : cell(x, t[x.key] ?? (x.aggregate.startsWith('count') ? 0 : null))));
    } else totalsRow = await totals(tx, c);
  }
  const result: ReportResult = { columns: resultColumns(c), rows, totals: totalsRow, nextCursor: page.nextCursor, truncated: page.truncated };
  if (first && !c.aggregateMode && c.groupCols.length) result.groups = await groups(tx, c);
  if (!opts.rowsOnly && c.def.chart) result.chart = chartOf(c, rows);
  if (c.hasLink) result.links = page.rows.map(r => (r._link === null || r._link === undefined ? null : String(r._link)));
  return result;
}

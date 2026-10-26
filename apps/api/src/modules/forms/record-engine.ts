import { Injectable } from '@nestjs/common';
import { DataField, ErrorCode, FileMeta, FormDefinition, MyPermissions } from '@procure/schema';
import { sql } from 'kysely';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { acceptMatches, FileRow, FilesService } from '../files';
import { dataFields, isEmpty, isFileField, isGrid, isLookup, jsonEqual, LookupLike, ValueField } from './definition';
import { evaluateExpr, evaluateForm } from './formula.adapter';
import { defaultValue, isUuidString, validateValue, ValueIssue } from './validators';

export type RefKind = 'master_record' | 'tenant_user' | 'location_node';
type Access = Record<string, 'hidden' | 'readonly'>;

/** A record referenced by a lookup value. `attrs` = code, name and data (masters) or the user/location columns. */
export interface TargetRecord {
  id: string;
  kind: RefKind;
  masterKey: string | null;
  active: boolean;
  deleted: boolean;
  code: string;
  name: string;
  attrs: Record<string, unknown>;
}

export interface PrepareInput {
  def: FormDefinition;
  formKey: string;
  /** Stored data before this save ({} on create). */
  prev: Record<string, unknown>;
  incoming: Record<string, unknown>;
  isCreate: boolean;
  /** Owner of the data, for "file already attached elsewhere" checks. */
  owner: { kind: string; id: string | null };
  /** Restrict to these fields (user form: custom fields only). */
  include?: (f: DataField) => boolean;
  /** Values visible to formulas but not stored in `data` (user form system fields, master code/name). */
  extraValues?: Record<string, unknown>;
  today: string;
  /** Field access of the caller for this form; null = engine (no restrictions). */
  perms: MyPermissions | null;
}

export interface PreparedData {
  data: Record<string, unknown>;
  /** Lookup references to write to app.record_ref (field = '<grid>.<col>' for grid cells). */
  refs: { field: string; kind: RefKind; id: string }[];
  /** Files to attach: field -> ids. */
  files: Map<string, string[]>;
  targets: Map<string, TargetRecord>;
}

export const kindOfSource = (f: LookupLike): RefKind =>
  f.source.kind === 'master' ? 'master_record' : f.source.kind === 'user' ? 'tenant_user' : 'location_node';

export const fieldReadOnly = (field: string) =>
  new AppError(403, 'FIELD_READ_ONLY', `You are not allowed to change "${field}".`, { field });

export const validationFailed = (errors: ValueIssue[]) =>
  new AppError(400, ErrorCode.VALIDATION, 'Some fields are invalid', undefined, errors);

/**
 * The record save pipeline shared by master records, the user form (custom fields) and later documents:
 * strip unknown keys → field access → per-type validation → lookups (exists, active, same tenant, filterBy) →
 * files (owned, clean, accept/size) → formulas (server-side) → requiredWhen/visibleWhen → form validations.
 * Throws 400 with every problem at once, or 403 FIELD_READ_ONLY. Unique checks and writes are the caller's.
 */
@Injectable()
export class RecordEngine {
  constructor(private readonly files: FilesService) {}

  async prepare(tx: Tx, tenantId: string, input: PrepareInput): Promise<PreparedData> {
    const { def, prev, incoming, isCreate, today } = input;
    const access: Access = input.perms?.fieldAccess?.[input.formKey] ?? {};
    const include = input.include ?? (() => true);
    const errors: ValueIssue[] = [];
    const data: Record<string, unknown> = {};
    const all = dataFields(def, true).filter(include);
    const known = new Map(all.map(f => [f.key, f]));
    // Data of removed fields and of keys this version does not know is kept as stored.
    for (const [k, v] of Object.entries(prev)) {
      const f = known.get(k);
      if (!f || f.removed) data[k] = v;
    }
    const evalDate = (expr: string) => {
      const r = evaluateExpr(expr, { values: { ...incoming, ...input.extraValues }, today });
      return typeof r?.value === 'string' ? r.value : null;
    };
    const live = all.filter(f => !f.removed);

    // ---- per-field: access, defaults, type validation
    for (const f of live) {
      if (f.type === 'formula') continue;
      const has = Object.prototype.hasOwnProperty.call(incoming, f.key);
      const before = isCreate ? defaultValue(f, today) : prev[f.key];
      const mode = access[f.key];
      if (mode) {
        if (has) {
          const r = validateValue(f, incoming[f.key], f.key, { previous: prev[f.key], evalDate });
          if (r.errors.length || !jsonEqual(r.value, before)) throw fieldReadOnly(f.key);
        }
        if (before !== undefined && before !== null) data[f.key] = before;
        continue;
      }
      const raw = has ? incoming[f.key] : before;
      const r = validateValue(f, raw, f.key, { previous: prev[f.key], evalDate });
      errors.push(...r.errors);
      if (r.value !== undefined) data[f.key] = r.value;
      if (isGrid(f) && has) this.enforceColumnAccess(f, access, incoming[f.key], prev[f.key], data);
    }

    // ---- references: lookups and files (header + grid cells)
    const lookups: { f: LookupLike; path: string; refField: string; ids: string[]; changed: boolean; row?: Record<string, unknown>; prevRow?: Record<string, unknown> }[] = [];
    const fileUses: { f: Extract<ValueField, { type: 'file' | 'image' | 'files' | 'signature' }>; path: string; refField: string; ids: string[]; changed: boolean }[] = [];
    const ids = (v: unknown) => (Array.isArray(v) ? (v as string[]) : isUuidString(v) ? [v] : []);
    for (const f of all) {
      if (isLookup(f)) {
        lookups.push({ f, path: f.key, refField: f.key, ids: ids(data[f.key]), changed: !f.removed && !jsonEqual(data[f.key], prev[f.key]) });
      } else if (isFileField(f)) {
        fileUses.push({ f, path: f.key, refField: f.key, ids: ids(data[f.key]), changed: !f.removed && !jsonEqual(data[f.key], prev[f.key]) });
      } else if (isGrid(f) && Array.isArray(data[f.key])) {
        const prevRows = new Map((Array.isArray(prev[f.key]) ? prev[f.key] as Record<string, unknown>[] : []).map(r => [r._row, r]));
        (data[f.key] as Record<string, unknown>[]).forEach((row, i) => {
          const pr = prevRows.get(row._row);
          for (const c of f.columns) {
            const changed = !f.removed && !c.removed && !jsonEqual(row[c.key], pr?.[c.key]);
            const entry = { path: `${f.key}.${i}.${c.key}`, refField: `${f.key}.${c.key}`, ids: ids(row[c.key]), changed };
            if (isLookup(c)) lookups.push({ f: c, ...entry, row, prevRow: pr });
            else if (isFileField(c)) fileUses.push({ f: c, ...entry });
          }
        });
      }
    }

    const targets = await this.loadTargets(tx, tenantId, lookups.flatMap(l => l.ids.map(id => ({ id, kind: kindOfSource(l.f) }))), true);
    const scope = input.perms?.scope;
    for (const l of lookups) {
      for (const id of l.ids) {
        const t = targets.get(id);
        const wantKey = l.f.source.kind === 'master' ? l.f.source.masterKey : null;
        if (!t || t.deleted || t.kind !== kindOfSource(l.f) || (wantKey && t.masterKey !== wantKey)) {
          errors.push({ path: l.path, message: `${l.f.label}: the selected record does not exist.` });
          continue;
        }
        if (!l.changed) continue;
        if (!t.active) {
          // An unchanged reference may stay pointed at a record that was deactivated since.
          const wasThere = ids(l.prevRow ? l.prevRow[l.f.key] : prev[l.f.key]).includes(id);
          if (!wasThere) errors.push({ path: l.path, message: `${l.f.label}: "${t.name}" is inactive.` });
        }
        if (l.f.source.kind === 'location' && l.f.source.withinScope && scope && !scope.allNodes && !scope.nodeIds.includes(id)) {
          errors.push({ path: l.path, message: `${l.f.label}: "${t.name}" is outside your locations.` });
        }
      }
      // Cascading filters: the chosen record must belong to the parent value chosen on this form.
      if (l.ids.length && l.f.filterBy.length) {
        for (const flt of l.f.filterBy) {
          // Sibling column in the same grid row first, then the header (keys are unique across the form).
          const parent = l.row && Object.prototype.hasOwnProperty.call(l.row, flt.field)
            ? l.row[flt.field]
            : data[flt.field] ?? input.extraValues?.[flt.field];
          for (const id of l.ids) {
            const t = targets.get(id);
            if (!t) continue;
            if (isEmpty(parent)) {
              errors.push({ path: l.path, message: `${l.f.label}: choose ${labelOf(all, flt.field)} first.` });
              continue;
            }
            const attr = t.attrs[flt.targetField];
            const parents = Array.isArray(parent) ? (parent as unknown[]).map(String) : [String(parent)];
            const ok = Array.isArray(attr) ? (attr as unknown[]).some(a => parents.includes(String(a))) : attr !== undefined && attr !== null && parents.includes(String(attr));
            if (!ok) errors.push({ path: l.path, message: `${l.f.label}: "${t.name}" does not belong to the chosen ${labelOf(all, flt.field)}.` });
          }
        }
      }
    }

    const fileRows = new Map((await this.files.loadMany(tx, tenantId, fileUses.flatMap(u => u.ids))).map(r => [r.id, r]));
    for (const u of fileUses) {
      for (const id of u.ids) {
        const fr = fileRows.get(id);
        if (!fr) {
          errors.push({ path: u.path, message: `${u.f.label}: the file was not found.` });
          continue;
        }
        if (!u.changed) continue;
        const msg = fileProblem(fr, u.f, input.owner);
        if (msg) errors.push({ path: u.path, message: `${u.f.label}: ${msg}` });
      }
    }

    // ---- formulas, conditional state, form validations
    const lookupAttrs: Record<string, Record<string, unknown> | null> = {};
    const rowLookups: Record<string, Record<string, Record<string, Record<string, unknown> | null>>> = {};
    for (const l of lookups) {
      if (l.f.type !== 'lookup') continue;
      const t = l.ids[0] ? targets.get(l.ids[0]) : undefined;
      const attrs = t ? { ...t.attrs } : null;
      if (l.row) {
        const grid = l.refField.split('.')[0]!;
        const rowId = String(l.row._row);
        ((rowLookups[grid] ??= {})[rowId] ??= {})[l.f.key] = attrs;
      } else lookupAttrs[l.f.key] = attrs;
    }
    const values = { ...input.extraValues, ...data };
    const evaluated = evaluateForm(def, { values, lookups: lookupAttrs, rowLookups, today, defaultPrecision: 2 });
    for (const f of live) {
      if (f.type === 'formula') {
        const v = evaluated.values[f.key];
        if (v === null || v === undefined) delete data[f.key];
        else data[f.key] = v;
      } else if (isGrid(f) && Array.isArray(data[f.key])) {
        const computed = evaluated.values[f.key];
        const formulaCols = f.columns.filter(c => c.type === 'formula' && !c.removed);
        if (formulaCols.length) {
          (data[f.key] as Record<string, unknown>[]).forEach((row, i) => {
            const crow = Array.isArray(computed) ? (computed[i] as Record<string, unknown> | undefined) : undefined;
            for (const c of formulaCols) {
              const v = crow?.[c.key];
              if (v === null || v === undefined) delete row[c.key];
              else row[c.key] = v;
            }
          });
        }
      }
    }
    // A value that already failed validation is not also reported as missing.
    const failed = new Set(errors.map(e => e.path));
    for (const f of live) {
      if (f.type === 'formula' || access[f.key]) continue;
      const st = evaluated.state[f.key];
      const visible = st ? st.visible : !f.hidden;
      const required = (st?.required ?? false) || f.required;
      if (visible && required && isEmpty(data[f.key]) && !failed.has(f.key)) errors.push({ path: f.key, message: `${f.label} is required.` });
      if (isGrid(f) && visible && Array.isArray(data[f.key])) {
        (data[f.key] as Record<string, unknown>[]).forEach((row, i) => {
          for (const c of f.columns) {
            if (c.removed || c.type === 'formula' || access[`${f.key}.${c.key}`]) continue;
            const cs = evaluated.state[`${f.key}.${c.key}`];
            if ((cs ? cs.visible : !c.hidden) && ((cs?.required ?? false) || c.required) && isEmpty(row[c.key]) && !failed.has(`${f.key}.${i}.${c.key}`)) {
              errors.push({ path: `${f.key}.${i}.${c.key}`, message: `${c.label} is required.` });
            }
          }
        });
      }
    }
    const formValidations = (evaluated as { validations?: { key: string; message: string; ok: boolean }[] }).validations;
    if (!errors.length && formValidations) {
      for (const v of formValidations) if (!v.ok) errors.push({ path: v.key, message: v.message });
    } else if (!errors.length) {
      const finalValues = { ...input.extraValues, ...data };
      for (const v of def.validations) {
        const r = evaluateExpr(v.expr, { values: finalValues, lookups: lookupAttrs, today, defaultPrecision: 2 });
        if (r && !r.error && r.value === false) errors.push({ path: v.key, message: v.message });
      }
    }
    if (errors.length) throw validationFailed(errors);

    const refs: PreparedData['refs'] = [];
    for (const l of lookups) for (const id of l.ids) refs.push({ field: l.refField, kind: kindOfSource(l.f), id });
    const files = new Map<string, string[]>();
    for (const u of fileUses) if (u.ids.length) files.set(u.refField, [...(files.get(u.refField) ?? []), ...u.ids]);
    return { data, refs: dedupeRefs(refs), files, targets };
  }

  /** Grid columns hidden/read-only for the caller keep their stored cell values; changing one is a 403. */
  private enforceColumnAccess(grid: Extract<DataField, { type: 'grid' }>, access: Access, incomingRows: unknown, prevRows: unknown, data: Record<string, unknown>) {
    const protectedCols = grid.columns.filter(c => access[`${grid.key}.${c.key}`]);
    if (!protectedCols.length || !Array.isArray(data[grid.key])) return;
    const inRows = Array.isArray(incomingRows) ? incomingRows as Record<string, unknown>[] : [];
    const prev = new Map((Array.isArray(prevRows) ? prevRows as Record<string, unknown>[] : []).map(r => [r._row, r]));
    (data[grid.key] as Record<string, unknown>[]).forEach((row, i) => {
      const pr = prev.get(row._row);
      const sent = inRows[i] ?? {};
      for (const c of protectedCols) {
        const old = pr?.[c.key];
        if (Object.prototype.hasOwnProperty.call(sent, c.key) && !jsonEqual(row[c.key], old)) throw fieldReadOnly(`${grid.key}.${c.key}`);
        if (old === undefined) delete row[c.key];
        else row[c.key] = old;
      }
    });
  }

  /** Lookup targets by kind in one query per kind (explicit tenant filter). */
  async loadTargets(tx: Tx, tenantId: string, wanted: { id: string; kind: RefKind }[], lock = false): Promise<Map<string, TargetRecord>> {
    const out = new Map<string, TargetRecord>();
    const by = (k: RefKind) => [...new Set(wanted.filter(w => w.kind === k && isUuidString(w.id)).map(w => w.id))];
    const m = by('master_record');
    if (m.length && lock) {
      // QA2-BUG-006: a save holds FOR SHARE on every referenced record (in id order, so concurrent saves cannot
      // deadlock) until it commits its record_ref rows; a delete takes FOR UPDATE on its record before reading
      // record_ref. Whichever comes second sees the other's committed result (deleted target / new reference).
      await tx.selectFrom('app.master_record').select('id').where('tenant_id', '=', tenantId).where('id', 'in', m)
        .orderBy('id').forShare().execute();
    }
    if (m.length) {
      const rows = await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id')
        .select(['r.id', 'd.key', 'r.code', 'r.name', 'r.is_active', 'r.is_deleted', 'r.data'])
        .where('r.tenant_id', '=', tenantId).where('r.id', 'in', m).execute();
      for (const r of rows) {
        out.set(r.id, {
          id: r.id, kind: 'master_record', masterKey: r.key, active: r.is_active, deleted: r.is_deleted, code: r.code, name: r.name,
          attrs: { ...(r.data as Record<string, unknown>), code: r.code, name: r.name },
        });
      }
    }
    const u = by('tenant_user');
    if (u.length) {
      const rows = await tx.selectFrom('app.tenant_user').select(['id', 'name', 'email', 'phone', 'is_active', 'is_deleted'])
        .where('tenant_id', '=', tenantId).where('id', 'in', u).execute();
      for (const r of rows) {
        out.set(r.id, {
          id: r.id, kind: 'tenant_user', masterKey: null, active: r.is_active, deleted: r.is_deleted, code: r.email, name: r.name,
          attrs: { name: r.name, email: r.email, phone: r.phone },
        });
      }
    }
    const l = by('location_node');
    if (l.length) {
      const rows = await tx.selectFrom('app.location_node').select(['id', 'code', 'name', 'is_active'])
        .where('tenant_id', '=', tenantId).where('id', 'in', l).execute();
      for (const r of rows) {
        out.set(r.id, { id: r.id, kind: 'location_node', masterKey: null, active: r.is_active, deleted: false, code: r.code, name: r.name, attrs: { code: r.code, name: r.name } });
      }
    }
    return out;
  }

  /** Replaces the reference index rows of one source record. */
  async writeRefs(tx: Tx, tenantId: string, from: { kind: string; id: string }, refs: PreparedData['refs']) {
    await tx.deleteFrom('app.record_ref').where('tenant_id', '=', tenantId).where('from_kind', '=', from.kind).where('from_id', '=', from.id).execute();
    if (refs.length) {
      await tx.insertInto('app.record_ref').values(refs.map(r => ({
        tenant_id: tenantId, from_kind: from.kind, from_id: from.id, from_field: r.field, to_kind: r.kind, to_id: r.id,
      }))).onConflict(oc => oc.doNothing()).execute();
    }
  }

  // ------------------------------------------------------------------ output
  /**
   * Response decoration for many records at once: lookup labels (`refs`) and file metadata (`files`) in a fixed
   * number of queries, and hidden fields removed per the caller's field access.
   */
  async decorate(
    tx: Tx, tenantId: string, perms: MyPermissions | null, formKey: string, items: { data: Record<string, unknown>; def: FormDefinition }[],
  ): Promise<{ data: Record<string, unknown>; refs: Record<string, Record<string, string>>; files: Record<string, FileMeta> }[]> {
    const access: Access = perms?.fieldAccess?.[formKey] ?? {};
    const want: { id: string; kind: RefKind }[] = [];
    const fileIds: string[] = [];
    const plans = items.map(({ data, def }) => {
      const out = structuredClone(data);
      const lookupCells: { refKey: string; f: LookupLike; ids: string[] }[] = [];
      const fileCells: string[] = [];
      for (const f of dataFields(def, true)) {
        if (access[f.key] === 'hidden') {
          delete out[f.key];
          continue;
        }
        const v = out[f.key];
        if (isLookup(f)) lookupCells.push({ refKey: f.key, f, ids: toIds(v) });
        else if (isFileField(f)) fileCells.push(...toIds(v));
        else if (isGrid(f) && Array.isArray(v)) {
          for (const row of v as Record<string, unknown>[]) {
            for (const c of f.columns) {
              if (access[`${f.key}.${c.key}`] === 'hidden') {
                delete row[c.key];
                continue;
              }
              if (isLookup(c)) lookupCells.push({ refKey: `${f.key}.${c.key}`, f: c, ids: toIds(row[c.key]) });
              else if (isFileField(c)) fileCells.push(...toIds(row[c.key]));
            }
          }
        }
      }
      for (const c of lookupCells) for (const id of c.ids) want.push({ id, kind: kindOfSource(c.f) });
      fileIds.push(...fileCells);
      return { out, lookupCells, fileCells };
    });
    const targets = await this.loadTargets(tx, tenantId, want);
    const meta = await this.files.metaMap(tx, tenantId, fileIds);
    return plans.map(p => {
      const refs: Record<string, Record<string, string>> = {};
      for (const c of p.lookupCells) {
        for (const id of c.ids) {
          const t = targets.get(id);
          if (t) (refs[c.refKey] ??= {})[id] = labelFor(t, c.f.display);
        }
      }
      const files: Record<string, FileMeta> = {};
      for (const id of p.fileCells) {
        const m = meta.get(id);
        if (m) files[id] = m;
      }
      return { data: p.out, refs, files };
    });
  }
}

// ------------------------------------------------------------------ helpers

const toIds = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).filter(isUuidString) : isUuidString(v) ? [v] : []);

function dedupeRefs(refs: PreparedData['refs']) {
  const seen = new Set<string>();
  return refs.filter(r => {
    const k = `${r.field}|${r.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function labelOf(fields: DataField[], key: string): string {
  return fields.find(f => f.key === key)?.label ?? key;
}

/** Display text of a lookup target from the field's `display` list (default code + name). */
export function labelFor(t: TargetRecord, display: string[] = ['code', 'name']): string {
  if (t.kind !== 'master_record') return t.kind === 'location_node' ? `${t.code} - ${t.name}` : t.name;
  const parts = display.map(k => t.attrs[k]).filter(v => v !== undefined && v !== null && v !== '').map(v => (Array.isArray(v) ? v.join(', ') : String(v)));
  return parts.length ? parts.join(' - ') : t.name;
}

function fileProblem(fr: FileRow, f: { type: string; accept?: string[]; maxSizeMb?: number }, owner: { kind: string; id: string | null }): string | null {
  if (fr.scan_status === 'pending') return `"${fr.filename}" is still being scanned. Try again in a moment.`;
  if (fr.scan_status !== 'clean') return `"${fr.filename}" failed the virus scan and cannot be used.`;
  const accept = f.accept ?? [];
  if (!acceptMatches(accept, fr.mime, fr.filename)) return `"${fr.filename}" is not an accepted file type (${accept.join(', ')}).`;
  if (f.type === 'image' && !fr.mime.startsWith('image/')) return `"${fr.filename}" is not an image.`;
  const max = (f.maxSizeMb ?? 10) * 1024 * 1024;
  if (Number(fr.size_bytes) > max) return `"${fr.filename}" is larger than ${f.maxSizeMb ?? 10} MB.`;
  const at = fr.attached_to;
  if (at && !(at.kind === owner.kind && owner.id && at.id === owner.id)) return `"${fr.filename}" is already attached to another record.`;
  return null;
}

/** Unique-field check helper: case-insensitive for text values. Caller holds the advisory lock. */
export const uniqueLockKey = (masterId: string, field: string) => sql`select pg_advisory_xact_lock(hashtextextended(${`uniq:${masterId}:${field}`}, 0))`;

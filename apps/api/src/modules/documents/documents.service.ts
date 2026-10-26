import { Injectable } from '@nestjs/common';
import {
  CancelInput, CloseInput, DataField, DocumentLineRow, DocumentRow, DocumentUpdate, DocumentWrite, ErrorCode, FormDefinition, MyPermissions,
} from '@procure/schema';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getTenantSetting } from '../identity';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import type { LedgerEvent } from '../../core/ports';
import { FilesService } from '../files';
import {
  evaluateExpr, isEmpty, isFileField, isGrid, isLookup, PreparedData, RecordEngine, tenantToday, validationFailed,
} from '../forms';
import { NumberingService } from './numbering.service';
import { emptyBuckets, fromUnits, pendingOrder, toQuantityBuckets, toUnits } from './qty';
import { statusLabel } from './status';
import { DocRow, DocStore, FormBundle, LineRow } from './store';
import { fitsUom, uomMessage, uomRules } from './uom';
import { DOCUMENT_ENTITY, docAction, DocActor, DocTypeRow, docView, has, need, settingsOf } from './types';

type Write = z.infer<typeof DocumentWrite>;
type Mode = 'draft' | 'submit' | 'edit';
type Issue = { path: string; message: string };

const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);

/**
 * Documents (contract "Documents"): CRUD, submit, cancel, close, copy and the DocumentRow shape. Every mutation runs
 * in the caller's transaction with its audit row and outbox events.
 */
@Injectable()
export class DocumentsService {
  constructor(
    readonly store: DocStore,
    private readonly engine: RecordEngine,
    private readonly files: FilesService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
  ) {}

  get types() {
    return this.store.types;
  }

  // ------------------------------------------------------------------ access
  /** Type by key; unknown types are 404 and the caller must hold `doc.<key>:action.view`. */
  async typeFor(tx: Tx, actor: DocActor, key: string): Promise<DocTypeRow> {
    const t = await this.types.find(tx, actor.tenantId, key);
    if (!t || !has(actor, docAction(key, 'view'))) throw AppError.notFound('Document type');
    return t;
  }

  /** A document the caller may see: same type, in data scope, and its status view held (else 404).
   *  Creators always have access to their own documents regardless of status view permission. */
  async access(tx: Tx, actor: DocActor, type: DocTypeRow, id: string, lock = false): Promise<DocRow> {
    const doc = await this.store.loadDoc(tx, actor.tenantId, id, { lock, typeId: type.id });
    const isCreator = !!actor.userId && doc.created_by === actor.userId;
    const statusView = isCreator || doc.status_key === 'submitted' || has(actor, docView(type.key, doc.status_key));
    if (!this.store.inScope(actor, type.key, doc.loc_path) || !statusView) throw AppError.notFound('Document');
    return doc;
  }

  // ------------------------------------------------------------------ pipeline
  /** The composed form with system-field `required` relaxed (drafts): only the location is needed to save. */
  private relaxed(def: FormDefinition): FormDefinition {
    const out = structuredClone(def);
    for (const f of out.fields) {
      const df = f as DataField;
      if (df.system && f.key !== 'location' && 'required' in df) df.required = false;
      if (isGrid(f)) for (const c of f.columns) if (c.system) c.required = false;
    }
    return out;
  }

  /** Server-side autofill (`overwrite: if_empty` semantics): fills empty targets from the chosen lookup record. */
  private async autofill(tx: Tx, actor: DocActor, b: FormBundle, header: Record<string, unknown>, rows: Record<string, unknown>[]) {
    const perms = this.store.enginePerms(actor, b);
    const access = perms?.fieldAccess[b.engineKey] ?? {};
    const plans: { values: Record<string, unknown>; f: DataField; prefix: string }[] = [];
    for (const f of b.headerFields.values()) if (isLookup(f) && !f.removed && f.autofill.length) plans.push({ values: header, f, prefix: '' });
    for (const f of b.lineFields.values()) if (isLookup(f) && !f.removed && f.autofill.length) for (const r of rows) plans.push({ values: r, f, prefix: 'lines.' });
    const ids = plans.map(p => p.values[p.f.key]).filter((v): v is string => typeof v === 'string');
    if (!ids.length) return;
    const kind = (f: DataField) => (isLookup(f) && f.source.kind === 'master' ? 'master_record' : isLookup(f) && f.source.kind === 'user' ? 'tenant_user' : 'location_node');
    const targets = await this.engine.loadTargets(tx, actor.tenantId, plans.filter(p => typeof p.values[p.f.key] === 'string').map(p => ({ id: p.values[p.f.key] as string, kind: kind(p.f) })));
    for (const p of plans) {
      const t = targets.get(p.values[p.f.key] as string);
      if (!t || !isLookup(p.f)) continue;
      for (const a of p.f.autofill) {
        if (access[`${p.prefix}${a.to}`]) continue;
        const v = t.attrs[a.from];
        if (v === undefined || v === null) continue;
        if (a.overwrite === 'always' ? false : !isEmpty(p.values[a.to])) continue;
        if (isEmpty(p.values[a.to])) p.values[a.to] = v;
      }
    }
  }

  /** Validates header + lines through the shared record pipeline (field access, lookups, files, formulas, rules). */
  private async prepare(
    tx: Tx, actor: DocActor, b: FormBundle, doc: DocRow | null, prevLines: LineRow[], input: Write, mode: Mode,
  ): Promise<PreparedData & { rows: Record<string, unknown>[] }> {
    const prevRows: Record<string, unknown>[] = prevLines.map(l => ({ _row: l.id, ...this.store.lineValues(l, b) }));
    const prev: Record<string, unknown> = { ...(doc ? this.store.headerValues(doc, b) : {}), ...(b.line ? { lines: prevRows } : {}) };
    const incoming: Record<string, unknown> = { ...input.values };
    delete incoming.lines;
    const prevIds = new Set(prevLines.map(l => l.id));
    const extras = new Map<string, Record<string, unknown>>();
    let rows: Record<string, unknown>[] = [];
    if (b.line) {
      const seen = new Set<string>();
      rows = input.lines.map((l, i) => {
        if (l.id && (!prevIds.has(l.id) || seen.has(l.id))) throw bad(`lines.${i}.id`, 'This line does not belong to the document.');
        if (l.id) seen.add(l.id);
        const values = { ...l.values };
        delete values._row;
        return { ...values, _row: l.id ?? randomUUID() };
      });
      if (mode === 'edit') {
        // After submit lines cannot be added or removed and quantities change only through the ledger.
        if (rows.some(r => !prevIds.has(r._row as string))) throw AppError.conflict('Lines cannot be added after the document was submitted.');
        const given = new Set(rows.map(r => r._row));
        rows = [...rows, ...prevRows.filter(r => !given.has(r._row)).map(r => ({ ...r }))];
        rows.sort((x, y) => prevRows.findIndex(r => r._row === x._row) - prevRows.findIndex(r => r._row === y._row));
        for (const r of rows) {
          const p = prevRows.find(x => x._row === r._row)!;
          if (Object.prototype.hasOwnProperty.call(r, 'qty') && String(toUnits(String(r.qty ?? '0'))) !== String(toUnits(String(p.qty ?? '0')))) {
            throw AppError.conflict('Quantities cannot be changed after the document was submitted.');
          }
        }
      }
      // Phase 4 (DocumentHooks.lineExtras): module-owned line keys bypass the form pipeline and are kept verbatim.
      for (const k of this.store.hooks.extrasOf(b.type.key)) {
        const prevById = new Map(prevRows.map(r => [r._row, r[k]]));
        for (const r of prevRows) delete r[k];
        for (const r of rows) {
          const own = Object.prototype.hasOwnProperty.call(r, k);
          const v = own ? r[k] : prevById.get(r._row);
          delete r[k];
          if (v !== undefined) (extras.get(String(r._row)) ?? extras.set(String(r._row), {}).get(String(r._row))!)[k] = v;
        }
      }
      incoming.lines = rows;
    } else if (input.lines.length) {
      throw bad('lines', 'This document type has no lines.');
    }
    await this.autofill(tx, actor, b, incoming, rows);
    const def = mode === 'submit' ? b.composed.def : this.relaxed(b.composed.def);
    const prepared = await this.engine.prepare(tx, actor.tenantId, {
      def, formKey: b.engineKey, prev, incoming, isCreate: !doc, owner: { kind: DOCUMENT_ENTITY, id: doc?.id ?? null },
      today: await tenantToday(tx), perms: this.store.enginePerms(actor, b),
    });
    // Line form validations, per line (header fields visible to them like formulas).
    const errors: Issue[] = [];
    const outRows = (prepared.data.lines as Record<string, unknown>[] | undefined) ?? [];
    if (b.line?.validations.length) {
      const today = await tenantToday(tx);
      outRows.forEach((r, i) => {
        for (const v of b.line!.validations) {
          const res = evaluateExpr(v.expr, { values: { ...prepared.data, ...r }, today, defaultPrecision: 2 });
          if (res && !res.error && res.value === false) errors.push({ path: `lines.${i}.${v.key}`, message: v.message });
        }
      });
    }
    if (mode === 'submit') {
      if (b.line && !outRows.length) errors.push({ path: 'lines', message: 'Add at least one line before submitting.' });
      outRows.forEach((r, i) => {
        if (b.lineSys.has('qty') && toUnits(String(r.qty ?? '0')) <= 0n) errors.push({ path: `lines.${i}.qty`, message: 'Quantity must be greater than 0.' });
      });
      if (b.headerSys.has('doc_date') && isEmpty(prepared.data.doc_date)) errors.push({ path: 'doc_date', message: 'Date is required.' });
    }
    if (isEmpty(prepared.data.location)) errors.push({ path: 'location', message: 'Location is required.' });
    // QA3-BUG-002: quantity/amount columns are numeric(18,4): larger values are a validation error, not a 500.
    const tooBig = (v: unknown) => {
      if (v === null || v === undefined || v === '') return false;
      const [int = ''] = String(v).replace(/^-/, '').split('.');
      return int.replace(/^0+/, '').length > 14;
    };
    const tooBigMsg = 'This value is too large (at most 99,999,999,999,999.9999).';
    if (b.headerSys.has('total_amount') && tooBig(prepared.data.total_amount)) errors.push({ path: 'total_amount', message: tooBigMsg });
    outRows.forEach((r, i) => {
      for (const k of ['qty', 'rate', 'amount']) if (b.lineSys.has(k) && tooBig(r[k])) errors.push({ path: `lines.${i}.${k}`, message: tooBigMsg });
    });
    // QA3-BUG-003: a quantity has at most the decimal places of its unit (UoM master `decimals`).
    if (b.lineSys.has('qty') && b.lineSys.has('uom') && outRows.length) {
      const rules = await uomRules(tx, actor.tenantId, outRows.map(r => (typeof r.uom === 'string' ? r.uom : null)));
      outRows.forEach((r, i) => {
        const rule = typeof r.uom === 'string' ? rules.get(r.uom) : undefined;
        if (rule && !fitsUom(r.qty, rule)) errors.push({ path: `lines.${i}.qty`, message: uomMessage(r.qty, rule) });
      });
    }
    if (errors.length) throw validationFailed(errors);
    for (const r of outRows) {
      const e = extras.get(String(r._row));
      if (e) Object.defineProperty(r, '__extras', { value: e, enumerable: false });
    }
    return { ...prepared, rows: outRows };
  }

  /** Splits prepared data into document columns + custom JSON (and the same per line). */
  private split(b: FormBundle, data: Record<string, unknown>, today: string) {
    const custom: Record<string, unknown> = {};
    const cols = { location_node_id: '', doc_date: today, required_by: null as string | null, party_id: null as string | null, total_amount: null as string | null };
    for (const [k, v] of Object.entries(data)) {
      if (k === 'lines') continue;
      if (!b.headerSys.has(k)) {
        custom[k] = v;
        continue;
      }
      if (k === 'location') cols.location_node_id = String(v);
      else if (k === 'doc_date') cols.doc_date = String(v);
      else if (k === 'required_by') cols.required_by = v ? String(v) : null;
      else if (k === 'party') cols.party_id = v ? String(v) : null;
      else if (k === 'total_amount') cols.total_amount = v === undefined || v === null ? null : String(v);
    }
    const lines = ((data.lines as Record<string, unknown>[] | undefined) ?? []).map(r => {
      const lc: Record<string, unknown> = {};
      const out = { id: String(r._row), item_id: null as string | null, uom_id: null as string | null, qty: '0', rate: null as string | null, amount: null as string | null, required_date: null as string | null, location_node_id: cols.location_node_id };
      for (const [k, v] of Object.entries(r)) {
        if (k === '_row') continue;
        if (!b.lineSys.has(k)) {
          lc[k] = v;
          continue;
        }
        const s = v === undefined || v === null ? null : String(v);
        if (k === 'item') out.item_id = s;
        else if (k === 'uom') out.uom_id = s;
        else if (k === 'qty') out.qty = s ?? '0';
        else if (k === 'rate') out.rate = s;
        else if (k === 'amount') out.amount = s;
        else if (k === 'required_date') out.required_date = s;
        else if (k === 'location' && s) out.location_node_id = s;
      }
      const ex = (r as { __extras?: Record<string, unknown> }).__extras;
      if (ex) Object.assign(lc, ex);
      return { ...out, custom: lc };
    });
    return { cols, custom, lines };
  }

  /** Inserts/updates/soft-deletes lines to match `lines` (order = line numbers). */
  private async writeLines(tx: Tx, actor: DocActor, doc: { id: string; doc_type_id: string }, lines: ReturnType<DocumentsService['split']>['lines'], prev: LineRow[]) {
    const tid = actor.tenantId;
    const keep = new Set(lines.map(l => l.id));
    const removed = prev.filter(p => !keep.has(p.id)).map(p => p.id);
    if (removed.length) {
      await tx.updateTable('app.document_line').set({ is_deleted: true, updated_by: actor.userId }).where('tenant_id', '=', tid).where('id', 'in', removed).execute();
    }
    const prevById = new Map(prev.map(p => [p.id, p]));
    const moved = lines.some((l, i) => prevById.has(l.id) && prevById.get(l.id)!.line_no !== i + 1);
    if (moved) {
      const ids = lines.filter(l => prevById.has(l.id)).map(l => l.id);
      await tx.updateTable('app.document_line').set(eb => ({ line_no: eb('line_no', '+', 100000) })).where('tenant_id', '=', tid).where('id', 'in', ids).execute();
    }
    for (const [i, l] of lines.entries()) {
      const values = {
        line_no: i + 1, item_id: l.item_id, uom_id: l.uom_id, qty: l.qty, rate: l.rate, amount: l.amount, required_date: l.required_date,
        location_node_id: l.location_node_id, custom: JSON.stringify(l.custom), updated_by: actor.userId,
      };
      if (prevById.has(l.id)) {
        await tx.updateTable('app.document_line').set(values).where('tenant_id', '=', tid).where('id', '=', l.id).execute();
      } else {
        await tx.insertInto('app.document_line').values({ ...values, id: l.id, tenant_id: tid, document_id: doc.id, doc_type_id: doc.doc_type_id, created_by: actor.userId }).execute();
      }
    }
  }

  private async writeRefsAndFiles(tx: Tx, tenantId: string, docId: string, p: PreparedData) {
    await this.engine.writeRefs(tx, tenantId, { kind: DOCUMENT_ENTITY, id: docId }, p.refs);
    await this.files.syncAttachments(tx, tenantId, { kind: DOCUMENT_ENTITY, id: docId }, p.files);
  }

  // ------------------------------------------------------------------ create / update / delete
  async create(tx: Tx, actor: DocActor, typeKey: string, input: Write, opts: { copiedFrom?: string } = {}): Promise<DocumentRow> {
    const type = await this.typeFor(tx, actor, typeKey);
    need(actor, docAction(typeKey, 'add'));
    if (!type.is_active) throw AppError.conflict(`"${type.name}" is inactive; new documents cannot be created.`);
    const b = await this.store.bundle(tx, actor.tenantId, type);
    const p = await this.prepare(tx, actor, b, null, [], input, 'draft');
    const today = await tenantToday(tx);
    const s = this.split(b, p.data, today);
    const loc = await tx.selectFrom('app.location_node').select(['path']).where('tenant_id', '=', actor.tenantId).where('id', '=', s.cols.location_node_id).executeTakeFirst();
    if (!loc || !this.store.inScope(actor, typeKey, String(loc.path))) throw AppError.forbidden('You cannot create documents for this location.');
    const row = await tx.insertInto('app.document').values({
      tenant_id: actor.tenantId, doc_type_id: type.id, status_key: 'draft', ...s.cols, custom: JSON.stringify(s.custom),
      form_version_id: b.headerVersionId, line_form_version_id: b.lineVersionId, created_by: actor.userId, updated_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await this.writeLines(tx, actor, { id: row.id, doc_type_id: type.id }, s.lines, []);
    await this.writeRefsAndFiles(tx, actor.tenantId, row.id, p);
    await this.store.hooks.runSave(tx, { tenantId: actor.tenantId, documentId: row.id, docTypeKey: type.key, actor, statusKey: 'draft', mode: 'create' });
    const doc = await this.store.loadDoc(tx, actor.tenantId, row.id);
    const lines = await this.store.loadLines(tx, actor.tenantId, row.id);
    await this.audit.tenant(tx, {
      action: opts.copiedFrom ? 'copy' : 'create', entity: DOCUMENT_ENTITY, entityId: row.id, actorId: actor.userId,
      after: { docType: type.key, ...this.store.snapshot(doc, lines, b), ...(opts.copiedFrom ? { copiedFrom: opts.copiedFrom } : {}) },
    });
    await this.store.emit(tx, 'document.created', { kind: DOCUMENT_ENTITY, id: row.id }, { documentId: row.id, docTypeKey: type.key, copiedFrom: opts.copiedFrom ?? null });
    return this.toRow(tx, actor, type, doc, lines);
  }

  async update(tx: Tx, actor: DocActor, typeKey: string, id: string, input: z.infer<typeof DocumentUpdate>): Promise<DocumentRow> {
    const type = await this.typeFor(tx, actor, typeKey);
    need(actor, docAction(typeKey, 'edit'));
    const doc = await this.access(tx, actor, type, id, true);
    if (doc.version !== input.version) throw AppError.versionConflict();
    const editable = settingsOf(type).editableStatuses.includes(doc.status_key);
    if (!editable || doc.is_locked) throw AppError.conflict('This document can no longer be edited.');
    const draft = doc.status_key === 'draft';
    const b = await this.store.bundleFor(tx, actor.tenantId, type, doc, draft);
    const prevLines = await this.store.loadLines(tx, actor.tenantId, id);
    const before = this.store.snapshot(doc, prevLines, await this.store.bundleFor(tx, actor.tenantId, type, doc));
    const draftLike = draft || this.store.hooks.isDraftLike(type.key, doc.status_key);
    const p = await this.prepare(tx, actor, b, doc, prevLines, input, draftLike ? 'draft' : 'edit');
    const s = this.split(b, p.data, doc.doc_date);
    if (s.cols.location_node_id !== doc.location_node_id) {
      if (!draft) throw AppError.conflict('The location cannot change after the document was submitted.');
      const loc = await tx.selectFrom('app.location_node').select('path').where('tenant_id', '=', actor.tenantId).where('id', '=', s.cols.location_node_id).executeTakeFirst();
      if (!loc || !this.store.inScope(actor, typeKey, String(loc.path))) throw AppError.forbidden('You cannot move documents to this location.');
    }
    await tx.updateTable('app.document').set({
      ...s.cols, custom: JSON.stringify(s.custom), form_version_id: b.headerVersionId, line_form_version_id: b.lineVersionId, updated_by: actor.userId,
    }).where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    await this.writeLines(tx, actor, doc, s.lines, prevLines);
    await this.writeRefsAndFiles(tx, actor.tenantId, id, p);
    await this.store.hooks.runSave(tx, { tenantId: actor.tenantId, documentId: id, docTypeKey: type.key, actor, statusKey: doc.status_key, mode: 'update' });
    const after = await this.store.loadDoc(tx, actor.tenantId, id);
    const lines = await this.store.loadLines(tx, actor.tenantId, id);
    await this.audit.tenant(tx, { action: 'update', entity: DOCUMENT_ENTITY, entityId: id, actorId: actor.userId, before, after: this.store.snapshot(after, lines, b) });
    await this.store.emit(tx, 'document.updated', { kind: DOCUMENT_ENTITY, id }, { documentId: id, docTypeKey: type.key, number: after.number });
    return this.toRow(tx, actor, type, after, lines);
  }

  async remove(tx: Tx, actor: DocActor, typeKey: string, id: string): Promise<void> {
    const type = await this.typeFor(tx, actor, typeKey);
    need(actor, docAction(typeKey, 'delete'));
    const doc = await this.access(tx, actor, type, id, true);
    if (doc.status_key !== 'draft') throw AppError.conflict('Only drafts can be deleted. Cancel the document instead.');
    await tx.updateTable('app.document').set({ is_deleted: true, updated_by: actor.userId }).where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    await this.engine.writeRefs(tx, actor.tenantId, { kind: DOCUMENT_ENTITY, id }, []);
    await this.files.syncAttachments(tx, actor.tenantId, { kind: DOCUMENT_ENTITY, id }, new Map());
    await this.audit.tenant(tx, { action: 'delete', entity: DOCUMENT_ENTITY, entityId: id, actorId: actor.userId, before: { number: doc.number, status: doc.status_key } });
  }

  /** Approver edits of editable line fields during a decision (DocumentsPort.applyLineEdits): engine-validated, audited. */
  async applyLineEdits(
    tx: Tx, tenantId: string, id: string, edits: { lineId: string; values: Record<string, unknown> }[],
    by?: { userId: string | null; perms: MyPermissions | null },
  ): Promise<void> {
    const actor: DocActor = { tenantId, userId: by?.userId ?? null, perms: null };
    const doc = await this.store.loadDoc(tx, tenantId, id, { lock: true });
    const type = await this.types.loadById(tx, tenantId, doc.doc_type_id);
    const b = await this.store.bundleFor(tx, tenantId, type, doc);
    const prevLines = await this.store.loadLines(tx, tenantId, id);
    for (const e of edits) if (!prevLines.some(l => l.id === e.lineId)) throw AppError.notFound('Document line');
    // QA3-BUG-008: the approver's own field access still applies to the stage's editable line fields.
    if (by?.perms) {
      const access = this.store.enginePerms({ tenantId, userId: by.userId, perms: by.perms }, b)?.fieldAccess[b.engineKey] ?? {};
      for (const e of edits) {
        for (const k of Object.keys(e.values)) {
          if (access[`lines.${k}`]) throw new AppError(403, 'FIELD_READ_ONLY', `You are not allowed to change "${k}".`, { field: k, lineId: e.lineId });
        }
      }
    }
    const before = this.store.snapshot(doc, prevLines, b);
    const lines = prevLines.map(l => ({ id: l.id, values: { ...this.store.lineValues(l, b), ...(edits.find(e => e.lineId === l.id)?.values ?? {}) } }));
    const p = await this.prepare(tx, actor, b, doc, prevLines, { values: {}, lines }, 'edit');
    const s = this.split(b, p.data, doc.doc_date);
    await tx.updateTable('app.document').set({ ...s.cols, custom: JSON.stringify(s.custom) }).where('tenant_id', '=', tenantId).where('id', '=', id).execute();
    await this.writeLines(tx, actor, doc, s.lines, prevLines);
    await this.writeRefsAndFiles(tx, tenantId, id, p);
    await this.store.hooks.runSave(tx, { tenantId, documentId: id, docTypeKey: type.key, actor, statusKey: doc.status_key, mode: 'line_edits' });
    const after = await this.store.loadDoc(tx, tenantId, id);
    await this.audit.tenant(tx, { action: 'update', entity: DOCUMENT_ENTITY, entityId: id, actorId: actor.userId, before, after: this.store.snapshot(after, await this.store.loadLines(tx, tenantId, id), b) });
    await this.store.emit(tx, 'document.updated', { kind: DOCUMENT_ENTITY, id }, { documentId: id, docTypeKey: type.key, number: after.number, lineIds: edits.map(e => e.lineId) });
  }

  // ------------------------------------------------------------------ submit
  async submit(tx: Tx, actor: DocActor, typeKey: string, id: string, version: number): Promise<DocumentRow> {
    const type = await this.typeFor(tx, actor, typeKey);
    need(actor, docAction(typeKey, 'submit'));
    const doc = await this.access(tx, actor, type, id, true);
    if (doc.version !== version) throw AppError.versionConflict();
    // Phase 4 hook (DocumentHooks.onResubmit, agent B): e.g. a PO amendment going back to approval.
    if (await this.store.hooks.runResubmit(tx, { tenantId: actor.tenantId, documentId: id, docTypeKey: type.key, actor, statusKey: doc.status_key, version })) {
      return this.toRow(tx, actor, type, await this.store.loadDoc(tx, actor.tenantId, id));
    }
    if (doc.status_key !== 'draft') throw AppError.conflict('Only drafts can be submitted.');
    if (!type.is_active) throw AppError.conflict(`"${type.name}" is inactive; documents cannot be submitted.`);
    const b = await this.store.bundle(tx, actor.tenantId, type);
    let prevLines = await this.store.loadLines(tx, actor.tenantId, id);
    const p = await this.prepare(tx, actor, b, doc, prevLines, { values: {}, lines: prevLines.map(l => ({ id: l.id, values: this.store.lineValues(l, b) })) }, 'submit');
    const s = this.split(b, p.data, doc.doc_date);
    await tx.updateTable('app.document').set({
      ...s.cols, custom: JSON.stringify(s.custom), form_version_id: b.headerVersionId, line_form_version_id: b.lineVersionId, updated_by: actor.userId,
    }).where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    await this.writeLines(tx, actor, doc, s.lines, prevLines);
    await this.writeRefsAndFiles(tx, actor.tenantId, id, p);
    await this.store.hooks.runSave(tx, { tenantId: actor.tenantId, documentId: id, docTypeKey: type.key, actor, statusKey: 'draft', mode: 'submit' });
    prevLines = await this.store.loadLines(tx, actor.tenantId, id);
    if (!b.line && !prevLines.length) {
      // Document-level types carry one implicit line (qty 1) so the ledger and workflow work unchanged.
      await tx.insertInto('app.document_line').values({
        tenant_id: actor.tenantId, document_id: id, doc_type_id: type.id, line_no: 1, qty: '1', location_node_id: s.cols.location_node_id, created_by: actor.userId,
      }).execute();
      prevLines = await this.store.loadLines(tx, actor.tenantId, id);
    }
    const numbered = doc.number ? { number: doc.number, seriesId: doc.number_series_id } : await this.numbering.next(tx, actor.tenantId, type, { locationId: s.cols.location_node_id, date: s.cols.doc_date });
    await tx.updateTable('app.document').set({
      number: numbered.number, number_series_id: numbered.seriesId, status_key: 'submitted', submitted_at: new Date(), submitted_by: actor.userId,
      is_locked: true, cancelled_at: null, cancelled_reason: null,
    }).where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    await tx.updateTable('app.document_line').set({ status_key: 'submitted', cancelled_reason: null }).where('tenant_id', '=', actor.tenantId).where('document_id', '=', id).where('is_deleted', '=', false).execute();
    await this.store.record(tx, actor.tenantId, id, prevLines.map(l => ({ lineId: l.id, type: 'requested' as const, qty: l.qty })), actor.userId);
    // Phase 4 hook (DocumentHooks.onSubmit): e.g. vendor selection consumes indent quantities; may abort the submit.
    await this.store.hooks.runSubmit(tx, { tenantId: actor.tenantId, documentId: id, docTypeKey: type.key, actor });
    const port = this.store.wf.port;
    if (port) await port.start(tx, id, actor.userId ?? doc.created_by ?? '');
    else await this.store.record(tx, actor.tenantId, id, prevLines.map(l => ({ lineId: l.id, type: 'approved' as const, qty: l.qty, reason: 'No workflow' })), actor.userId);
    await this.store.recompute(tx, actor.tenantId, id, actor.userId);
    const after = await this.store.loadDoc(tx, actor.tenantId, id);
    await this.audit.tenant(tx, {
      action: 'submit', entity: DOCUMENT_ENTITY, entityId: id, actorId: actor.userId,
      after: { number: after.number, status: after.status_key, lines: prevLines.map(l => ({ lineNo: l.line_no, qty: fromUnits(toUnits(l.qty)) })) },
    });
    await this.store.emit(tx, 'document.submitted', { kind: DOCUMENT_ENTITY, id }, {
      documentId: id, docTypeKey: type.key, number: after.number, submittedBy: actor.userId, status: after.status_key, totalAmount: after.total_amount,
    });
    return this.toRow(tx, actor, type, after);
  }

  // ------------------------------------------------------------------ cancel / close
  async cancel(tx: Tx, actor: DocActor, typeKey: string, id: string, input: z.infer<typeof CancelInput>): Promise<DocumentRow> {
    const type = await this.typeFor(tx, actor, typeKey);
    need(actor, docAction(typeKey, 'cancel'));
    const doc = await this.access(tx, actor, type, id, true);
    if (doc.status_key === 'draft') throw AppError.conflict('Drafts are deleted, not cancelled.');
    if (doc.cancelled_at || doc.closed_at) throw AppError.conflict('This document is already cancelled or closed.');
    const lines = await this.store.loadLines(tx, actor.tenantId, id);
    const rem = await this.store.remaining(tx, actor.tenantId, lines.map(l => l.id));
    const open = (lid: string) => (rem.get(lid)?.pending ?? 0n) > 0n;
    const port = this.store.wf.port;
    let cancelledLines: string[];
    if (input.lineIds?.length) {
      if (!settingsOf(type).allowLineCancel) throw AppError.conflict(`Lines of "${type.name}" cannot be cancelled individually.`);
      const ids = [...new Set(input.lineIds)];
      for (const lid of ids) if (!lines.some(l => l.id === lid)) throw AppError.notFound('Document line');
      const closed = ids.filter(lid => !open(lid));
      if (closed.length) throw AppError.conflict('Some of these lines have nothing left to cancel.', { lineIds: closed });
      await this.store.cancelRemaining(tx, actor.tenantId, id, ids, input.reason, actor.userId);
      await tx.updateTable('app.document_line').set({ cancelled_reason: input.reason, updated_by: actor.userId }).where('tenant_id', '=', actor.tenantId).where('id', 'in', ids).execute();
      if (port) await port.linesCancelled(tx, id, ids);
      cancelledLines = ids;
    } else {
      const ids = lines.filter(l => open(l.id)).map(l => l.id);
      if (!ids.length) throw AppError.conflict('Nothing is pending on this document; it cannot be cancelled. Close it instead.');
      await this.store.cancelRemaining(tx, actor.tenantId, id, ids, input.reason, actor.userId);
      await tx.updateTable('app.document_line').set({ cancelled_reason: input.reason, updated_by: actor.userId }).where('tenant_id', '=', actor.tenantId).where('id', 'in', ids).execute();
      await tx.updateTable('app.document').set({ cancelled_at: new Date(), cancelled_reason: input.reason, updated_by: actor.userId }).where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
      if (port) await port.cancel(tx, id, input.reason, actor.userId);
      cancelledLines = ids;
    }
    await this.store.recompute(tx, actor.tenantId, id, actor.userId);
    const lineNos = lines.filter(l => cancelledLines.includes(l.id)).map(l => l.line_no);
    await this.audit.tenant(tx, { action: 'cancel', entity: DOCUMENT_ENTITY, entityId: id, actorId: actor.userId, after: { reason: input.reason, whole: !input.lineIds?.length, lineNos } });
    await this.store.emit(tx, 'document.cancelled', { kind: DOCUMENT_ENTITY, id }, { documentId: id, docTypeKey: type.key, number: doc.number, lineIds: cancelledLines, whole: !input.lineIds?.length, reason: input.reason });
    return this.toRow(tx, actor, type, await this.store.loadDoc(tx, actor.tenantId, id));
  }

  /** Short-closes what is left to order on the lines (Phase 4) and, for the whole document, marks it closed. */
  async closeDoc(tx: Tx, tenantId: string, type: DocTypeRow, doc: DocRow, lineIds: string[] | null, reason: string, actorId: string | null) {
    const lines = await this.store.loadLines(tx, tenantId, doc.id);
    const target = lineIds ? lines.filter(l => lineIds.includes(l.id)) : lines;
    const sums = await this.store.summaries(tx, tenantId, target.map(l => l.id));
    const events: LedgerEvent[] = [];
    for (const l of target) {
      const po = pendingOrder(sums.get(l.id) ?? emptyBuckets());
      if (po > 0n) events.push({ lineId: l.id, type: 'short_closed', qty: fromUnits(po), reason });
    }
    await this.store.record(tx, tenantId, doc.id, events, actorId);
    if (!lineIds) {
      await tx.updateTable('app.document').set({ closed_at: new Date(), closed_reason: reason, is_locked: true, updated_by: actorId }).where('tenant_id', '=', tenantId).where('id', '=', doc.id).execute();
    }
    await this.store.recompute(tx, tenantId, doc.id, actorId);
    await this.audit.tenant(tx, { action: 'close', entity: DOCUMENT_ENTITY, entityId: doc.id, actorId, after: { reason, whole: !lineIds, lineNos: target.map(l => l.line_no) } });
    await this.store.emit(tx, 'document.closed', { kind: DOCUMENT_ENTITY, id: doc.id }, { documentId: doc.id, docTypeKey: type.key, number: doc.number, lineIds: target.map(l => l.id), whole: !lineIds, reason });
  }

  async close(tx: Tx, actor: DocActor, typeKey: string, id: string, input: z.infer<typeof CloseInput>): Promise<DocumentRow> {
    const type = await this.typeFor(tx, actor, typeKey);
    need(actor, docAction(typeKey, 'close'));
    const doc = await this.access(tx, actor, type, id, true);
    if (doc.status_key === 'draft') throw AppError.conflict('Drafts cannot be closed.');
    if (doc.cancelled_at || doc.closed_at) throw AppError.conflict('This document is already cancelled or closed.');
    const lines = await this.store.loadLines(tx, actor.tenantId, id);
    const ids = input.lineIds?.length ? [...new Set(input.lineIds)] : null;
    if (ids) for (const lid of ids) if (!lines.some(l => l.id === lid)) throw AppError.notFound('Document line');
    const rem = await this.store.remaining(tx, actor.tenantId, ids ?? lines.map(l => l.id));
    if ([...rem.values()].some(r => r.pending > 0n)) throw AppError.conflict('Some quantity is still waiting for approval. Cancel it before closing.');
    await this.closeDoc(tx, actor.tenantId, type, doc, ids, input.reason, actor.userId);
    return this.toRow(tx, actor, type, await this.store.loadDoc(tx, actor.tenantId, id));
  }

  // ------------------------------------------------------------------ copy
  async copy(tx: Tx, actor: DocActor, typeKey: string, id: string): Promise<DocumentRow> {
    const type = await this.typeFor(tx, actor, typeKey);
    need(actor, docAction(typeKey, 'add'));
    need(actor, docAction(typeKey, 'copy'));
    const src = await this.access(tx, actor, type, id);
    const sb = await this.store.bundleFor(tx, actor.tenantId, type, src);
    const cur = await this.store.bundle(tx, actor.tenantId, type);
    const perms = this.store.enginePerms(actor, cur);
    const access = perms?.fieldAccess[cur.engineKey] ?? {};
    // Only fields the copier may set, that still exist, and that are not files (a file belongs to one record).
    const keep = (fields: Map<string, DataField>, prefix: string) => (k: string) => {
      const f = fields.get(k);
      return !!f && !f.removed && f.type !== 'formula' && !isFileField(f) && !access[`${prefix}${k}`];
    };
    const pick = (v: Record<string, unknown>, ok: (k: string) => boolean) => Object.fromEntries(Object.entries(v).filter(([k]) => ok(k)));
    const lines = await this.store.loadLines(tx, actor.tenantId, id);
    const values = pick(this.store.headerValues(src, sb), keep(cur.headerFields, ''));
    const lineWrites = cur.line ? lines.filter(l => !l.cancelled_reason || toUnits(l.qty) > 0n).map(l => ({ values: pick(this.store.lineValues(l, sb), keep(cur.lineFields, 'lines.')) })) : [];
    return this.create(tx, actor, typeKey, { values, lines: lineWrites }, { copiedFrom: id });
  }

  // ------------------------------------------------------------------ output
  async detail(tx: Tx, actor: DocActor, typeKey: string, id: string): Promise<DocumentRow> {
    const type = await this.typeFor(tx, actor, typeKey);
    return this.toRow(tx, actor, type, await this.access(tx, actor, type, id));
  }

  async toRow(tx: Tx, actor: DocActor, type: DocTypeRow, doc: DocRow, lines?: LineRow[]): Promise<DocumentRow> {
    const tid = actor.tenantId;
    const b = await this.store.bundleFor(tx, tid, type, doc);
    lines ??= await this.store.loadLines(tx, tid, doc.id);
    const rows = lines.map(l => ({ _row: l.id, ...this.store.lineValues(l, b) }));
    const data = { ...this.store.headerValues(doc, b), ...(b.line ? { lines: rows } : {}) };
    const [dec] = await this.engine.decorate(tx, tid, this.store.readPerms(actor, b), b.engineKey, [{ data, def: b.composed.def }]);
    const outRows = new Map(((dec!.data.lines as Record<string, unknown>[] | undefined) ?? []).map(r => [String(r._row), r]));
    const headerValues = { ...dec!.data };
    delete headerValues.lines;
    const headerRefs: Record<string, Record<string, string>> = {};
    const lineRefMaps: Record<string, Record<string, string>> = {};
    for (const [k, v] of Object.entries(dec!.refs)) {
      if (k.startsWith('lines.')) lineRefMaps[k.slice(6)] = v;
      else headerRefs[k] = v;
    }
    const [sums, stages, info, workflow] = await Promise.all([
      this.store.summaries(tx, tid, lines.map(l => l.id)),
      this.store.wf.lineStages(tx, doc.id),
      this.types.stageInfo(tx, type.id),
      actor.userId ? this.store.wf.runtimeView(tx, doc.id, { userId: actor.userId, permissions: actor.perms?.keys ?? [] }) : Promise.resolve(null),
    ]);
    const userIds = [doc.created_by, doc.submitted_by].filter((x): x is string => !!x);
    const users = userIds.length
      ? new Map((await tx.selectFrom('app.tenant_user').select(['id', 'name']).where('tenant_id', '=', tid).where('id', 'in', userIds).execute()).map(u => [u.id, u.name]))
      : new Map<string, string>();
    const returnsReopen = await getTenantSetting(tx, 'rtv.reopens_po');
    const lineRows: DocumentLineRow[] = lines.map(l => {
      const values = { ...(outRows.get(l.id) ?? {}) };
      delete values._row;
      for (const k of this.store.hooks.extrasOf(type.key)) if (l.custom?.[k] !== undefined) values[k] = l.custom[k];
      const refs: Record<string, Record<string, string>> = {};
      for (const [k, m] of Object.entries(lineRefMaps)) {
        const ids = Array.isArray(values[k]) ? (values[k] as string[]) : typeof values[k] === 'string' ? [values[k] as string] : [];
        const own = Object.fromEntries(ids.filter(x => m[x]).map(x => [x, m[x]!]));
        if (Object.keys(own).length) refs[k] = own;
      }
      return {
        id: l.id, lineNo: l.line_no, values, refs, statusKey: l.status_key === 'submitted' ? 'draft' : l.status_key,
        qty: toQuantityBuckets(sums.get(l.id) ?? emptyBuckets(), { returnsReopen }), stages: stages[l.id] ?? {}, cancelledReason: l.cancelled_reason, version: l.version,
      };
    });
    const statusKey = doc.status_key === 'submitted' ? 'draft' : doc.status_key;
    const row: DocumentRow = {
      id: doc.id, docTypeKey: type.key, number: doc.number, statusKey, statusLabel: statusLabel(statusKey, info.labels),
      values: headerValues, refs: headerRefs, files: dec!.files, formVersionId: doc.form_version_id, lineFormVersionId: doc.line_form_version_id,
      isLocked: doc.is_locked, revNo: doc.rev_no ?? 0, submittedAt: doc.submitted_at ? new Date(doc.submitted_at).toISOString() : null,
      submittedBy: doc.submitted_by ? { id: doc.submitted_by, name: users.get(doc.submitted_by) ?? '' } : null,
      createdAt: new Date(doc.created_at).toISOString(), createdBy: doc.created_by ? { id: doc.created_by, name: users.get(doc.created_by) ?? '' } : null,
      lines: lineRows, workflow, allowedActions: [], version: doc.version,
    };
    row.allowedActions = this.allowedActions(actor, type, doc, lineRows, row.workflow);
    return row;
  }

  allowedActions(actor: DocActor, type: DocTypeRow, doc: DocRow, lines: DocumentLineRow[], wf: DocumentRow['workflow']): DocumentRow['allowedActions'] {
    const k = type.key;
    const s = settingsOf(type);
    const out: DocumentRow['allowedActions'] = [];
    const draft = doc.status_key === 'draft';
    const final = !!doc.cancelled_at || !!doc.closed_at;
    const pending = lines.some(l => toUnits(l.qty.pendingApproval) > 0n);
    if (has(actor, docAction(k, 'edit')) && s.editableStatuses.includes(doc.status_key) && !doc.is_locked) out.push('edit');
    if (draft && has(actor, docAction(k, 'delete'))) out.push('delete');
    if ((draft || this.store.hooks.isDraftLike(k, doc.status_key)) && has(actor, docAction(k, 'submit'))) out.push('submit');
    if (!draft && !final && pending && has(actor, docAction(k, 'cancel'))) {
      out.push('cancel');
      if (s.allowLineCancel && lines.length) out.push('cancel_lines');
    }
    if (!draft && !final && !pending && has(actor, docAction(k, 'close'))) out.push('close');
    if (has(actor, docAction(k, 'add')) && has(actor, docAction(k, 'copy'))) out.push('copy');
    if (has(actor, docAction(k, 'comment'))) out.push('comment');
    if (has(actor, docAction(k, 'attach'))) out.push('attach');
    if (wf && wf.status === 'running') {
      const acts = new Set<string>();
      let held = false;
      for (const st of wf.stages) {
        if (st.status !== 'active' || !st.canAct) continue;
        for (const a of wf.stageActions[st.key] ?? []) acts.add(a);
        if (lines.some(l => toUnits(l.stages[st.key]?.held ?? '0') > 0n)) held = true;
      }
      if (['approve', 'partial', 'reject', 'hold'].some(a => acts.has(a))) out.push('decide');
      if (held) out.push('unhold');
      if (acts.has('send_back')) out.push('send_back');
      if (acts.has('forward')) out.push('forward');
    }
    return out;
  }

}

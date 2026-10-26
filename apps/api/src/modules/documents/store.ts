import { Injectable } from '@nestjs/common';
import { DataField, FormDefinition, MyPermissions } from '@procure/schema';
import { sql } from 'kysely';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import type { LedgerEvent } from '../../core/ports';
import { canonicalDecimal, ComposedDocumentDefinition, composeDocumentDefinition, dataFields, FormsService } from '../forms';
import { NodeFilter, ScopeService } from '../permissions';
import { DocTypesService } from './doc-types.service';
import { DocumentHooks, OUTCOME_EVENT_TYPES } from './hooks';
import { systemKeysOf } from './forms-def';
import { applyEvent, Buckets, bucketsFromRow, BUCKETS, emptyBuckets, fromUnits, isQty, pendingApproval, toUnits } from './qty';
import { fitsUom, uomMessage, uomRules } from './uom';
import { documentStatus, lineStatus, statusLabel } from './status';
import { WorkflowLink } from './workflow-link';
import { DOCUMENT_ENTITY, docTab, DocActor, DocTypeRow, headerFormKey, lineFormKey, settingsOf } from './types';

export interface DocRow {
  id: string; doc_type_id: string; number: string | null; number_series_id: string | null; status_key: string; location_node_id: string;
  doc_date: string; required_by: string | null; party_id: string | null; currency: string | null; total_amount: string | null;
  custom: Record<string, unknown>; form_version_id: string; line_form_version_id: string | null; is_locked: boolean; rev_no?: number;
  submitted_at: Date | null; submitted_by: string | null; closed_at: Date | null; closed_reason: string | null;
  cancelled_at: Date | null; cancelled_reason: string | null; created_at: Date; created_by: string | null; updated_at: Date;
  version: number; is_deleted: boolean;
  /** Joined: location path (ltree text), code and name. */
  loc_path: string; loc_code: string; loc_name: string;
}
export interface LineRow {
  id: string; document_id: string; line_no: number; item_id: string | null; uom_id: string | null; qty: string; rate: string | null;
  amount: string | null; required_date: string | null; location_node_id: string; status_key: string; custom: Record<string, unknown>;
  cancelled_reason: string | null; version: number;
}

export const DOC_COLS = [
  'id', 'doc_type_id', 'number', 'number_series_id', 'status_key', 'location_node_id', 'doc_date', 'required_by', 'party_id', 'currency',
  'total_amount', 'custom', 'form_version_id', 'line_form_version_id', 'is_locked', 'rev_no', 'submitted_at', 'submitted_by', 'closed_at', 'closed_reason',
  'cancelled_at', 'cancelled_reason', 'created_at', 'created_by', 'updated_at', 'version', 'is_deleted',
] as const;
export const LINE_COLS = [
  'id', 'document_id', 'line_no', 'item_id', 'uom_id', 'qty', 'rate', 'amount', 'required_date', 'location_node_id', 'status_key', 'custom',
  'cancelled_reason', 'version',
] as const;

/** A document type's forms at specific versions, composed with the virtual `lines` grid. */
export interface FormBundle {
  type: DocTypeRow;
  headerKey: string;
  lineKey: string | null;
  headerVersionId: string;
  lineVersionId: string | null;
  header: FormDefinition;
  line: FormDefinition | null;
  composed: ComposedDocumentDefinition;
  headerSys: Set<string>;
  lineSys: Set<string>;
  headerFields: Map<string, DataField>;
  lineFields: Map<string, DataField>;
  /** Key under which the engine sees the merged field access of both forms. */
  engineKey: string;
}

/** 'YYYY-MM-DD' from a pg date (string, or a Date at local midnight). */
export function dateStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

/** A stored numeric formatted to the field's decimal places (as the form engine stores values). */
export function numForField(v: string | number | null | undefined, f: DataField | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const canon = canonicalDecimal(v) ?? String(v);
  const places = !f ? 4 : f.type === 'number' ? 0 : ((f as { precision?: number }).precision ?? 2);
  const [int, frac = ''] = canon.split('.');
  if (frac.length > places) return canon;
  return places === 0 ? int! : `${int}.${frac.padEnd(places, '0')}`;
}

/** Ledger events whose quantity is a computed remainder/reversal, not an entered figure. */
const REMAINDER_EVENTS = new Set(['cancelled', 'unheld', 'short_closed', 'over_approval_cancelled', 'selection_cancelled', 'order_cancelled']);

export const qtyInvariant = (lineId: string, bucket: string, message?: string) =>
  new AppError(409, 'QTY_INVARIANT', message ?? `This change would make the "${bucket}" quantity of a line invalid. Reload and try again.`, { lineId, bucket });

/**
 * Shared document internals used by the HTTP services and by DOCUMENTS_PORT: loading, form bundles, value mapping,
 * the quantity ledger, status recomputation and the outbox.
 */
@Injectable()
export class DocStore {
  constructor(
    private readonly forms: FormsService,
    readonly types: DocTypesService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
    readonly wf: WorkflowLink,
    readonly hooks: DocumentHooks,
  ) {}

  // ------------------------------------------------------------------ forms
  async bundle(tx: Tx, tenantId: string, type: DocTypeRow, versions?: { header: string; line: string | null }): Promise<FormBundle> {
    let headerVersionId = versions?.header;
    let lineVersionId = versions?.line ?? null;
    if (!headerVersionId) {
      const h = await this.forms.loadById(tx, tenantId, type.header_form_id);
      if (!h.current_version_id) throw AppError.conflict(`The form of "${type.name}" has not been published.`);
      headerVersionId = h.current_version_id;
      if (type.line_form_id) {
        const l = await this.forms.loadById(tx, tenantId, type.line_form_id);
        lineVersionId = l.current_version_id;
      }
    }
    const defs = await this.forms.versionsById(tx, tenantId, [headerVersionId, ...(lineVersionId ? [lineVersionId] : [])]);
    const header = defs.get(headerVersionId);
    if (!header) throw AppError.notFound('Form version');
    const line = lineVersionId ? defs.get(lineVersionId) ?? null : null;
    return {
      type, headerKey: headerFormKey(type.key), lineKey: type.line_form_id ? lineFormKey(type.key) : null, headerVersionId, lineVersionId,
      header, line, composed: composeDocumentDefinition(header, line),
      headerSys: systemKeysOf(header, 'header'), lineSys: line ? systemKeysOf(line, 'line') : new Set(),
      headerFields: new Map(dataFields(header, true).map(f => [f.key, f])), lineFields: new Map(line ? dataFields(line, true).map(f => [f.key, f]) : []),
      engineKey: `__doc.${type.key}`,
    };
  }

  async bundleFor(tx: Tx, tenantId: string, type: DocTypeRow, doc: Pick<DocRow, 'form_version_id' | 'line_form_version_id' | 'status_key'>, current = false) {
    return current ? this.bundle(tx, tenantId, type) : this.bundle(tx, tenantId, type, { header: doc.form_version_id, line: doc.line_form_version_id });
  }

  /** Merged field access of the header and line forms as the engine sees the composed form ('lines.<col>'). */
  enginePerms(actor: DocActor, b: FormBundle): MyPermissions | null {
    if (!actor.perms) return null;
    const fa = actor.perms.fieldAccess ?? {};
    const merged: Record<string, 'hidden' | 'readonly'> = { ...(fa[b.headerKey] ?? {}) };
    if (b.lineKey) for (const [k, v] of Object.entries(fa[b.lineKey] ?? {})) merged[`lines.${k}`] = v;
    const ids = this.scope.nodeIds(actor.perms, docTab(b.type.key));
    return {
      keys: actor.perms.keys, version: actor.perms.version, fieldAccess: { [b.engineKey]: merged },
      scope: ids === 'all' ? { allNodes: true, nodeIds: [] } : { allNodes: false, nodeIds: ids },
    };
  }

  /**
   * Field keys the viewer cannot read: hidden by field access, plus formula fields computed from a hidden field
   * (QA3-OBS-1: `amount = qty × est_rate` would otherwise reveal a hidden `est_rate`), transitively, across the header
   * and line forms. Used by every read path (detail, lists, search/filter/sort, timeline diffs). Engine actors: none.
   */
  hiddenFields(actor: DocActor, b: FormBundle): { header: Set<string>; line: Set<string> } {
    const header = new Set<string>();
    const line = new Set<string>();
    if (!actor.perms) return { header, line };
    const fa = actor.perms.fieldAccess ?? {};
    for (const [k, v] of Object.entries(fa[b.headerKey] ?? {})) if (v === 'hidden') header.add(k);
    if (b.lineKey) for (const [k, v] of Object.entries(fa[b.lineKey] ?? {})) if (v === 'hidden') line.add(k);
    if (!header.size && !line.size) return { header, line };
    const refs = (expr: string) => {
      const lineRefs = [...expr.matchAll(/\blines\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]!);
      const plain = [...expr.replace(/\blines\s*\.\s*[A-Za-z_][A-Za-z0-9_]*/g, ' ').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ' ')
        .matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)].map(m => m[1]!);
      return { lineRefs, plain };
    };
    const formulas = [
      ...[...b.headerFields.values()].filter(f => f.type === 'formula' && !f.removed).map(f => ({ f, side: 'header' as const })),
      ...[...b.lineFields.values()].filter(f => f.type === 'formula' && !f.removed).map(f => ({ f, side: 'line' as const })),
    ].map(x => ({ ...x, r: refs(String((x.f as { expr?: string }).expr ?? '')) }));
    for (let changed = true; changed;) {
      changed = false;
      for (const x of formulas) {
        const own = x.side === 'header' ? header : line;
        if (own.has(x.f.key)) continue;
        // Line formulas see their row's fields and the header's; header formulas see header fields and `lines.<col>`.
        const dep = x.r.lineRefs.some(k => line.has(k))
          || x.r.plain.some(k => (x.side === 'line' ? line.has(k) || header.has(k) : header.has(k)));
        if (dep) { own.add(x.f.key); changed = true; }
      }
    }
    return { header, line };
  }

  /** Like enginePerms, with every unreadable field (hiddenFields) hidden: for decorating responses, never for writes. */
  readPerms(actor: DocActor, b: FormBundle): MyPermissions | null {
    const p = this.enginePerms(actor, b);
    if (!p) return null;
    const h = this.hiddenFields(actor, b);
    const merged = { ...p.fieldAccess[b.engineKey] };
    for (const k of h.header) merged[k] = 'hidden';
    for (const k of h.line) merged[`lines.${k}`] = 'hidden';
    return { ...p, fieldAccess: { ...p.fieldAccess, [b.engineKey]: merged } };
  }

  scopeFilter(actor: DocActor, typeKey: string): NodeFilter {
    return actor.perms ? this.scope.nodeFilter(actor.perms, docTab(typeKey)) : { all: true };
  }

  inScope(actor: DocActor, typeKey: string, path: string): boolean {
    return this.scope.contains(this.scopeFilter(actor, typeKey), path);
  }

  // ------------------------------------------------------------------ loading
  async loadDoc(tx: Tx, tenantId: string, id: string, opts: { lock?: boolean; typeId?: string } = {}): Promise<DocRow> {
    let q = tx.selectFrom('app.document as d').innerJoin('app.location_node as l', 'l.id', 'd.location_node_id')
      .select(DOC_COLS.map(c => `d.${c}` as const)).select([sql<string>`l.path::text`.as('loc_path'), 'l.code as loc_code', 'l.name as loc_name'])
      .where('d.tenant_id', '=', tenantId).where('d.id', '=', id).where('d.is_deleted', '=', false);
    if (opts.typeId) q = q.where('d.doc_type_id', '=', opts.typeId);
    if (opts.lock) q = q.forUpdate('d');
    const r = await q.executeTakeFirst();
    if (!r) throw AppError.notFound('Document');
    const row = r as unknown as DocRow;
    row.doc_date = dateStr(row.doc_date)!;
    row.required_by = dateStr(row.required_by);
    return row;
  }

  async loadLines(tx: Tx, tenantId: string, docId: string): Promise<LineRow[]> {
    const rows = (await tx.selectFrom('app.document_line').select([...LINE_COLS]).where('tenant_id', '=', tenantId).where('document_id', '=', docId)
      .where('is_deleted', '=', false).orderBy('line_no').execute()) as unknown as LineRow[];
    for (const r of rows) r.required_date = dateStr(r.required_date);
    return rows;
  }

  async summaries(tx: Tx, tenantId: string, lineIds: string[]): Promise<Map<string, Buckets>> {
    const out = new Map<string, Buckets>();
    if (!lineIds.length) return out;
    const rows = await tx.selectFrom('app.line_qty_summary').selectAll().where('tenant_id', '=', tenantId).where('line_id', 'in', lineIds).execute();
    for (const r of rows) out.set(r.line_id, bucketsFromRow(r as never));
    return out;
  }

  // ------------------------------------------------------------------ values
  headerValues(doc: DocRow, b: FormBundle): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(doc.custom ?? {}) };
    const set = (k: string, v: unknown) => {
      if (!b.headerSys.has(k)) return;
      if (v === null || v === undefined) delete out[k];
      else out[k] = v;
    };
    set('location', doc.location_node_id);
    set('doc_date', dateStr(doc.doc_date));
    set('required_by', dateStr(doc.required_by));
    set('party', doc.party_id);
    set('total_amount', numForField(doc.total_amount, b.headerFields.get('total_amount')));
    return out;
  }

  lineValues(l: LineRow, b: FormBundle): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(l.custom ?? {}) };
    const set = (k: string, v: unknown) => {
      if (!b.lineSys.has(k)) return;
      if (v === null || v === undefined) delete out[k];
      else out[k] = v;
    };
    set('item', l.item_id);
    set('uom', l.uom_id);
    set('qty', numForField(l.qty, b.lineFields.get('qty')));
    set('rate', numForField(l.rate, b.lineFields.get('rate')));
    set('amount', numForField(l.amount, b.lineFields.get('amount')));
    set('required_date', dateStr(l.required_date));
    set('location', l.location_node_id);
    return out;
  }

  /** Audit snapshot of a document (header values + lines). */
  snapshot(doc: DocRow, lines: LineRow[], b: FormBundle) {
    return {
      number: doc.number, status: doc.status_key, values: this.headerValues(doc, b),
      lines: lines.map(l => ({ id: l.id, lineNo: l.line_no, values: this.lineValues(l, b) })),
    };
  }

  // ------------------------------------------------------------------ ledger
  /**
   * Appends ledger events and maintains line_qty_summary in the caller's transaction (DocumentsPort.recordQuantities).
   * Summary rows are created/locked in line-id order so concurrent writers on the same lines serialise without
   * deadlocks; any bucket going negative or approvals exceeding the request is a 409 QTY_INVARIANT.
   */
  async record(tx: Tx, tenantId: string, documentId: string, events: LedgerEvent[], actorId: string | null): Promise<void> {
    if (!events.length) return;
    // Phase 4 hook (DocumentHooks.beforeRecord, agent B): a module may drop/replace events of its type first.
    if (this.hooks.hasBeforeRecordHooks) {
      const t = await tx.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select('t.key')
        .where('d.tenant_id', '=', tenantId).where('d.id', '=', documentId).executeTakeFirst();
      if (t && this.hooks.hasBeforeRecord(t.key)) {
        events = await this.hooks.runBeforeRecord(tx, { tenantId, documentId, docTypeKey: t.key, events, actorId });
        if (!events.length) return;
      }
    }
    for (const e of events) {
      if (!isQty(e.qty) || toUnits(e.qty) <= 0n) throw new AppError(400, 'VALIDATION_FAILED', `Quantity "${e.qty}" must be a positive number with at most 4 decimals.`, { lineId: e.lineId });
    }
    const lineIds = [...new Set(events.map(e => e.lineId))].sort();
    const lines = await tx.selectFrom('app.document_line').select(['id', 'document_id', 'uom_id']).where('tenant_id', '=', tenantId).where('id', 'in', lineIds)
      .where('is_deleted', '=', false).execute();
    if (lines.length !== lineIds.length || lines.some(l => l.document_id !== documentId)) throw AppError.notFound('Document line');
    // QA3-BUG-003: entered quantities (decisions, holds, selections, receipts, issues…) follow the line unit's decimals.
    // Events that move a computed remainder (cancel, unhold, short close, reversals) are exempt so old data can close.
    if (events.some(e => !REMAINDER_EVENTS.has(e.type))) {
      const rules = await uomRules(tx, tenantId, lines.map(l => l.uom_id));
      const uomOf = new Map(lines.map(l => [l.id, l.uom_id ? rules.get(l.uom_id) : undefined]));
      const off = events.filter(e => !REMAINDER_EVENTS.has(e.type) && !fitsUom(e.qty, uomOf.get(e.lineId)));
      if (off.length) {
        const first = off[0]!;
        throw new AppError(400, 'VALIDATION_FAILED', uomMessage(first.qty, uomOf.get(first.lineId)!), { lineId: first.lineId },
          off.map(e => ({ path: `lines.${e.lineId}.qty`, message: uomMessage(e.qty, uomOf.get(e.lineId)!) })));
      }
    }
    await tx.insertInto('app.line_qty_summary').values(lineIds.map(id => ({ line_id: id, tenant_id: tenantId, document_id: documentId })))
      .onConflict(oc => oc.column('line_id').doNothing()).execute();
    const rows = await tx.selectFrom('app.line_qty_summary').selectAll().where('tenant_id', '=', tenantId).where('line_id', 'in', lineIds)
      .orderBy('line_id').forUpdate().execute();
    const buckets = new Map(rows.map(r => [r.line_id, bucketsFromRow(r as never)]));
    for (const e of events) {
      const b = buckets.get(e.lineId)!;
      const bad = applyEvent(b, e.type, toUnits(e.qty));
      if (bad) throw qtyInvariant(e.lineId, bad === 'invariant' ? e.type : bad);
    }
    const inserted = await tx.insertInto('app.line_event').values(events.map(e => ({
      tenant_id: tenantId, line_id: e.lineId, document_id: documentId, event_type: e.type, qty: fromUnits(toUnits(e.qty)),
      ref_line_id: e.refLineId ?? null, wf_action_id: e.wfActionId ?? null, stage_key: e.stageKey ?? null, reason: e.reason ?? null, actor_id: actorId,
    }))).returning(['id', 'line_id']).execute();
    const last = new Map<string, bigint>();
    for (const r of inserted) {
      const id = BigInt(r.id);
      if ((last.get(r.line_id) ?? 0n) < id) last.set(r.line_id, id);
    }
    for (const id of lineIds) {
      const b = buckets.get(id)!;
      const set: Record<string, string> = {};
      for (const k of BUCKETS) set[k] = fromUnits(b[k]);
      await tx.updateTable('app.line_qty_summary').set({ ...set, last_event_id: last.get(id)?.toString() ?? null, updated_at: new Date() } as never)
        .where('tenant_id', '=', tenantId).where('line_id', '=', id).execute();
    }
    // Phase 4 hook (DocumentHooks.onLineOutcome): other modules react to approvals/rejections/cancellations.
    if (this.hooks.hasLineOutcomeHooks && events.some(e => OUTCOME_EVENT_TYPES.has(e.type))) {
      const t = await tx.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select('t.key')
        .where('d.tenant_id', '=', tenantId).where('d.id', '=', documentId).executeTakeFirst();
      if (t) await this.hooks.runLineOutcome(tx, { tenantId, documentId, docTypeKey: t.key, events, actorId });
    }
  }

  /** Remaining quantity per line still in approval (pending + held), from the summaries. */
  async remaining(tx: Tx, tenantId: string, lineIds: string[]): Promise<Map<string, { pending: bigint; held: bigint }>> {
    const sums = await this.summaries(tx, tenantId, lineIds);
    return new Map(lineIds.map(id => {
      const b = sums.get(id) ?? emptyBuckets();
      const p = pendingApproval(b);
      return [id, { pending: p < 0n ? 0n : p, held: b.held < 0n ? 0n : b.held }];
    }));
  }

  /** Events that take every remaining quantity of the lines out of approval: unheld held qty, then cancelled. */
  async cancelRemaining(tx: Tx, tenantId: string, documentId: string, lineIds: string[], reason: string, actorId: string | null): Promise<number> {
    const rem = await this.remaining(tx, tenantId, lineIds);
    const events: LedgerEvent[] = [];
    for (const id of lineIds) {
      const r = rem.get(id)!;
      if (r.held > 0n) events.push({ lineId: id, type: 'unheld', qty: fromUnits(r.held), reason });
      if (r.pending > 0n) events.push({ lineId: id, type: 'cancelled', qty: fromUnits(r.pending), reason });
    }
    await this.record(tx, tenantId, documentId, events, actorId);
    return events.filter(e => e.type === 'cancelled').length;
  }

  // ------------------------------------------------------------------ status
  /**
   * Recomputes line + document status keys from the ledger, the workflow line state and explicit states
   * (cancelled/closed). A changed document status is audited and emitted (document.status_changed).
   */
  async recompute(tx: Tx, tenantId: string, documentId: string, actorId: string | null = null): Promise<{ statusKey: string; changed: boolean }> {
    const doc = await this.loadDoc(tx, tenantId, documentId);
    const lines = await this.loadLines(tx, tenantId, documentId);
    if (doc.status_key === 'draft') {
      for (const l of lines) if (l.status_key !== 'draft') await this.setLineStatus(tx, tenantId, l.id, 'draft');
      return { statusKey: 'draft', changed: false };
    }
    const [sums, stages, info] = await Promise.all([
      this.summaries(tx, tenantId, lines.map(l => l.id)), this.wf.lineStages(tx, documentId), this.types.stageInfo(tx, doc.doc_type_id),
    ]);
    const statuses: string[] = [];
    for (const l of lines) {
      const st: Record<string, { pending: bigint; held: bigint }> = {};
      for (const [k, v] of Object.entries(stages[l.id] ?? {})) st[k] = { pending: toUnits(v.pending), held: toUnits(v.held) };
      const s = lineStatus({ buckets: sums.get(l.id) ?? emptyBuckets(), stages: st }, info.order, !!doc.closed_at);
      statuses.push(s);
    }
    let next = documentStatus({ submitted: true, cancelled: !!doc.cancelled_at, closed: !!doc.closed_at }, statuses, info.order);
    // Phase 5 hook (DocumentHooks.statusRule, GRN agent): a module may refine statuses (e.g. PO partially_received).
    if (this.hooks.hasStatusRules) {
      const t = await this.types.loadById(tx, tenantId, doc.doc_type_id);
      const r = await this.hooks.runStatusRule(tx, {
        tenantId, documentId, docTypeKey: t.key, statusKey: next, lines: lines.map((l, i) => ({ id: l.id, statusKey: statuses[i]!, buckets: sums.get(l.id) ?? emptyBuckets() })),
      });
      if (r) {
        lines.forEach((l, i) => { if (r.lines[l.id]) statuses[i] = r.lines[l.id]!; });
        next = r.statusKey;
      }
    }
    for (const [i, l] of lines.entries()) if (statuses[i] !== l.status_key) await this.setLineStatus(tx, tenantId, l.id, statuses[i]!);
    if (next === doc.status_key) return { statusKey: next, changed: false };
    await tx.updateTable('app.document').set({ status_key: next }).where('tenant_id', '=', tenantId).where('id', '=', documentId).execute();
    const from = doc.status_key === 'submitted' ? 'draft' : doc.status_key;
    const type = await this.types.loadById(tx, tenantId, doc.doc_type_id);
    await this.audit.tenant(tx, {
      action: 'status', entity: DOCUMENT_ENTITY, entityId: documentId, actorId,
      before: { status: from, label: statusLabel(from, info.labels) }, after: { status: next, label: statusLabel(next, info.labels), number: doc.number },
    });
    await this.emit(tx, 'document.status_changed', { kind: DOCUMENT_ENTITY, id: documentId }, { documentId, docTypeKey: type.key, number: doc.number, from, to: next });
    return { statusKey: next, changed: true };
  }

  private async setLineStatus(tx: Tx, tenantId: string, lineId: string, status: string) {
    await tx.updateTable('app.document_line').set({ status_key: status }).where('tenant_id', '=', tenantId).where('id', '=', lineId).execute();
  }

  // ------------------------------------------------------------------ outbox
  async emit(tx: Tx, eventType: string, aggregate: { kind: string; id: string | null }, payload: Record<string, unknown>) {
    await tx.insertInto('app.outbox_event').values({
      event_type: eventType, aggregate_kind: aggregate.kind, aggregate_id: aggregate.id, payload: JSON.stringify(payload),
    }).execute();
  }

  settings(type: DocTypeRow) {
    return settingsOf(type);
  }
}

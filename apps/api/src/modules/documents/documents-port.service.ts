import { Injectable } from '@nestjs/common';
import type { DocumentRow, MyPermissions } from '@procure/schema';
import { sql } from 'kysely';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import type { DocumentSnapshot, DocumentsPort, LedgerEvent } from '../../core/ports';
import { isLookup, kindOfSource, RecordEngine } from '../forms';
import { DocumentsService } from './documents.service';
import { DocStore } from './store';
import { DOCUMENT_ENTITY } from './types';

/**
 * DOCUMENTS_PORT (core/ports.ts) for the workflow engine and later modules. Every method works inside the caller's
 * tenant transaction; the tenant is the one in the transaction context.
 */
@Injectable()
export class DocumentsPortService implements DocumentsPort {
  constructor(private readonly store: DocStore, private readonly docs: DocumentsService, private readonly engine: RecordEngine, private readonly audit: AuditService) {}

  private async tenant(tx: Tx): Promise<string> {
    const r = await sql<{ t: string | null }>`select app.current_tenant_id()::text as t`.execute(tx);
    const t = r.rows[0]?.t;
    if (!t) throw new Error('DocumentsPort needs a tenant transaction');
    return t;
  }

  async snapshot(tx: Tx, documentId: string, opts: { lock?: boolean } = {}): Promise<DocumentSnapshot> {
    const tid = await this.tenant(tx);
    const doc = await this.store.loadDoc(tx, tid, documentId, { lock: opts.lock ?? true });
    const type = await this.store.types.loadById(tx, tid, doc.doc_type_id);
    const b = await this.store.bundleFor(tx, tid, type, doc);
    const lines = await this.store.loadLines(tx, tid, documentId);
    const sums = await this.store.summaries(tx, tid, lines.map(l => l.id));
    const values = this.store.headerValues(doc, b);
    const lineValues = new Map(lines.map(l => [l.id, this.store.lineValues(l, b)]));
    // Lookup attributes (code, name, data) for routing formulas, like the forms engine builds them.
    const wanted: { id: string; kind: ReturnType<typeof kindOfSource> }[] = [];
    const headerLookups = [...b.headerFields.values()].filter(f => f.type === 'lookup' && !f.removed);
    const lineLookups = [...b.lineFields.values()].filter(f => f.type === 'lookup' && !f.removed);
    for (const f of headerLookups) if (isLookup(f) && typeof values[f.key] === 'string') wanted.push({ id: values[f.key] as string, kind: kindOfSource(f) });
    for (const v of lineValues.values()) for (const f of lineLookups) if (isLookup(f) && typeof v[f.key] === 'string') wanted.push({ id: v[f.key] as string, kind: kindOfSource(f) });
    const targets = await this.engine.loadTargets(tx, tid, wanted);
    const attrs = (id: unknown) => (typeof id === 'string' && targets.get(id) ? { ...targets.get(id)!.attrs } : null);
    return {
      id: doc.id, tenantId: tid, docTypeId: doc.doc_type_id, docTypeKey: type.key, number: doc.number, statusKey: doc.status_key === 'submitted' ? 'draft' : doc.status_key,
      locationNodeId: doc.location_node_id, locationPath: doc.loc_path, createdBy: doc.created_by, submittedBy: doc.submitted_by, values,
      lines: lines.map(l => {
        const s = sums.get(l.id);
        const live = s ? s.requested + s.over_approved : 0n;
        return { id: l.id, lineNo: l.line_no, qty: this.qty(l.qty), values: lineValues.get(l.id)!, isCancelled: !!l.cancelled_reason && (!s || s.cancelled >= live) };
      }),
      lookups: Object.fromEntries(headerLookups.map(f => [f.key, attrs(values[f.key])])),
      lineLookups: Object.fromEntries(lines.map(l => [l.id, Object.fromEntries(lineLookups.map(f => [f.key, attrs(lineValues.get(l.id)![f.key])]))])),
      version: doc.version,
    };
  }

  private qty(v: string) {
    const [i, d = ''] = String(v).split('.');
    const frac = d.replace(/0+$/, '');
    return frac ? `${i}.${frac}` : i!;
  }

  async recordQuantities(tx: Tx, documentId: string, events: LedgerEvent[], actorId: string | null): Promise<void> {
    await this.store.record(tx, await this.tenant(tx), documentId, events, actorId);
  }

  async recomputeStatus(tx: Tx, documentId: string): Promise<{ statusKey: string; changed: boolean }> {
    return this.store.recompute(tx, await this.tenant(tx), documentId);
  }

  async setLocked(tx: Tx, documentId: string, locked: boolean): Promise<void> {
    const tid = await this.tenant(tx);
    const doc = await this.store.loadDoc(tx, tid, documentId);
    if (doc.is_locked === locked) return;
    await tx.updateTable('app.document').set({ is_locked: locked }).where('tenant_id', '=', tid).where('id', '=', documentId).execute();
    await this.audit.tenant(tx, { action: locked ? 'lock' : 'unlock', entity: DOCUMENT_ENTITY, entityId: documentId, before: { isLocked: doc.is_locked }, after: { isLocked: locked } });
  }

  async close(tx: Tx, documentId: string, reason: string, actorId: string | null): Promise<void> {
    const tid = await this.tenant(tx);
    const doc = await this.store.loadDoc(tx, tid, documentId, { lock: true });
    if (doc.closed_at || doc.cancelled_at) return;
    const type = await this.store.types.loadById(tx, tid, doc.doc_type_id);
    await this.docs.closeDoc(tx, tid, type, doc, null, reason, actorId);
  }

  /** Send back to the creator: remaining approval quantity leaves the ledger (cancelled), the document is a draft again. */
  async returnToDraft(tx: Tx, documentId: string, actorId: string | null, reason: string): Promise<void> {
    const tid = await this.tenant(tx);
    const doc = await this.store.loadDoc(tx, tid, documentId, { lock: true });
    if (doc.status_key === 'draft') return;
    const lines = await this.store.loadLines(tx, tid, documentId);
    await this.store.cancelRemaining(tx, tid, documentId, lines.map(l => l.id), reason, actorId);
    await tx.updateTable('app.document').set({ status_key: 'draft', is_locked: false, updated_by: actorId }).where('tenant_id', '=', tid).where('id', '=', documentId).execute();
    await this.store.recompute(tx, tid, documentId, actorId);
    const type = await this.store.types.loadById(tx, tid, doc.doc_type_id);
    await this.audit.tenant(tx, { action: 'return_to_draft', entity: DOCUMENT_ENTITY, entityId: documentId, actorId, before: { status: doc.status_key }, after: { status: 'draft', reason } });
    await this.store.emit(tx, 'document.status_changed', { kind: DOCUMENT_ENTITY, id: documentId }, { documentId, docTypeKey: type.key, number: doc.number, from: doc.status_key, to: 'draft', reason });
  }

  async applyLineEdits(
    tx: Tx, documentId: string, edits: { lineId: string; values: Record<string, unknown> }[], allowedFields: string[],
    actor?: { userId: string | null; perms: MyPermissions | undefined },
  ): Promise<void> {
    if (!edits.length) return;
    const tid = await this.tenant(tx);
    for (const e of edits) {
      for (const k of Object.keys(e.values)) {
        if (!allowedFields.includes(k)) throw new AppError(403, 'FIELD_READ_ONLY', `You are not allowed to change "${k}".`, { field: k, lineId: e.lineId });
        if (k === 'qty') throw AppError.conflict('Quantities change through decisions, not edits.');
      }
    }
    await this.docs.applyLineEdits(tx, tid, documentId, edits, actor ? { userId: actor.userId, perms: actor.perms ?? null } : undefined);
  }

  /**
   * DOCUMENT_ROW_READER (optional hook of the workflow module): the canonical DocumentRow after a workflow action,
   * for the acting viewer. No status-view check — an approver may have just moved the document out of their views.
   */
  async documentRow(tx: Tx, documentId: string, viewer: { userId: string; perms: MyPermissions | undefined }): Promise<DocumentRow> {
    const tid = await this.tenant(tx);
    const doc = await this.store.loadDoc(tx, tid, documentId);
    const type = await this.store.types.loadById(tx, tid, doc.doc_type_id);
    const perms = viewer.perms ?? { keys: [], scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 };
    return this.docs.toRow(tx, { tenantId: tid, userId: viewer.userId, perms }, type, doc);
  }

  async emit(tx: Tx, eventType: string, aggregate: { kind: string; id: string | null }, payload: Record<string, unknown>): Promise<void> {
    await this.store.emit(tx, eventType, aggregate, payload);
  }
}

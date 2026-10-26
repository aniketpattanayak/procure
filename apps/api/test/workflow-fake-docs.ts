/**
 * Minimal DocumentsPort over the real Phase 3 tables, for workflow tests while (or where) the documents module's
 * own port is not used. Implements the frozen contract semantics the engine relies on: snapshot (FOR UPDATE),
 * ledger + summary with the QTY_INVARIANT checks, status recompute per the contract, lock/close/return-to-draft,
 * line edits, outbox.
 */
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import type { Tx } from '../src/core/db.service';
import { AppError } from '../src/core/errors';
import type { DocumentSnapshot, DocumentsPort, LedgerEvent } from '../src/core/ports';

const BUCKET: Record<string, { col: string; sign: 1 | -1 }> = {
  requested: { col: 'requested', sign: 1 }, approved: { col: 'approved', sign: 1 }, held: { col: 'held', sign: 1 },
  unheld: { col: 'held', sign: -1 }, rejected: { col: 'rejected', sign: 1 }, cancelled: { col: 'cancelled', sign: 1 },
};
const D = (v: unknown) => new Decimal((v as string | number | null) ?? 0);

export class FakeDocumentsPort implements DocumentsPort {
  async snapshot(tx: Tx, documentId: string, opts: { lock?: boolean } = {}): Promise<DocumentSnapshot> {
    let q = tx.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').innerJoin('app.location_node as n', 'n.id', 'd.location_node_id')
      .select(['d.id', 'd.tenant_id', 'd.doc_type_id', 't.key', 'd.number', 'd.status_key', 'd.location_node_id', sql<string>`n.path::text`.as('path'), 'd.created_by', 'd.submitted_by',
        'd.custom', 'd.total_amount', 'd.doc_date', 'd.version'])
      .where('d.id', '=', documentId).where('d.is_deleted', '=', false);
    if (opts.lock) q = q.forUpdate('d');
    const d = await q.executeTakeFirst();
    if (!d) throw AppError.notFound('Document');
    const lines = await tx.selectFrom('app.document_line').select(['id', 'line_no', 'qty', 'rate', 'amount', 'custom', 'status_key'])
      .where('document_id', '=', documentId).where('is_deleted', '=', false).orderBy('line_no').execute();
    return {
      id: d.id, tenantId: d.tenant_id, docTypeId: d.doc_type_id, docTypeKey: d.key, number: d.number, statusKey: d.status_key,
      locationNodeId: d.location_node_id, locationPath: d.path, createdBy: d.created_by, submittedBy: d.submitted_by,
      values: { ...(d.custom as Record<string, unknown>), location: d.location_node_id, total_amount: d.total_amount, doc_date: d.doc_date },
      lines: lines.map(l => ({
        id: l.id, lineNo: l.line_no, qty: D(l.qty).toFixed(), isCancelled: l.status_key === 'cancelled',
        values: { ...(l.custom as Record<string, unknown>), qty: D(l.qty).toFixed(), rate: l.rate, amount: l.amount },
      })),
      lookups: {}, lineLookups: {}, version: d.version,
    };
  }

  async recordQuantities(tx: Tx, documentId: string, events: LedgerEvent[], actorId: string | null): Promise<void> {
    for (const lineId of [...new Set(events.map(e => e.lineId))].sort()) {
      await tx.insertInto('app.line_qty_summary').values({ line_id: lineId, document_id: documentId }).onConflict(oc => oc.column('line_id').doNothing()).execute();
      await tx.selectFrom('app.line_qty_summary').select('line_id').where('line_id', '=', lineId).forUpdate().execute();
    }
    for (const e of events) {
      const b = BUCKET[e.type];
      if (!b) throw new Error(`fake port: unsupported event ${e.type}`);
      const ev = await tx.insertInto('app.line_event').values({
        line_id: e.lineId, document_id: documentId, event_type: e.type, qty: e.qty, ref_line_id: e.refLineId ?? null,
        wf_action_id: e.wfActionId ?? null, stage_key: e.stageKey ?? null, reason: e.reason ?? null, actor_id: actorId,
      }).returning('id').executeTakeFirstOrThrow();
      const s = await tx.selectFrom('app.line_qty_summary').selectAll().where('line_id', '=', e.lineId).executeTakeFirstOrThrow() as unknown as Record<string, string>;
      const next = D(s[b.col]).plus(D(e.qty).times(b.sign));
      if (next.lt(0)) throw new AppError(409, 'QTY_INVARIANT', `bucket ${b.col} would go negative`, { lineId: e.lineId, bucket: b.col });
      const after = { ...s, [b.col]: next.toFixed() };
      if (D(after.approved).plus(D(after.rejected)).plus(D(after.cancelled)).gt(D(after.requested).plus(D(after.over_approved)))) {
        throw new AppError(409, 'QTY_INVARIANT', 'approved + rejected + cancelled > requested', { lineId: e.lineId, bucket: b.col });
      }
      await tx.updateTable('app.line_qty_summary').set({ [b.col]: next.toFixed(), last_event_id: ev.id, updated_at: new Date() } as never).where('line_id', '=', e.lineId).execute();
    }
  }

  async recomputeStatus(tx: Tx, documentId: string): Promise<{ statusKey: string; changed: boolean }> {
    const d = await tx.selectFrom('app.document').select(['status_key', 'submitted_at', 'cancelled_at', 'closed_at', 'doc_type_id']).where('id', '=', documentId).executeTakeFirstOrThrow();
    const order = await this.stageOrder(tx, d.doc_type_id);
    const lines = await tx.selectFrom('app.document_line as l').leftJoin('app.line_qty_summary as q', 'q.line_id', 'l.id')
      .select(['l.id', 'l.status_key', 'q.requested', 'q.approved', 'q.rejected', 'q.cancelled', 'q.held'])
      .where('l.document_id', '=', documentId).where('l.is_deleted', '=', false).execute();
    const ws = await tx.selectFrom('app.wf_line_state as s').innerJoin('app.wf_instance as i', 'i.id', 's.instance_id')
      .select(['s.line_id', 's.stage_key', 's.pending_qty', 's.held_qty']).where('i.document_id', '=', documentId).where('i.status', '=', 'running').execute();
    const rank = (s: string) => (order.includes(s) ? order.indexOf(s) : 999);
    const statuses: string[] = [];
    for (const l of lines) {
      let st: string;
      if (!d.submitted_at) st = 'draft';
      else {
        const mine = ws.filter(w => w.line_id === l.id);
        const pend = mine.filter(w => D(w.pending_qty).gt(0)).map(w => w.stage_key).sort((a, b) => rank(a) - rank(b));
        if (pend.length) st = `waiting_${pend[0]}`;
        else if (mine.some(w => D(w.held_qty).gt(0))) st = 'on_hold';
        else if (D(l.requested).gt(0) && D(l.cancelled).gte(D(l.requested))) st = 'cancelled';
        else if (D(l.approved).isZero()) st = 'rejected';
        else if (D(l.approved).lt(D(l.requested).minus(D(l.cancelled)))) st = 'partially_approved';
        else st = 'approved';
      }
      statuses.push(st);
      if (st !== l.status_key) await tx.updateTable('app.document_line').set({ status_key: st }).where('id', '=', l.id).execute();
    }
    let doc: string;
    if (!d.submitted_at) doc = 'draft';
    else {
      const waiting = statuses.filter(s => s.startsWith('waiting_')).map(s => s.slice(8)).sort((a, b) => rank(a) - rank(b));
      const live = statuses.filter(s => s !== 'cancelled');
      if (waiting.length) doc = `waiting_${waiting[0]}`;
      else if (statuses.includes('on_hold')) doc = 'on_hold';
      else if (d.cancelled_at) doc = 'cancelled';
      else if (d.closed_at) doc = 'closed';
      else if (!live.length) doc = 'cancelled';
      else if (live.every(s => s === 'approved')) doc = 'approved';
      else if (live.every(s => s === 'rejected')) doc = 'rejected';
      else doc = 'partially_approved';
    }
    const changed = doc !== d.status_key;
    if (changed) await tx.updateTable('app.document').set({ status_key: doc }).where('id', '=', documentId).execute();
    return { statusKey: doc, changed };
  }

  private async stageOrder(tx: Tx, docTypeId: string): Promise<string[]> {
    const r = await tx.selectFrom('app.workflow_def as w').innerJoin('app.workflow_version as v', 'v.id', 'w.current_version_id')
      .select('v.definition').where('w.doc_type_id', '=', docTypeId).executeTakeFirst();
    const def = (typeof r?.definition === 'string' ? JSON.parse(r.definition) : r?.definition) as { stages?: { key: string }[] } | undefined;
    return (def?.stages ?? []).map(s => s.key);
  }

  async setLocked(tx: Tx, documentId: string, locked: boolean) {
    await tx.updateTable('app.document').set({ is_locked: locked }).where('id', '=', documentId).execute();
  }

  async close(tx: Tx, documentId: string, reason: string) {
    await tx.updateTable('app.document').set({ closed_at: new Date(), closed_reason: reason, status_key: 'closed' }).where('id', '=', documentId).execute();
  }

  async returnToDraft(tx: Tx, documentId: string) {
    await tx.updateTable('app.document').set({ status_key: 'draft', is_locked: false, submitted_at: null, submitted_by: null }).where('id', '=', documentId).execute();
    await tx.updateTable('app.document_line').set({ status_key: 'draft' }).where('document_id', '=', documentId).execute();
  }

  async applyLineEdits(tx: Tx, _documentId: string, edits: { lineId: string; values: Record<string, unknown> }[], allowed: string[]) {
    for (const e of edits) {
      const row = await tx.selectFrom('app.document_line').select('custom').where('id', '=', e.lineId).executeTakeFirstOrThrow();
      const custom = { ...(row.custom as Record<string, unknown>) };
      for (const [k, v] of Object.entries(e.values)) if (allowed.includes(k)) custom[k] = v;
      await tx.updateTable('app.document_line').set({ custom: JSON.stringify(custom) }).where('id', '=', e.lineId).execute();
    }
  }

  async emit(tx: Tx, eventType: string, aggregate: { kind: string; id: string | null }, payload: Record<string, unknown>) {
    await tx.insertInto('app.outbox_event').values({ event_type: eventType, aggregate_kind: aggregate.kind, aggregate_id: aggregate.id, payload: JSON.stringify(payload) }).execute();
  }
}

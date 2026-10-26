import { Injectable } from '@nestjs/common';
import { DocumentRow } from '@procure/schema';
import { AuditService } from '../../../core/audit.service';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import type { LedgerEvent } from '../../../core/ports';
import { type DocActor, DocStore, DocumentsService, fromUnits } from '../../documents';
import { getTenantSetting } from '../../identity';
import { INDENT } from '../installer/a-steps';
import { IndentLines, orderableFromIndent, selectable } from './indent-lines';

/**
 * POST /docs/indent/:id/short-close — writes `short_closed` for the remainder nobody will act on any more: the
 * unselected approved quantity (vendor selection on) or the unordered one (selection off). Quantity still waiting
 * for approval must be cancelled first.
 */
@Injectable()
export class IndentShortCloseService {
  constructor(private readonly docs: DocumentsService, private readonly store: DocStore, private readonly lines: IndentLines, private readonly audit: AuditService) {}

  async shortClose(tx: Tx, actor: DocActor, id: string, input: { reason: string; lineIds?: string[] }): Promise<DocumentRow> {
    const type = await this.docs.typeFor(tx, actor, INDENT);
    const doc = await this.docs.access(tx, actor, type, id, true);
    if (doc.status_key === 'draft' || doc.status_key === 'submitted') throw AppError.conflict('Drafts cannot be short-closed.');
    if (doc.cancelled_at || doc.closed_at) throw AppError.conflict('This indent is already cancelled or closed.');
    const all = await this.store.loadLines(tx, actor.tenantId, id);
    const ids = input.lineIds?.length ? [...new Set(input.lineIds)] : all.map(l => l.id);
    for (const lid of ids) if (!all.some(l => l.id === lid)) throw AppError.notFound('Document line');
    const loaded = await this.lines.load(tx, actor, ids, { lockSummaries: true, scopeCheck: false });
    const selectionOn = await getTenantSetting(tx, 'flow.vendor_selection.enabled');
    const events: LedgerEvent[] = [];
    const pendingApproval: number[] = [];
    for (const lid of ids) {
      const l = loaded.get(lid)!;
      const b = l.buckets;
      if (b.requested - b.approved - b.rejected - b.cancelled > 0n) pendingApproval.push(l.lineNo);
      const rest = selectionOn ? selectable(b) : orderableFromIndent(b);
      if (rest > 0n) events.push({ lineId: lid, type: 'short_closed', qty: fromUnits(rest), reason: input.reason });
    }
    if (pendingApproval.length && input.lineIds?.length) {
      throw AppError.conflict(`Line(s) ${pendingApproval.join(', ')} still have quantity waiting for approval. Cancel it before short-closing.`, { lineNos: pendingApproval });
    }
    if (!events.length) throw AppError.conflict('Nothing is left to short-close on this indent.');
    await this.store.record(tx, actor.tenantId, id, events, actor.userId);
    await this.store.recompute(tx, actor.tenantId, id, actor.userId);
    const lineNos = events.map(e => loaded.get(e.lineId)!.lineNo);
    await this.audit.tenant(tx, { action: 'short_close', entity: 'document', entityId: id, actorId: actor.userId, after: { reason: input.reason, lines: events.map((e, i) => ({ lineNo: lineNos[i], qty: e.qty })) } });
    await this.store.emit(tx, 'document.short_closed', { kind: 'document', id }, {
      documentId: id, docTypeKey: INDENT, number: doc.number, reason: input.reason, lines: events.map(e => ({ lineId: e.lineId, qty: e.qty })),
    });
    return this.docs.detail(tx, actor, INDENT, id);
  }
}

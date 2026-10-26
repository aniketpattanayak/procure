import { Injectable } from '@nestjs/common';
import { DocumentRow } from '@procure/schema';
import { z } from 'zod';
import { AuditService } from '../../../core/audit.service';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import type { LedgerEvent } from '../../../core/ports';
import { type DocActor, DocStore, DocumentsService, docAction, fromUnits } from '../../documents';
import { GRN } from './grn.types';

export const GrnShortCloseInput = z.object({
  reason: z.string().trim().min(3).max(500),
  lineIds: z.array(z.string().uuid()).max(1000).optional(),
});

/**
 * POST /inventory/grn/:id/short-close — closes GRN lines whose received quantity is still in the approval
 * pipeline (received but not yet accepted or rejected). A fully accepted/rejected GRN cannot be short-closed.
 * Only lines that still have pending-approval quantity are eligible.
 */
@Injectable()
export class GrnShortCloseService {
  constructor(
    private readonly docs: DocumentsService,
    private readonly store: DocStore,
    private readonly audit: AuditService,
  ) {}

  async shortClose(tx: Tx, actor: DocActor, id: string, input: z.infer<typeof GrnShortCloseInput>): Promise<DocumentRow> {
    if (actor.perms && !actor.perms.keys.includes(docAction(GRN, 'short_close'))) throw AppError.forbidden();
    const type = await this.docs.typeFor(tx, actor, GRN);
    const doc = await this.docs.access(tx, actor, type, id, true);
    if (['draft', 'submitted'].includes(doc.status_key)) throw AppError.conflict('Only approved GRNs can be short-closed.');
    if (doc.cancelled_at || doc.closed_at) throw AppError.conflict('This GRN is already cancelled or closed.');

    const all = await this.store.loadLines(tx, actor.tenantId, id);
    const ids = input.lineIds?.length ? [...new Set(input.lineIds)] : all.map(l => l.id);
    for (const lid of ids) {
      if (!all.some(l => l.id === lid)) throw AppError.notFound('Document line');
    }

    const sums = await this.store.summaries(tx, actor.tenantId, ids);
    const events: LedgerEvent[] = [];

    for (const lid of ids) {
      const b = sums.get(lid);
      if (!b) continue;
      // Pending in pipeline = received - accepted - rejected_at_receipt
      const pending = b.received - b.accepted - b.rejected_at_receipt;
      if (pending <= 0n) continue;
      events.push({ lineId: lid, type: 'short_closed', qty: fromUnits(pending), reason: input.reason });
    }

    if (!events.length) throw AppError.conflict('Nothing is left to short-close on this GRN. All received quantities have already been accepted or rejected.');

    await this.store.record(tx, actor.tenantId, id, events, actor.userId);
    await this.store.recompute(tx, actor.tenantId, id, actor.userId);

    const lineNos = events.map(e => all.find(l => l.id === e.lineId)?.line_no ?? '?');
    await this.audit.tenant(tx, {
      action: 'short_close',
      entity: 'document',
      entityId: id,
      actorId: actor.userId,
      after: {
        reason: input.reason,
        lines: events.map((e, i) => ({ lineNo: lineNos[i], qty: e.qty })),
      },
    });

    await this.store.emit(tx, 'document.short_closed', { kind: 'document', id }, {
      documentId: id,
      docTypeKey: GRN,
      number: doc.number,
      reason: input.reason,
      lines: events.map(e => ({ lineId: e.lineId, qty: e.qty })),
    });

    return this.docs.detail(tx, actor, GRN, id);
  }
}

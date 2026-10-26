import { Injectable } from '@nestjs/common';
import type { FollowupInput, FollowupRow } from '@procure/schema';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit.service';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { dateStr, docAction, DocActor, DocStore, DocumentsService } from '../../documents';
import { jsonPatch, PoDerived } from '../po/po-derived';
import { LINE_RESERVED, PO, RESERVED } from '../po/po.type';

type Input = z.infer<typeof FollowupInput>;

/**
 * PO follow-ups (contract "Follow-ups"): an append-only log of conversations with the vendor. A follow-up with
 * `revisedExpectedDate` moves the PO's (or one line's) expected date; the previous value is kept on the row, so the
 * log is the full expected-date history (previous → new, reason, who, when).
 */
@Injectable()
export class FollowupsService {
  constructor(
    private readonly docs: DocumentsService,
    private readonly store: DocStore,
    private readonly derived: PoDerived,
    private readonly audit: AuditService,
  ) {}

  async list(tx: Tx, actor: DocActor, id: string): Promise<FollowupRow[]> {
    const type = await this.docs.typeFor(tx, actor, PO);
    await this.docs.access(tx, actor, type, id);
    return this.rows(tx, actor.tenantId, id);
  }

  private async rows(tx: Tx, tenantId: string, docId: string, onlyId?: string): Promise<FollowupRow[]> {
    let q = tx.selectFrom('app.po_followup as f').leftJoin('app.document_line as l', 'l.id', 'f.line_id').leftJoin('app.tenant_user as u', 'u.id', 'f.created_by')
      .select(['f.id', 'f.line_id', 'l.line_no', 'f.contact_mode', 'f.contact_person', 'f.promised_date', 'f.revised_expected_date', 'f.reason', 'f.notes',
        'f.created_at', 'f.created_by', 'u.name as user_name'])
      .where('f.tenant_id', '=', tenantId).where('f.document_id', '=', docId);
    if (onlyId) q = q.where('f.id', '=', onlyId);
    const rows = await q.orderBy('f.created_at', 'desc').orderBy('f.id', 'desc').execute();
    const prev = await this.previous(tx, tenantId, rows.map(r => r.id));
    return rows.map(r => ({
      id: r.id, lineId: r.line_id, lineNo: r.line_no ?? null, contactMode: r.contact_mode, contactPerson: r.contact_person,
      promisedDate: dateStr(r.promised_date), revisedExpectedDate: dateStr(r.revised_expected_date), previousExpectedDate: prev.get(r.id) ?? null,
      reason: r.reason, notes: r.notes, createdAt: new Date(r.created_at).toISOString(), createdBy: { id: r.created_by, name: r.user_name ?? '' },
    }));
  }

  /** previous expected date of each follow-up, from its audit row (the table itself has no column for it). */
  private async previous(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const rows = await tx.selectFrom('app.audit_log').select(['entity_id', 'after']).where('tenant_id', '=', tenantId).where('entity', '=', 'po_followup')
      .where('entity_id', 'in', ids).execute();
    return new Map(rows.map(r => [String(r.entity_id), ((r.after ?? {}) as Record<string, unknown>).previousExpectedDate as string | null ?? null]));
  }

  async log(tx: Tx, actor: DocActor, id: string, input: Input): Promise<FollowupRow> {
    const type = await this.docs.typeFor(tx, actor, PO);
    if (actor.perms && !actor.perms.keys.includes(docAction(PO, 'followup'))) throw AppError.forbidden();
    const doc = await this.docs.access(tx, actor, type, id, true);
    if (['draft', 'submitted'].includes(doc.status_key) || !doc.number) throw AppError.conflict('Follow-ups are logged on submitted purchase orders.');
    if (doc.cancelled_at || doc.closed_at) throw AppError.conflict('This purchase order is cancelled or closed.');
    let line: { id: string; custom: Record<string, unknown> } | null = null;
    if (input.lineId) {
      const l = await tx.selectFrom('app.document_line').select(['id', 'custom']).where('tenant_id', '=', actor.tenantId).where('document_id', '=', id)
        .where('id', '=', input.lineId).where('is_deleted', '=', false).executeTakeFirst();
      if (!l) throw AppError.notFound('Document line');
      line = { id: l.id, custom: (l.custom ?? {}) as Record<string, unknown> };
    }
    const previousExpectedDate = input.revisedExpectedDate ? ((line ? line.custom.expected_date : doc.custom.expected_date) as string | undefined) ?? null : null;
    const row = await tx.insertInto('app.po_followup').values({
      tenant_id: actor.tenantId, document_id: id, line_id: input.lineId ?? null, contact_mode: input.contactMode, contact_person: input.contactPerson ?? null,
      promised_date: input.promisedDate ?? null, revised_expected_date: input.revisedExpectedDate ?? null, reason: input.reason ?? null, notes: input.notes ?? null,
      created_by: actor.userId!,
    }).returning('id').executeTakeFirstOrThrow();
    if (input.revisedExpectedDate) {
      if (line) {
        await tx.updateTable('app.document_line').set({ custom: jsonPatch('custom', { [LINE_RESERVED.revisedExpected]: input.revisedExpectedDate }) })
          .where('tenant_id', '=', actor.tenantId).where('id', '=', line.id).execute();
      } else {
        await tx.updateTable('app.document').set({ custom: jsonPatch('custom', { [RESERVED.revisedExpected]: input.revisedExpectedDate }) })
          .where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
      }
      await this.derived.refresh(tx, actor.tenantId, id);
    }
    await this.audit.tenant(tx, {
      action: 'create', entity: 'po_followup', entityId: row.id, actorId: actor.userId,
      after: { documentId: id, lineId: input.lineId ?? null, contactMode: input.contactMode, revisedExpectedDate: input.revisedExpectedDate ?? null, previousExpectedDate, reason: input.reason ?? null },
    });
    await this.store.emit(tx, 'po.followup_logged', { kind: 'document', id }, {
      documentId: id, docTypeKey: PO, number: doc.number, followupId: row.id, lineId: input.lineId ?? null, contactMode: input.contactMode,
      promisedDate: input.promisedDate ?? null, revisedExpectedDate: input.revisedExpectedDate ?? null, previousExpectedDate, vendorId: doc.party_id,
    });
    return (await this.rows(tx, actor.tenantId, id, row.id))[0]!;
  }
}

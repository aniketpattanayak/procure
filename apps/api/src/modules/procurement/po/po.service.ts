import { Injectable, OnModuleInit } from '@nestjs/common';
import type { DocumentRow, TaxLine } from '@procure/schema';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { AuditService } from '../../../core/audit.service';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import type { LedgerEvent } from '../../../core/ports';
import { docAction, DocActor, DocStore, DocumentsService, fromUnits, pendingReceiptUnits } from '../../documents';
import { getTenantSetting } from '../../identity';
import type { InstallContext } from '../installer/install-steps';
import { ProcurementInstaller } from '../installer/installer.service';
import { SystemTypeInstaller } from '../installer/system-type';
import { TaxInstallStep } from '../tax/tax.install';
import { PoLedger } from './po-ledger';
import { AMENDING, PO, PO_SPEC, TOTAL_FIELDS } from './po.type';

export const ShortCloseInput = z.object({ reason: z.string().trim().min(3).max(500), lineIds: z.array(z.string().uuid()).optional() });

/** PO taxes view: GET /docs/po/:id/taxes. */
export interface PoTaxes {
  lines: Record<string, TaxLine[]>;
  totals: { taxable: string; cgst: string; sgst: string; igst: string; cess: string; tax: string; freight: string; otherCharges: string; discount: string; grand: string };
}

/**
 * PO install steps (150 tax, 400 po), short-close and the taxes read model.
 */
@Injectable()
export class PoService implements OnModuleInit {
  constructor(
    private readonly installer: ProcurementInstaller,
    private readonly types: SystemTypeInstaller,
    private readonly tax: TaxInstallStep,
    private readonly docs: DocumentsService,
    private readonly store: DocStore,
    private readonly ledger: PoLedger,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.installer.register({ key: 'tax_code', order: 150, run: (tx, ctx) => this.tax.run(tx, ctx) });
    this.installer.register({ key: 'po_type', order: 400, run: (tx, ctx) => this.installPo(tx, ctx) });
  }

  /** PO system type (forms, keys, numbering PO/{FYS}/{SEQ:5}, default workflow) + the `amending` status view. */
  async installPo(tx: Tx, ctx: InstallContext): Promise<void> {
    const { id } = await this.types.ensure(tx, ctx.tenantId, ctx.actorId, PO_SPEC);
    const type = await tx.selectFrom('app.doc_type').select(['kind']).where('id', '=', id).executeTakeFirstOrThrow();
    if (type.kind !== 'system') return;
    await tx.insertInto('app.permission_def').values({
      tenant_id: ctx.tenantId, key: `doc.${PO}:view.${AMENDING}`, kind: 'view', tab_key: `doc.${PO}`, label: 'Being amended', description: null, group_label: null,
      requires_feature: PO_SPEC.moduleKey, requires_setting: null, sort_order: 108, source: 'form', source_id: id,
    }).onConflict(oc => oc.columns(['tenant_id', 'key']).doNothing()).execute();
    // The delivery `schedule` ([{ date, qty }] per line) is a module-owned line value (DocumentHooks.lineExtras), not a
    // form field: grid column keys must be unique across a form and the line form already has `qty`.
  }

  // ------------------------------------------------------------------ short-close
  /**
   * Short-close PO lines (or the whole PO): for the unreceived qty (ordered − received) writes `short_closed` +
   * `order_cancelled` on the PO line and `order_cancelled` back on its sources. Quantity still in approval must be
   * cancelled first. The whole PO (no lineIds) is then closed.
   */
  async shortClose(tx: Tx, actor: DocActor, id: string, input: z.infer<typeof ShortCloseInput>): Promise<DocumentRow> {
    const type = await this.docs.typeFor(tx, actor, PO);
    if (actor.perms && !actor.perms.keys.includes(docAction(PO, 'short_close'))) throw AppError.forbidden();
    const doc = await this.docs.access(tx, actor, type, id, true);
    if (['draft', 'submitted', AMENDING].includes(doc.status_key)) throw AppError.conflict('Only issued purchase orders can be short-closed.');
    if (doc.cancelled_at || doc.closed_at) throw AppError.conflict('This purchase order is already cancelled or closed.');
    const all = await this.store.loadLines(tx, actor.tenantId, id);
    const ids = input.lineIds?.length ? [...new Set(input.lineIds)] : all.map(l => l.id);
    for (const lid of ids) if (!all.some(l => l.id === lid)) throw AppError.notFound('Document line');
    const sums = await this.store.summaries(tx, actor.tenantId, ids);
    const pending = all.filter(l => ids.includes(l.id)).filter(l => {
      const b = sums.get(l.id);
      return b && b.requested - b.approved - b.rejected - b.cancelled > 0n;
    });
    if (pending.length) throw AppError.conflict(`Line(s) ${pending.map(l => l.line_no).join(', ')} still have quantity waiting for approval. Cancel it before short-closing.`, { lineNos: pending.map(l => l.line_no) });
    const events: LedgerEvent[] = [];
    const back: { poLineId: string; qty: bigint }[] = [];
    // Phase 5: quantity rejected at receipt (and, per rtv.reopens_po, returned to the vendor) is still open.
    const reopens = await getTenantSetting(tx, 'rtv.reopens_po');
    for (const lid of ids) {
      const b = sums.get(lid);
      if (!b) continue;
      const open = pendingReceiptUnits(b, reopens);
      if (open <= 0n) continue;
      events.push({ lineId: lid, type: 'short_closed', qty: fromUnits(open), reason: input.reason }, { lineId: lid, type: 'order_cancelled', qty: fromUnits(open), reason: input.reason });
      back.push({ poLineId: lid, qty: open });
    }
    if (!events.length && input.lineIds?.length) throw AppError.conflict('Nothing is left to short-close on these lines.');
    await this.store.record(tx, actor.tenantId, id, events, actor.userId);
    await this.ledger.unorder(tx, actor.tenantId, back, actor.userId, input.reason);
    await this.docs.closeDoc(tx, actor.tenantId, type, doc, input.lineIds?.length ? ids : null, input.reason, actor.userId);
    await this.audit.tenant(tx, { action: 'short_close', entity: 'document', entityId: id, actorId: actor.userId, after: { reason: input.reason, lines: back.map(b => ({ lineId: b.poLineId, qty: fromUnits(b.qty) })) } });
    await this.store.emit(tx, 'document.short_closed', { kind: 'document', id }, {
      documentId: id, docTypeKey: PO, number: doc.number, reason: input.reason, lines: back.map(b => ({ lineId: b.poLineId, qty: fromUnits(b.qty) })),
    });
    return this.docs.toRow(tx, actor, type, await this.store.loadDoc(tx, actor.tenantId, id));
  }

  // ------------------------------------------------------------------ taxes
  async taxes(tx: Tx, actor: DocActor, id: string): Promise<PoTaxes> {
    const type = await this.docs.typeFor(tx, actor, PO);
    const doc = await this.docs.access(tx, actor, type, id);
    const rows = await tx.selectFrom('app.line_tax').selectAll().where('tenant_id', '=', actor.tenantId).where('document_id', '=', id).execute();
    const live = new Set((await this.store.loadLines(tx, actor.tenantId, id)).map(l => l.id));
    const order = { cgst: 0, sgst: 1, igst: 2, cess: 3 } as const;
    const lines: Record<string, TaxLine[]> = {};
    for (const r of rows.sort((a, b) => order[a.component] - order[b.component])) {
      if (!live.has(r.line_id)) continue;
      (lines[r.line_id] ??= []).push({ component: r.component, ratePct: new Decimal(r.rate_pct).toString(), taxableAmount: money(r.taxable_amount), taxAmount: money(r.tax_amount) });
    }
    const c = doc.custom;
    const m = (k: string) => money(c[k] as string | undefined);
    return {
      lines,
      totals: {
        taxable: m(TOTAL_FIELDS.taxable), cgst: m(TOTAL_FIELDS.cgst), sgst: m(TOTAL_FIELDS.sgst), igst: m(TOTAL_FIELDS.igst), cess: m(TOTAL_FIELDS.cess),
        tax: m(TOTAL_FIELDS.tax), freight: m('freight'), otherCharges: m('other_charges'), discount: m('discount_amount'), grand: m(TOTAL_FIELDS.grand),
      },
    };
  }
}

const money = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '0.00' : new Decimal(v).toFixed(2));

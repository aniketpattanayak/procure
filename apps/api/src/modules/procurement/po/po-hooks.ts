import { Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import {
  docAction, DocStore, DocumentHooks, fromUnits, type LineOutcomeCtx, type SaveHookCtx, type SubmitHookCtx, toUnits,
} from '../../documents';
import { validationFailed } from '../../forms';
import { getTenantSetting } from '../../identity';
import { INDENT, SELECTION } from '../installer/a-steps';
import { RevisionsService } from '../revisions/revisions.service';
import type { Snapshot } from '../revisions/diff';
import { jsonPatch, parseSchedule, PoDerived } from './po-derived';
import { PoLedger } from './po-ledger';
import { AMENDING, PO, PO_SETTING_DIRECT, RESERVED } from './po.type';

/**
 * The PO type's behaviour on the documents core (DocumentHooks):
 * - onSave: direct-PO gate, source-line checks, schedule validation, then derived values (GST, expected dates).
 * - onSubmit: `ordered` on the source lines under row locks (QTY_EXCEEDS_REMAINING).
 * - onLineOutcome: approved → `ordered` on the PO line itself (pending receipt); rejected/cancelled →
 *   `order_cancelled` back on the sources; approval complete → T&C snapshot + rev 0.
 * - beforeRecord / onResubmit / draftLike(amending): amendments (revisions/).
 * - lineExtras(schedule): the delivery schedule grid inside a line.
 */
@Injectable()
export class PoHooks implements OnModuleInit {
  constructor(
    private readonly hooks: DocumentHooks,
    private readonly store: DocStore,
    private readonly ledger: PoLedger,
    private readonly derived: PoDerived,
    private readonly revisions: RevisionsService,
  ) {}

  onModuleInit() {
    this.hooks.lineExtras(PO, ['schedule']);
    this.hooks.draftLike(PO, [AMENDING]);
    this.hooks.onSave(PO, (tx, ctx) => this.onSave(tx, ctx));
    this.hooks.onSubmit(PO, (tx, ctx) => this.onSubmit(tx, ctx));
    this.hooks.onLineOutcome(PO, (tx, ctx) => this.onOutcome(tx, ctx));
    this.hooks.beforeRecord(PO, (tx, ctx) => this.revisions.beforeRecord(tx, ctx));
    this.hooks.onResubmit(PO, (tx, ctx) => this.revisions.resubmit(tx, ctx));
  }

  // ------------------------------------------------------------------ save
  async onSave(tx: Tx, ctx: SaveHookCtx): Promise<void> {
    if (ctx.mode !== 'line_edits') await this.validate(tx, ctx);
    await this.derived.refresh(tx, ctx.tenantId, ctx.documentId);
  }

  private async validate(tx: Tx, ctx: SaveHookCtx) {
    const { tenantId, documentId: id, actor } = ctx;
    const doc = await tx.selectFrom('app.document').select(['party_id', 'location_node_id', 'custom', 'status_key']).where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirstOrThrow();
    const lines = await this.derived.lines(tx, tenantId, id);
    const errors: { path: string; message: string }[] = [];
    const at = (l: { line_no: number }) => `lines.${l.line_no - 1}`;

    // Amendment: lines of the issued PO stay, and so do vendor and ship-to.
    const amend = (doc.custom as Record<string, unknown>)[RESERVED.amend] as { baseRev: number } | undefined;
    if (amend && (ctx.statusKey === AMENDING || ctx.statusKey === 'draft')) {
      const base = await tx.selectFrom('app.document_revision').select('snapshot').where('tenant_id', '=', tenantId).where('document_id', '=', id)
        .where('rev_no', '=', amend.baseRev).executeTakeFirst();
      const snap = base?.snapshot as unknown as Snapshot | undefined;
      if (snap) {
        const have = new Set(lines.map(l => l.id));
        const gone = snap.lines.filter(l => !have.has(l.id));
        if (gone.length) throw AppError.conflict(`Line(s) ${gone.map(l => l.line_no).join(', ')} of the issued order cannot be removed. Set the quantity to 0 or short-close instead.`);
        if (snap.header.party_id !== doc.party_id) errors.push({ path: 'party', message: 'The vendor of an issued order cannot change.' });
        if (snap.header.location_node_id !== doc.location_node_id) errors.push({ path: 'location', message: 'The ship-to location of an issued order cannot change.' });
      }
    }

    // Direct lines (no source) need create_direct, which only exists while flow.po.direct_allowed is on.
    const direct = lines.filter(l => !l.custom.source_line);
    if (direct.length && actor.perms) {
      const allowed = await getTenantSetting(tx, PO_SETTING_DIRECT);
      if (!allowed || !actor.perms.keys.includes(docAction(PO, 'create_direct'))) {
        throw new AppError(403, 'FORBIDDEN', allowed
          ? 'You may only order lines from approved indents / vendor selections.'
          : 'Purchase orders without an indent are switched off (setting "Allow PO without indent").', { lineNos: direct.map(l => l.line_no) });
      }
    }

    // Source lines: exist, right kind for the flow, approved, same item, same vendor, used once.
    const sourced = lines.filter(l => typeof l.custom.source_line === 'string' && l.custom.source_line);
    if (sourced.length) {
      const selectionOn = await getTenantSetting(tx, 'flow.vendor_selection.enabled');
      const ids = [...new Set(sourced.map(l => String(l.custom.source_line)))].filter(x => /^[0-9a-f-]{36}$/i.test(x));
      const src = ids.length ? await sql<{ id: string; key: string; item_id: string | null; vendor: string | null; status_key: string; doc_status: string; closed: boolean }>`
        select l.id, t.key, l.item_id, l.custom->>'vendor' as vendor, l.status_key, d.status_key as doc_status, (d.closed_at is not null or d.cancelled_at is not null) as closed
        from app.document_line l join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id
        where l.tenant_id = ${tenantId} and l.id = any(${sql.val(ids)}::uuid[]) and not l.is_deleted and not d.is_deleted`.execute(tx) : { rows: [] };
      const byId = new Map(src.rows.map(r => [r.id, r]));
      const seen = new Set<string>();
      for (const l of sourced) {
        const sid = String(l.custom.source_line);
        const s = byId.get(sid);
        const p = `${at(l)}.source_line`;
        if (!s || (s.key !== SELECTION && s.key !== INDENT)) { errors.push({ path: p, message: 'The source line does not exist.' }); continue; }
        if (seen.has(sid)) errors.push({ path: p, message: 'The same source line is used twice on this order.' });
        seen.add(sid);
        if (s.key !== (selectionOn ? SELECTION : INDENT)) errors.push({ path: p, message: selectionOn ? 'Order from vendor selection lines.' : 'Order from indent lines (vendor selection is off).' });
        if (s.closed || ['draft', 'submitted', 'rejected', 'cancelled'].includes(s.status_key)) errors.push({ path: p, message: 'The source line is not approved (or is closed).' });
        if (s.item_id && l.item_id !== s.item_id) errors.push({ path: `${at(l)}.item`, message: 'The item must be the item of the source line.' });
        if (s.key === SELECTION && s.vendor && doc.party_id && s.vendor !== doc.party_id) errors.push({ path: 'party', message: 'The vendor must be the vendor selected for the source lines.' });
      }
    }

    // Delivery schedule rows must add up to the line quantity.
    for (const l of lines) {
      const s = parseSchedule(l.custom.schedule);
      if (s.error) { errors.push({ path: `${at(l)}.schedule`, message: s.error }); continue; }
      if (!s.rows.length) {
        if (l.custom.schedule !== undefined) await this.setSchedule(tx, tenantId, l.id, null);
        continue;
      }
      const sum = s.rows.reduce((a, r) => a + toUnits(r.qty), 0n);
      if (sum !== toUnits(l.qty)) {
        errors.push({ path: `${at(l)}.schedule`, message: `The schedule adds up to ${fromUnits(sum)} but the line quantity is ${fromUnits(toUnits(l.qty))}.` });
        continue;
      }
      if (JSON.stringify(s.rows) !== JSON.stringify(l.custom.schedule)) await this.setSchedule(tx, tenantId, l.id, s.rows);
    }
    if (errors.length) throw validationFailed(errors);
  }

  private async setSchedule(tx: Tx, tenantId: string, lineId: string, rows: unknown) {
    await tx.updateTable('app.document_line').set({ custom: jsonPatch('custom', { schedule: rows }) }).where('tenant_id', '=', tenantId).where('id', '=', lineId).execute();
  }

  // ------------------------------------------------------------------ submit / outcomes
  async onSubmit(tx: Tx, ctx: SubmitHookCtx): Promise<void> {
    const lines = await this.store.loadLines(tx, ctx.tenantId, ctx.documentId);
    await this.ledger.order(tx, ctx.tenantId, lines.map(l => ({ poLineId: l.id, qty: toUnits(l.qty) })), ctx.actor.userId, { check: true });
  }

  async onOutcome(tx: Tx, ctx: LineOutcomeCtx): Promise<void> {
    const approved = ctx.events.filter(e => e.type === 'approved');
    const back = ctx.events.filter(e => e.type === 'rejected' || e.type === 'cancelled');
    if (approved.length) {
      await this.store.record(tx, ctx.tenantId, ctx.documentId, approved.map(e => ({ lineId: e.lineId, type: 'ordered' as const, qty: e.qty, reason: e.reason ?? null })), ctx.actorId);
    }
    if (back.length) {
      await this.ledger.unorder(tx, ctx.tenantId, back.map(e => ({ poLineId: e.lineId, qty: toUnits(e.qty) })), ctx.actorId, back[0]!.reason ?? null);
    }
    if (approved.length) {
      // Nothing left in approval → the PO is issued: freeze T&C and write rev 0.
      const lines = await this.store.loadLines(tx, ctx.tenantId, ctx.documentId);
      const sums = await this.store.summaries(tx, ctx.tenantId, lines.map(l => l.id));
      const open = [...sums.values()].some(b => b.requested - b.approved - b.rejected - b.cancelled > 0n);
      if (!open) await this.revisions.onApprovalComplete(tx, ctx.tenantId, ctx.documentId, ctx.actorId);
    }
  }
}

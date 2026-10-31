import { Injectable } from '@nestjs/common';
import { DocumentRow, ErrorCode, SelectionCreate, VendorQuoteInput, VendorQuoteRow } from '@procure/schema';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit.service';
import { SelectionService } from '../selection/selection.service';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { type DocActor, DocStore, fromUnits, toUnits } from '../../documents';
import { tenantToday } from '../../forms';
import { getTenantSetting } from '../../identity';
import { dateOnly, IndentLine, IndentLines, isOpen } from '../indent/indent-lines';
import { fmt, Slab, validateSlabs } from './slabs';
import Decimal from 'decimal.js';

type Input = z.infer<typeof VendorQuoteInput>;

const bad = (errors: { path: string; message: string }[], message = errors[0]?.message ?? 'Invalid quote.') =>
  new AppError(400, ErrorCode.VALIDATION, message, undefined, errors);

export interface QuoteDbRow {
  id: string; indent_line_id: string; item_id: string | null; vendor_id: string; version: number; supersedes_id: string | null; is_current: boolean;
  quoted_rate: string; currency: string; uom_id: string | null; moq: string | null; lead_time_days: number | null; valid_until: unknown;
  payment_terms_id: string | null; freight: string; freight_basis: 'lump_sum' | 'per_unit'; tax_pct: string; slabs: unknown; notes: string | null;
  file_ids: string[]; custom: Record<string, unknown>; logged_at: Date; created_at: Date; created_by: string;
  vendor_code: string; vendor_name: string; creator_name: string | null;
}

const num = (v: string | null | undefined) => (v === null || v === undefined ? undefined : fromUnits(toUnits(String(v))));

/**
 * Vendor quote log (contract "Endpoints" — quotes). Append-only: a quote is never updated except `is_current = false`
 * when a newer version supersedes it. Logging a quote for a vendor that already has a current quote on that line
 * creates the next version as well.
 */
@Injectable()
export class QuotesService {
  constructor(
    private readonly lines: IndentLines,
    private readonly store: DocStore,
    private readonly audit: AuditService,
    private readonly selection: SelectionService,
  ) {}

  query(tx: Tx, tenantId: string) {
    return tx.selectFrom('app.vendor_quote as q')
      .innerJoin('app.master_record as v', 'v.id', 'q.vendor_id')
      .leftJoin('app.tenant_user as u', 'u.id', 'q.created_by')
      .selectAll('q').select(['v.code as vendor_code', 'v.name as vendor_name', 'u.name as creator_name'])
      .where('q.tenant_id', '=', tenantId);
  }

  toRow(r: QuoteDbRow): VendorQuoteRow {
    return {
      id: r.id, indentLineId: r.indent_line_id, itemId: r.item_id, vendorId: r.vendor_id, vendor: { id: r.vendor_id, code: r.vendor_code ?? '', name: r.vendor_name },
      version: r.version, supersedesId: r.supersedes_id, isCurrent: r.is_current,
      quotedRate: num(r.quoted_rate)!, currency: r.currency.trim(), uomId: r.uom_id ?? undefined, moq: num(r.moq), leadTimeDays: r.lead_time_days ?? undefined,
      validUntil: r.valid_until ? dateOnly(r.valid_until) : undefined, paymentTermsId: r.payment_terms_id ?? undefined, freight: num(r.freight)!,
      freightBasis: r.freight_basis, taxPct: num(r.tax_pct)!, slabs: (r.slabs as Input['slabs']) ?? [], notes: r.notes ?? undefined, fileIds: r.file_ids ?? [],
      loggedAt: new Date(r.logged_at).toISOString(), custom: r.custom ?? {},
      createdAt: new Date(r.created_at).toISOString(), createdBy: { id: r.created_by, name: r.creator_name ?? '' },
    };
  }

  async list(tx: Tx, actor: DocActor, lineId: string, all: boolean): Promise<VendorQuoteRow[]> {
    await this.lines.one(tx, actor, lineId);
    let q = this.query(tx, actor.tenantId).where('q.indent_line_id', '=', lineId);
    if (!all) q = q.where('q.is_current', '=', true);
    const rows = await q.orderBy('v.name').orderBy('q.vendor_id').orderBy('q.version', 'desc').execute();
    return rows.map(r => this.toRow(r as unknown as QuoteDbRow));
  }

  /** Lines a quote may be logged on: open, approved (approved > 0) indent lines. */
  private assertQuotable(l: IndentLine, path: string) {
    if (!isOpen(l) || l.buckets.approved + l.buckets.over_approved <= 0n) {
      throw new AppError(409, 'LINE_NOT_QUOTABLE', `Line ${l.lineNo} of ${l.number ?? 'the indent'} is not approved or is already closed.`, { lineId: l.id, path });
    }
  }

  private async validate(tx: Tx, actor: DocActor, input: Input) {
    const errors: { path: string; message: string }[] = [];
    const vendor = await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id')
      .select(['r.id', 'r.is_active', 'r.is_deleted', 'd.key']).where('r.tenant_id', '=', actor.tenantId).where('r.id', '=', input.vendorId).executeTakeFirst();
    if (!vendor || vendor.key !== 'vendor' || vendor.is_deleted) errors.push({ path: 'vendorId', message: 'Choose an existing vendor.' });
    else if (!vendor.is_active) errors.push({ path: 'vendorId', message: 'This vendor is inactive.' });
    for (const [path, id, master] of [['uomId', input.uomId, 'uom'], ['paymentTermsId', input.paymentTermsId, 'payment_terms']] as const) {
      if (!id) continue;
      const r = await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id').select('d.key')
        .where('r.tenant_id', '=', actor.tenantId).where('r.id', '=', id).where('r.is_deleted', '=', false).executeTakeFirst();
      if (!r || r.key !== master) errors.push({ path, message: 'Unknown record.' });
    }
    if (input.fileIds.length) {
      const files = await tx.selectFrom('app.file_object').select('id').where('tenant_id', '=', actor.tenantId).where('id', 'in', input.fileIds).execute();
      if (files.length !== new Set(input.fileIds).size) errors.push({ path: 'fileIds', message: 'Unknown file.' });
    }
    // QA47-BUG-004: keep values inside the columns (numeric(18,4) / tax numeric(7,4)) → 400 instead of a 500 overflow.
    const tooBig = (v: string | undefined) => v !== undefined && new Decimal(v).gte('1e14');
    for (const [path, v] of [['quotedRate', input.quotedRate], ['moq', input.moq], ['freight', input.freight]] as const) {
      if (tooBig(v)) errors.push({ path, message: 'The number is too large.' });
    }
    if (new Decimal(input.taxPct).gt(100)) errors.push({ path: 'taxPct', message: 'Tax % cannot exceed 100.' });
    errors.push(...validateSlabs(input.slabs as Slab[]));
    if (errors.length) throw bad(errors);
  }

  private async defaultValidUntil(tx: Tx, input: Input): Promise<string> {
    if (input.validUntil) return input.validUntil;
    const days = await getTenantSetting(tx, 'procurement.quote_validity_days');
    const base = input.loggedAt ? input.loggedAt.slice(0, 10) : await tenantToday(tx);
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private async insertVersion(tx: Tx, actor: DocActor, line: IndentLine, input: Input, validUntil: string, supersedes: { id: string; version: number } | null) {
    if (supersedes) {
      await tx.updateTable('app.vendor_quote').set({ is_current: false }).where('tenant_id', '=', actor.tenantId).where('id', '=', supersedes.id).execute();
    }
    const row = await tx.insertInto('app.vendor_quote').values({
      tenant_id: actor.tenantId, indent_line_id: line.id, item_id: line.itemId, vendor_id: input.vendorId, version: (supersedes?.version ?? 0) + 1,
      supersedes_id: supersedes?.id ?? null, is_current: true, quoted_rate: input.quotedRate, currency: input.currency.toUpperCase(), uom_id: input.uomId ?? line.uomId,
      moq: input.moq ?? null, lead_time_days: input.leadTimeDays ?? null, valid_until: validUntil, payment_terms_id: input.paymentTermsId ?? null,
      freight: input.freight, freight_basis: input.freightBasis, tax_pct: input.taxPct, slabs: JSON.stringify(input.slabs), notes: input.notes ?? null,
      file_ids: input.fileIds, custom: JSON.stringify(input.custom), ...(input.loggedAt ? { logged_at: new Date(input.loggedAt) } : {}), created_by: actor.userId!,
    }).returning('id').executeTakeFirstOrThrow();
    return row.id;
  }

  /** Current quote of a vendor on a line, locked (serialises two buyers logging the same vendor at once). */
  private async current(tx: Tx, tenantId: string, lineId: string, vendorId: string) {
    return tx.selectFrom('app.vendor_quote').select(['id', 'version']).where('tenant_id', '=', tenantId).where('indent_line_id', '=', lineId)
      .where('vendor_id', '=', vendorId).where('is_current', '=', true).forUpdate().executeTakeFirst();
  }

  private async rowsById(tx: Tx, tenantId: string, ids: string[]): Promise<VendorQuoteRow[]> {
    const rows = await this.query(tx, tenantId).where('q.id', 'in', ids).execute();
    const by = new Map(rows.map(r => [r.id, this.toRow(r as unknown as QuoteDbRow)]));
    return ids.map(id => by.get(id)!);
  }

  /** POST /procurement/indent-lines/:lineId/quotes — one row per line (the line + alsoForLineIds, same item). */
  async log(tx: Tx, actor: DocActor, lineId: string, input: Input): Promise<VendorQuoteRow[]> {
    const ids = [lineId, ...input.alsoForLineIds.filter(x => x !== lineId)];
    const lines = await this.lines.load(tx, actor, ids);
    const main = lines.get(lineId);
    if (!main) throw AppError.notFound('Indent line');
    ids.forEach((id, i) => {
      const l = lines.get(id);
      const path = i === 0 ? 'lineId' : `alsoForLineIds.${i - 1}`;
      if (!l) throw new AppError(404, ErrorCode.NOT_FOUND, 'Indent line not found.', { path });
      if (l.itemId !== main.itemId) throw bad([{ path, message: 'All lines must be for the same item.' }]);
      this.assertQuotable(l, path);
    });
    await this.validate(tx, actor, input);
    const validUntil = await this.defaultValidUntil(tx, input);
    const out: string[] = [];
    for (const id of ids) {
      const cur = await this.current(tx, actor.tenantId, id, input.vendorId);
      out.push(await this.insertVersion(tx, actor, lines.get(id)!, input, validUntil, cur ?? null));
    }
    await this.after(tx, actor, 'log_quote', out, ids, input);
    return this.rowsById(tx, actor.tenantId, out);
  }

  /** PUT /procurement/quotes/:quoteId — new version of that quote (must be the current one). */
  async revise(tx: Tx, actor: DocActor, quoteId: string, input: Input): Promise<VendorQuoteRow> {
    const q = await tx.selectFrom('app.vendor_quote').select(['id', 'indent_line_id', 'vendor_id', 'version', 'is_current'])
      .where('tenant_id', '=', actor.tenantId).where('id', '=', quoteId).forUpdate().executeTakeFirst();
    if (!q) throw AppError.notFound('Quote');
    const line = await this.lines.one(tx, actor, q.indent_line_id);
    if (!q.is_current) throw AppError.conflict('This quote has been superseded by a newer version. Reload and edit the latest one.');
    if (input.vendorId !== q.vendor_id) throw bad([{ path: 'vendorId', message: 'The vendor of a quote cannot change; log a new quote instead.' }]);
    this.assertQuotable(line, 'quoteId');
    await this.validate(tx, actor, input);
    const validUntil = await this.defaultValidUntil(tx, input);
    const id = await this.insertVersion(tx, actor, line, input, validUntil, { id: q.id, version: q.version });
    await this.after(tx, actor, 'revise_quote', [id], [line.id], input);
    return (await this.rowsById(tx, actor.tenantId, [id]))[0]!;
  }

  private async after(tx: Tx, actor: DocActor, action: string, quoteIds: string[], lineIds: string[], input: Input) {
    await this.audit.tenant(tx, {
      action, entity: 'vendor_quote', entityId: quoteIds[0]!, actorId: actor.userId,
      after: { quoteIds, lineIds, vendorId: input.vendorId, quotedRate: input.quotedRate, currency: input.currency, slabs: input.slabs },
    });
    await this.store.emit(tx, 'indent.quote_logged', { kind: 'vendor_quote', id: quoteIds[0]! }, {
      quoteIds, indentLineIds: lineIds, vendorId: input.vendorId, quotedRate: fmt(new Decimal(input.quotedRate)), currency: input.currency, by: actor.userId,
    });
  }

  /** Current quotes for a set of lines (comparison sheet). */
  async currentFor(tx: Tx, tenantId: string, lineIds: string[]): Promise<QuoteDbRow[]> {
    if (!lineIds.length) return [];
    return (await this.query(tx, tenantId).where('q.indent_line_id', 'in', lineIds).where('q.is_current', '=', true)
      .orderBy('q.created_at', 'desc').execute()) as unknown as QuoteDbRow[];
  }

  /** Versions logged per vendor across lines (all versions). */
  async countsFor(tx: Tx, tenantId: string, lineIds: string[]): Promise<Map<string, number>> {
    if (!lineIds.length) return new Map();
    const rows = await tx.selectFrom('app.vendor_quote').select(['vendor_id', sql<string>`count(*)::text`.as('n')])
      .where('tenant_id', '=', tenantId).where('indent_line_id', 'in', lineIds).groupBy('vendor_id').execute();
    return new Map(rows.map(r => [r.vendor_id, Number(r.n)]));
  }
  /**
   * POST /procurement/quotes/:quoteId/approve — vendor_approver selects a vendor directly from the quotes log:
   * creates a vendor_selection document for the quote's indent line (using the quote's vendor and rate) and
   * immediately submits + auto-approves it by bypassing the VS workflow stage. The caller must hold
   * `doc.indent:action.approve_quote`. The selection document is created in the approved state.
   *
   * @param qty - quantity to select (defaults to the line's full pending qty when omitted)
   */
  async approveQuote(tx: Tx, actor: DocActor, quoteId: string, qty?: string): Promise<DocumentRow> {
    const q = await tx.selectFrom('app.vendor_quote as q')
      .innerJoin('app.document_line as l', 'l.id', 'q.indent_line_id')
      .select(['q.id', 'q.indent_line_id', 'q.vendor_id', 'q.quoted_rate', 'q.is_current', 'l.qty', 'l.status_key'])
      .where('q.tenant_id', '=', actor.tenantId).where('q.id', '=', quoteId).executeTakeFirst();
    if (!q) throw AppError.notFound('Quote');
    if (!q.is_current) throw AppError.conflict('This quote has been superseded. Reload and approve the latest one.');
    // Re-use the quoted rate; qty defaults to the indent line qty
    const selectQty = qty ?? String(q.qty);
    const selInput: z.input<typeof SelectionCreate> = {
      values: {},
      submit: true,
      lines: [{ indentLineId: q.indent_line_id, vendorId: q.vendor_id, quoteId: q.id, qty: selectQty, rate: q.quoted_rate ?? '0' }],
    };
    return this.selection.create(tx, actor, SelectionCreate.parse(selInput));
  }
}

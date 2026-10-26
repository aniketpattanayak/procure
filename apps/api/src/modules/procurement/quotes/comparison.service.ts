import { Injectable } from '@nestjs/common';
import type { ComparisonSheet } from '@procure/schema';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { type DocActor, fromUnits, toUnits } from '../../documents';
import { tenantToday } from '../../forms';
import { getTenantSetting } from '../../identity';
import { dateOnly, IndentLine, IndentLines, isOpen, selectable } from '../indent/indent-lines';
import { INDENT } from '../installer/a-steps';
import { QuoteDbRow, QuotesService } from './quotes.service';
import { effectiveRate, fmt, freightPerUnit, landedCost, Slab } from './slabs';

type VendorCol = ComparisonSheet['vendors'][number];
const D = (v: string | number) => new Decimal(v);

/**
 * Comparison sheet (contract ComparisonSheet): per quote the slab rate at the quantity, freight per unit, landed
 * cost via the tenant formula `procurement.landed_cost_formula`, warnings, and the best value = lowest landed cost
 * among valid (not expired, MOQ met) quotes. Rate history comes from approved PO lines of the item (none before the
 * PO type exists).
 */
@Injectable()
export class ComparisonService {
  constructor(private readonly lines: IndentLines, private readonly quotes: QuotesService) {}

  async forLine(tx: Tx, actor: DocActor, lineId: string, qty?: string): Promise<ComparisonSheet> {
    const line = await this.lines.one(tx, actor, lineId);
    return this.build(tx, actor, line.itemId, [line], qty);
  }

  async forItem(tx: Tx, actor: DocActor, itemId: string, locationId?: string): Promise<ComparisonSheet> {
    // QA47-BUG-005: unknown / other tenant's / deleted / non-item ids are 404 (not an empty sheet).
    const item = await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id').select('r.id')
      .where('r.tenant_id', '=', actor.tenantId).where('r.id', '=', itemId).where('r.is_deleted', '=', false).where('d.key', '=', 'item').executeTakeFirst();
    if (!item) throw AppError.notFound('Item');
    let q = tx.selectFrom('app.document_line as l').innerJoin('app.document as d', 'd.id', 'l.document_id').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id')
      .select('l.id').where('l.tenant_id', '=', actor.tenantId).where('t.key', '=', INDENT).where('l.item_id', '=', itemId)
      .where('l.is_deleted', '=', false).where('d.is_deleted', '=', false).where('d.closed_at', 'is', null).where('d.cancelled_at', 'is', null);
    if (locationId) {
      q = q.where(sql<boolean>`d.location_node_id in (select c.id from app.location_node c join app.location_node p on p.id = ${locationId} where c.path <@ p.path)`);
    }
    const ids = (await q.execute()).map(r => r.id);
    const loaded = [...(await this.lines.load(tx, actor, ids)).values()].filter(l => isOpen(l) && selectable(l.buckets) > 0n)
      .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '') || a.lineNo - b.lineNo);
    return this.build(tx, actor, itemId, loaded, undefined);
  }

  /**
   * Comparison sheets for every item of one indent (the `comparison` template context extension): one sheet per item,
   * lines of the same item combined, cancelled / item-less lines skipped. System view: the caller (print / PDF job)
   * has already checked access to the document, so no data-scope filter here.
   */
  async forDocument(tx: Tx, tenantId: string, documentId: string): Promise<ComparisonSheet[]> {
    const actor: DocActor = { tenantId, userId: null, perms: null };
    const ids = (await tx.selectFrom('app.document_line').select('id').where('tenant_id', '=', tenantId).where('document_id', '=', documentId)
      .where('is_deleted', '=', false).where('item_id', 'is not', null).where('status_key', '!=', 'cancelled').orderBy('line_no').execute()).map(r => r.id);
    const loaded = [...(await this.lines.load(tx, actor, ids, { scopeCheck: false })).values()].sort((a, b) => a.lineNo - b.lineNo);
    const byItem = new Map<string, IndentLine[]>();
    for (const l of loaded) if (l.itemId) byItem.set(l.itemId, [...(byItem.get(l.itemId) ?? []), l]);
    const out: ComparisonSheet[] = [];
    for (const [itemId, lines] of byItem) {
      const pending = lines.reduce((sum, l) => sum + selectable(l.buckets), 0n);
      // Before approval nothing is selectable yet: compare at the requested quantity instead of 0.
      const qty = pending > 0n ? undefined : fromUnits(lines.reduce((sum, l) => sum + toUnits(l.qty), 0n)).replace(/^0$/, '1');
      out.push(await this.build(tx, actor, itemId, lines, qty));
    }
    return out;
  }

  private async build(tx: Tx, actor: DocActor, itemId: string | null, lines: IndentLine[], qtyParam?: string): Promise<ComparisonSheet> {
    const pending = lines.reduce((s, l) => s + selectable(l.buckets), 0n);
    let qty = qtyParam ?? fromUnits(pending);
    if (!qtyParam && pending === 0n && lines.length === 1) qty = lines[0]!.qty;
    if (!/^\d+(\.\d+)?$/.test(qty)) throw new AppError(400, 'VALIDATION_FAILED', 'qty must be a positive decimal.', undefined, [{ path: 'qty', message: 'Invalid quantity' }]);

    const item = itemId ? await tx.selectFrom('app.master_record').select(['name']).where('tenant_id', '=', actor.tenantId).where('id', '=', itemId).executeTakeFirst() : undefined;
    const uomId = lines[0]?.uomId ?? null;
    const uom = uomId ? await tx.selectFrom('app.master_record').select(['code', 'name']).where('tenant_id', '=', actor.tenantId).where('id', '=', uomId).executeTakeFirst() : undefined;

    const lineIds = lines.map(l => l.id);
    const current = await this.quotes.currentFor(tx, actor.tenantId, lineIds);
    // One column per vendor: its most recently logged current quote across the lines.
    const byVendor = new Map<string, QuoteDbRow>();
    for (const q of current) {
      const prev = byVendor.get(q.vendor_id);
      if (!prev || new Date(q.logged_at) > new Date(prev.logged_at)) byVendor.set(q.vendor_id, q);
    }
    const counts = await this.quotes.countsFor(tx, actor.tenantId, lineIds);
    const terms = await this.names(tx, actor.tenantId, [...byVendor.values()].map(q => q.payment_terms_id).filter((x): x is string => !!x));
    const formula = await getTenantSetting(tx, 'procurement.landed_cost_formula');
    const today = await tenantToday(tx);
    const baseCurrency = modeCurrency([...byVendor.values()].map(q => q.currency.trim()));

    const vendors: VendorCol[] = [...byVendor.values()].map(q => {
      const rate = effectiveRate(q.quoted_rate, (q.slabs as Slab[]) ?? [], qty);
      const fpu = freightPerUnit(q.freight, q.freight_basis, qty);
      const moq = q.moq === null ? null : fmt(D(q.moq));
      const { perUnit } = landedCost(formula, { rate, qty, freight: fmt(D(q.freight)), freight_per_unit: fpu, tax_pct: fmt(D(q.tax_pct)), lead_time_days: q.lead_time_days, moq }, today);
      const validUntil = q.valid_until ? dateOnly(q.valid_until) : null;
      const expired = !!validUntil && validUntil < today;
      const warnings: VendorCol['warnings'] = [];
      if (expired) warnings.push('expired');
      if (moq !== null && D(qty).lt(D(moq))) warnings.push('below_moq');
      if (q.currency.trim() !== baseCurrency) warnings.push('currency_differs');
      return {
        vendor: { id: q.vendor_id, code: q.vendor_code ?? '', name: q.vendor_name }, quoteId: q.id, quotedRate: fmt(D(q.quoted_rate)), effectiveRate: rate,
        freightPerUnit: fpu, taxPct: fmt(D(q.tax_pct)), landedCostPerUnit: perUnit, landedTotal: fmt(D(perUnit).times(D(qty)), 2),
        leadTimeDays: q.lead_time_days, moq, validUntil, expired, paymentTerms: q.payment_terms_id ? terms.get(q.payment_terms_id) ?? null : null,
        quotesLogged: counts.get(q.vendor_id) ?? 0, lastLoggedAt: new Date(q.logged_at).toISOString(), isBest: false, warnings,
      };
    });
    const valid = vendors.filter(v => !v.warnings.includes('expired') && !v.warnings.includes('below_moq') && !v.warnings.includes('currency_differs'));
    if (valid.length) {
      const best = valid.reduce((a, b) => {
        const c = D(a.landedCostPerUnit).cmp(D(b.landedCostPerUnit));
        if (c !== 0) return c < 0 ? a : b;
        return (a.leadTimeDays ?? Infinity) <= (b.leadTimeDays ?? Infinity) ? a : b;
      });
      best.isBest = true;
    }
    vendors.sort((a, b) => D(a.landedCostPerUnit).cmp(D(b.landedCostPerUnit)) || a.vendor.name.localeCompare(b.vendor.name));

    return {
      itemId, itemName: item?.name ?? null, qty: fmt(D(qty)), uom: uom ? uom.code ?? uom.name : null,
      lines: lines.map(l => ({ lineId: l.id, documentNumber: l.number, lineNo: l.lineNo, pendingSelection: fromUnits(selectable(l.buckets)) })),
      vendors,
      history: itemId ? await this.history(tx, actor.tenantId, itemId) : [],
    };
  }

  private async names(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await tx.selectFrom('app.master_record').select(['id', 'name']).where('tenant_id', '=', tenantId).where('id', 'in', [...new Set(ids)]).execute();
    return new Map(rows.map(r => [r.id, r.name]));
  }

  /** Last 5 rates per vendor from approved PO lines of the item (doc type `po`, vendor = header party). */
  async history(tx: Tx, tenantId: string, itemId: string): Promise<ComparisonSheet['history']> {
    const rows = await sql<{ vendor_id: string; vendor_name: string; number: string | null; doc_date: unknown; rate: string }>`
      select x.vendor_id, x.vendor_name, x.number, x.doc_date, x.rate from (
        select d.party_id as vendor_id, v.name as vendor_name, d.number, d.doc_date, l.rate,
               row_number() over (partition by d.party_id order by d.doc_date desc, d.submitted_at desc, l.line_no) as rn
          from app.document_line l
          join app.document d on d.id = l.document_id
          join app.doc_type t on t.id = d.doc_type_id and t.key = 'po'
          join app.master_record v on v.id = d.party_id
          join app.line_qty_summary s on s.line_id = l.id
         where l.tenant_id = ${tenantId} and l.item_id = ${itemId} and not l.is_deleted and not d.is_deleted
           and d.party_id is not null and l.rate is not null and s.approved > 0
      ) x where x.rn <= 5 order by x.vendor_name, x.doc_date desc`.execute(tx);
    return rows.rows.map(r => ({ vendorId: r.vendor_id, vendorName: r.vendor_name, poNumber: r.number ?? '', date: dateOnly(r.doc_date), rate: fmt(D(r.rate)) }));
  }
}

/** The currency most quotes use (ties → INR, the default quote currency). */
function modeCurrency(list: string[]): string {
  const n = new Map<string, number>();
  for (const c of list) n.set(c, (n.get(c) ?? 0) + 1);
  let best = 'INR';
  let max = n.get('INR') ?? 0;
  for (const [c, k] of n) if (k > max) { best = c; max = k; }
  return best;
}

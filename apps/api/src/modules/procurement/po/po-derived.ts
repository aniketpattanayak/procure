import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import { dateStr, fromUnits, TenantCalendar, toUnits } from '../../documents';
import { computeGst, GstResult } from '../tax/gst';
import { shipToState } from '../tax/tax.install';
import { LINE_RESERVED, RESERVED, TOTAL_FIELDS } from './po.type';

/** SQL that merges `patch` into a jsonb column: null values remove the key, others replace it. */
export function jsonPatch(column: 'custom', patch: Record<string, unknown>) {
  const drop = Object.entries(patch).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined));
  return sql`(${sql.ref(column)} - ${sql.val(drop)}::text[]) || ${JSON.stringify(set)}::jsonb` as never;
}

export interface ScheduleRow { date: string; qty: string }
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a stored/incoming schedule; returns rows or an error message. Empty / absent = no schedule. */
export function parseSchedule(v: unknown): { rows: ScheduleRow[]; error?: string } {
  if (v === undefined || v === null || v === '') return { rows: [] };
  if (!Array.isArray(v)) return { rows: [], error: 'The delivery schedule must be a list of { date, qty } rows.' };
  if (v.length > 50) return { rows: [], error: 'A line can have at most 50 delivery dates.' };
  const rows: ScheduleRow[] = [];
  for (const [i, r] of v.entries()) {
    const o = (r ?? {}) as Record<string, unknown>;
    const date = typeof o.date === 'string' ? o.date.slice(0, 10) : '';
    if (!DATE.test(date) || Number.isNaN(Date.parse(date))) return { rows: [], error: `Row ${i + 1}: give a valid date.` };
    let u: bigint;
    try {
      u = toUnits(String(o.qty ?? ''));
    } catch {
      return { rows: [], error: `Row ${i + 1}: give a valid quantity.` };
    }
    if (u <= 0n) return { rows: [], error: `Row ${i + 1}: quantity must be greater than 0.` };
    rows.push({ date, qty: fromUnits(u) });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows };
}

/** Earliest schedule date still open after `received` units are consumed from the earliest rows. */
export function openScheduleDate(rows: ScheduleRow[], received: bigint): string | null {
  let left = received;
  for (const r of rows) {
    const q = toUnits(r.qty);
    if (left >= q) { left -= q; continue; }
    return r.date;
  }
  return null;
}

interface PoLine { id: string; item_id: string | null; line_no: number; qty: string; rate: string | null; required_date: string | null; custom: Record<string, unknown>; received: string | null; ordered: string | null; is_closed: boolean }

/**
 * Values the PO module maintains on every save (contract "PO save pipeline additions"): currency from the vendor,
 * per-line and header `expected_date`, and the GST engine (app.line_tax rows + header tax totals).
 */
@Injectable()
export class PoDerived {
  constructor(private readonly calendar: TenantCalendar) {}

  async lines(tx: Tx, tenantId: string, docId: string): Promise<PoLine[]> {
    const rows = await tx.selectFrom('app.document_line as l').leftJoin('app.line_qty_summary as s', 's.line_id', 'l.id')
      .select(['l.id', 'l.item_id', 'l.line_no', 'l.qty', 'l.rate', 'l.required_date', 'l.custom', 's.received', 's.ordered', 'l.status_key'])
      .where('l.tenant_id', '=', tenantId).where('l.document_id', '=', docId).where('l.is_deleted', '=', false).orderBy('l.line_no').execute();
    return rows.map(r => ({ ...r, required_date: dateStr(r.required_date), custom: (r.custom ?? {}) as Record<string, unknown>, is_closed: ['closed', 'cancelled'].includes(r.status_key) }));
  }

  /** Recomputes everything derived and stores it. Returns the GST result. */
  async refresh(tx: Tx, tenantId: string, docId: string): Promise<GstResult> {
    const doc = await tx.selectFrom('app.document').select(['id', 'party_id', 'location_node_id', 'custom', 'currency']).where('tenant_id', '=', tenantId).where('id', '=', docId).executeTakeFirstOrThrow();
    const custom = (doc.custom ?? {}) as Record<string, unknown>;
    const lines = await this.lines(tx, tenantId, docId);
    const tenant = await this.calendar.currencyAndState(tenantId);
    const vendor = doc.party_id
      ? await tx.selectFrom('app.master_record').select('data').where('tenant_id', '=', tenantId).where('id', '=', doc.party_id).executeTakeFirst()
      : undefined;
    const vdata = (vendor?.data ?? {}) as Record<string, unknown>;

    // ---- tax codes
    const codeIds = [...new Set(lines.map(l => l.custom.tax_code).filter((x): x is string => typeof x === 'string'))];
    const codes = codeIds.length
      ? new Map((await tx.selectFrom('app.master_record').select(['id', 'data']).where('tenant_id', '=', tenantId).where('id', 'in', codeIds).execute())
        .map(r => [r.id, r.data as Record<string, unknown>]))
      : new Map<string, Record<string, unknown>>();
    const shipTo = (await shipToState(tx, tenantId, doc.location_node_id)) ?? tenant.stateCode;
    const gst = computeGst({
      lines: lines.map(l => {
        const c = typeof l.custom.tax_code === 'string' ? codes.get(l.custom.tax_code) : undefined;
        return { id: l.id, qty: l.qty, rate: l.rate, discountPct: l.custom.discount_pct as string | null, ratePct: c?.rate_pct as string | null, cessPct: c?.cess_pct as string | null };
      }),
      vendorState: typeof vdata.state_code === 'string' ? vdata.state_code : null,
      shipToState: shipTo,
      discountAmount: custom.discount_amount as string | null, freight: custom.freight as string | null, otherCharges: custom.other_charges as string | null,
    });
    await tx.deleteFrom('app.line_tax').where('tenant_id', '=', tenantId).where('document_id', '=', docId).execute();
    const taxRows = lines.flatMap(l => (gst.lines[l.id]?.taxes ?? []).map(t => ({
      tenant_id: tenantId, line_id: l.id, document_id: docId, component: t.component, rate_pct: t.ratePct, taxable_amount: t.taxableAmount, tax_amount: t.taxAmount,
    })));
    if (taxRows.length) await tx.insertInto('app.line_tax').values(taxRows).execute();

    // ---- expected dates (per line: follow-up revision, else earliest open schedule date, else required date)
    const lineExpected = new Map<string, string | null>();
    for (const l of lines) {
      const revised = typeof l.custom[LINE_RESERVED.revisedExpected] === 'string' ? l.custom[LINE_RESERVED.revisedExpected] as string : null;
      const sched = parseSchedule(l.custom.schedule).rows;
      const exp = revised ?? (sched.length ? openScheduleDate(sched, toUnits(l.received ?? '0')) : l.required_date);
      lineExpected.set(l.id, exp);
      if ((l.custom.expected_date ?? null) !== exp) {
        await tx.updateTable('app.document_line').set({ custom: jsonPatch('custom', { expected_date: exp }) })
          .where('tenant_id', '=', tenantId).where('id', '=', l.id).execute();
      }
    }
    const open = lines.filter(l => !l.is_closed && toUnits(l.qty) > 0n).map(l => lineExpected.get(l.id)).filter((d): d is string => !!d).sort();
    const headerRevised = typeof custom[RESERVED.revisedExpected] === 'string' ? custom[RESERVED.revisedExpected] as string : null;
    const expected = headerRevised ?? open[0] ?? null;

    const currency = typeof custom.currency === 'string' && custom.currency.trim()
      ? custom.currency.trim().toUpperCase()
      : (typeof vdata.currency === 'string' && vdata.currency) ? vdata.currency : tenant.currency;
    const t = gst.totals;
    const patch: Record<string, unknown> = {
      currency, expected_date: expected,
      [TOTAL_FIELDS.taxable]: t.taxable, [TOTAL_FIELDS.cgst]: t.cgst, [TOTAL_FIELDS.sgst]: t.sgst, [TOTAL_FIELDS.igst]: t.igst,
      [TOTAL_FIELDS.cess]: t.cess, [TOTAL_FIELDS.tax]: t.tax, [TOTAL_FIELDS.grand]: t.grand,
    };
    await tx.updateTable('app.document').set({ custom: jsonPatch('custom', patch), currency: currency.slice(0, 3) })
      .where('tenant_id', '=', tenantId).where('id', '=', docId).execute();
    return gst;
  }
}

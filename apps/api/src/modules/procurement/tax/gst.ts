import type { TaxLine } from '@procure/schema';
import Decimal from 'decimal.js';

/**
 * GST engine (pure, decimal-exact). ADR-0013: tax is a rule driven by data (tax_code master rates, vendor and
 * ship-to state codes), never tenant code.
 *
 * Per line:  gross = qty × rate;  line discount = gross × discount_pct / 100;  net = round2(gross − line discount).
 * Header `discount_amount` is a trade discount before tax: allocated over lines pro-rata to net (round2 per line, the
 * rounding remainder goes to the last line with a net amount) → taxable = net − allocated discount.
 * Same state (vendor state = ship-to state) → CGST + SGST at rate/2 each; otherwise (or vendor state unknown) → IGST.
 * Cess (cess_pct) on top of either. Every tax amount is rounded to 2 places per line and component (half-up);
 * totals are sums of the rounded line figures. Freight and other charges are added to the grand total untaxed.
 */
export interface GstLineInput { id: string; qty: string; rate: string | null; discountPct: string | null; ratePct: string | null; cessPct: string | null }
export interface GstInput {
  lines: GstLineInput[];
  vendorState: string | null;
  shipToState: string | null;
  discountAmount?: string | null;
  freight?: string | null;
  otherCharges?: string | null;
}
export interface GstTotals {
  gross: string; lineDiscount: string; headerDiscount: string; taxable: string;
  cgst: string; sgst: string; igst: string; cess: string; tax: string;
  freight: string; otherCharges: string; grand: string; intraState: boolean;
}
export interface GstResult { lines: Record<string, { net: string; taxable: string; taxes: TaxLine[] }>; totals: GstTotals }

const D = (v: string | number | null | undefined) => {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  try {
    return new Decimal(v);
  } catch {
    return new Decimal(0);
  }
};
export const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const s2 = (d: Decimal) => round2(d).toFixed(2);
const pct = (d: Decimal) => d.toDecimalPlaces(4).toString();

export const normState = (s: unknown): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t ? t.padStart(2, '0') : null;
};

export function computeGst(input: GstInput): GstResult {
  const vendor = normState(input.vendorState);
  const shipTo = normState(input.shipToState);
  const intra = !!vendor && !!shipTo && vendor === shipTo;
  let gross = new Decimal(0);
  let lineDisc = new Decimal(0);
  const nets = input.lines.map(l => {
    const g = D(l.qty).mul(D(l.rate));
    const disc = g.mul(D(l.discountPct)).div(100);
    gross = gross.add(g);
    lineDisc = lineDisc.add(disc);
    return round2(g.sub(disc));
  });
  const netTotal = nets.reduce((a, b) => a.add(b), new Decimal(0));
  let headerDisc = round2(D(input.discountAmount));
  if (headerDisc.gt(netTotal)) headerDisc = netTotal;
  if (headerDisc.lt(0)) headerDisc = new Decimal(0);
  // Pro-rata allocation of the header discount; remainder on the last line that has a net amount.
  const alloc = nets.map(() => new Decimal(0));
  if (headerDisc.gt(0) && netTotal.gt(0)) {
    let given = new Decimal(0);
    let last = -1;
    nets.forEach((n, i) => { if (n.gt(0)) last = i; });
    nets.forEach((n, i) => {
      if (i === last || !n.gt(0)) return;
      alloc[i] = round2(headerDisc.mul(n).div(netTotal));
      given = given.add(alloc[i]!);
    });
    if (last >= 0) alloc[last] = headerDisc.sub(given);
  }
  const out: GstResult['lines'] = {};
  let taxable = new Decimal(0);
  const sum = { cgst: new Decimal(0), sgst: new Decimal(0), igst: new Decimal(0), cess: new Decimal(0) };
  input.lines.forEach((l, i) => {
    const t = nets[i]!.sub(alloc[i]!);
    taxable = taxable.add(t);
    const taxes: TaxLine[] = [];
    const rate = D(l.ratePct);
    const cess = D(l.cessPct);
    const add = (component: TaxLine['component'], r: Decimal) => {
      const amt = round2(t.mul(r).div(100));
      sum[component] = sum[component].add(amt);
      taxes.push({ component, ratePct: pct(r), taxableAmount: s2(t), taxAmount: amt.toFixed(2) });
    };
    if (rate.gt(0)) {
      if (intra) {
        add('cgst', rate.div(2));
        add('sgst', rate.div(2));
      } else add('igst', rate);
    }
    if (cess.gt(0)) add('cess', cess);
    out[l.id] = { net: s2(nets[i]!), taxable: s2(t), taxes };
  });
  const tax = sum.cgst.add(sum.sgst).add(sum.igst).add(sum.cess);
  const freight = round2(D(input.freight));
  const other = round2(D(input.otherCharges));
  return {
    lines: out,
    totals: {
      gross: s2(gross), lineDiscount: s2(lineDisc), headerDiscount: s2(headerDisc), taxable: s2(taxable),
      cgst: s2(sum.cgst), sgst: s2(sum.sgst), igst: s2(sum.igst), cess: s2(sum.cess), tax: s2(tax),
      freight: s2(freight), otherCharges: s2(other), grand: s2(taxable.add(tax).add(freight).add(other)), intraState: intra,
    },
  };
}

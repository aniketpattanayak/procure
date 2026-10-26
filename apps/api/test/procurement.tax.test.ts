import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeGst, GstInput } from '../src/modules/procurement/tax/gst';
import { mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { approvedSelection, approvePo, poApi, poTenant, PoFixture } from './procurement-po-helpers';

const L = (id: string, qty: string, rate: string, ratePct: string | null, extra: Partial<GstInput['lines'][number]> = {}) =>
  ({ id, qty, rate, discountPct: null, ratePct, cessPct: null, ...extra });

describe('GST engine (pure, table-driven)', () => {
  const cases: { name: string; input: GstInput; lines: Record<string, [string, string, string][]>; totals: Partial<ReturnType<typeof computeGst>['totals']> }[] = [
    {
      name: 'intra-state: CGST + SGST at half rate each',
      input: { lines: [L('a', '10', '100', '18')], vendorState: '27', shipToState: '27' },
      lines: { a: [['cgst', '9', '90.00'], ['sgst', '9', '90.00']] },
      totals: { taxable: '1000.00', cgst: '90.00', sgst: '90.00', igst: '0.00', tax: '180.00', grand: '1180.00', intraState: true },
    },
    {
      name: 'inter-state: IGST',
      input: { lines: [L('a', '10', '100', '18')], vendorState: '33', shipToState: '27' },
      lines: { a: [['igst', '18', '180.00']] },
      totals: { igst: '180.00', cgst: '0.00', grand: '1180.00', intraState: false },
    },
    {
      name: 'vendor without a state code → IGST',
      input: { lines: [L('a', '1', '100', '5')], vendorState: null, shipToState: '27' },
      lines: { a: [['igst', '5', '5.00']] },
      totals: { igst: '5.00', intraState: false },
    },
    {
      name: 'state codes are normalised ("7" = "07")',
      input: { lines: [L('a', '1', '100', '12')], vendorState: '7', shipToState: '07' },
      lines: { a: [['cgst', '6', '6.00'], ['sgst', '6', '6.00']] },
      totals: { tax: '12.00' },
    },
    {
      name: 'cess on top of IGST',
      input: { lines: [L('a', '2', '500', '28', { cessPct: '12' })], vendorState: '29', shipToState: '27' },
      lines: { a: [['igst', '28', '280.00'], ['cess', '12', '120.00']] },
      totals: { igst: '280.00', cess: '120.00', tax: '400.00', grand: '1400.00' },
    },
    {
      name: 'line discount % reduces the taxable value',
      input: { lines: [L('a', '3', '33.33', '18', { discountPct: '10' })], vendorState: '27', shipToState: '27' },
      // gross 99.99, discount 9.999 → net 89.991 → 89.99; tax 9% = 8.0991 → 8.10 each
      lines: { a: [['cgst', '9', '8.10'], ['sgst', '9', '8.10']] },
      totals: { gross: '99.99', lineDiscount: '10.00', taxable: '89.99', tax: '16.20', grand: '106.19' },
    },
    {
      name: 'header discount allocated pro-rata before tax; remainder on the last line',
      input: { lines: [L('a', '1', '100', '18'), L('b', '1', '200', '5')], vendorState: '33', shipToState: '27', discountAmount: '10' },
      // a: 10 × 100/300 = 3.33 → taxable 96.67; b gets 6.67 → 193.33
      lines: { a: [['igst', '18', '17.40']], b: [['igst', '5', '9.67']] },
      totals: { headerDiscount: '10.00', taxable: '290.00', igst: '27.07', grand: '317.07' },
    },
    {
      name: 'freight and other charges are added untaxed',
      input: { lines: [L('a', '1', '1000', '18')], vendorState: '27', shipToState: '27', freight: '150.5', otherCharges: '49.5' },
      lines: { a: [['cgst', '9', '90.00'], ['sgst', '9', '90.00']] },
      totals: { freight: '150.50', otherCharges: '49.50', grand: '1380.00' },
    },
    {
      name: 'rounding per line and component (half-up), totals are sums of rounded figures',
      input: { lines: [L('a', '1', '0.25', '18'), L('b', '1', '0.25', '18'), L('c', '1', '0.25', '18')], vendorState: '27', shipToState: '27' },
      // 0.25 × 9% = 0.0225 → 0.02 per component per line
      lines: { a: [['cgst', '9', '0.02'], ['sgst', '9', '0.02']], b: [['cgst', '9', '0.02'], ['sgst', '9', '0.02']], c: [['cgst', '9', '0.02'], ['sgst', '9', '0.02']] },
      totals: { taxable: '0.75', cgst: '0.06', sgst: '0.06', tax: '0.12', grand: '0.87' },
    },
    {
      name: 'zero-rated and untaxed lines carry no tax rows; header discount larger than value is capped',
      input: { lines: [L('a', '1', '50', '0'), L('b', '1', '50', null)], vendorState: '27', shipToState: '27', discountAmount: '500' },
      lines: { a: [], b: [] },
      totals: { headerDiscount: '100.00', taxable: '0.00', tax: '0.00', grand: '0.00' },
    },
    {
      name: 'decimal-exact on large values (no float drift)',
      input: { lines: [L('a', '123456.789', '987.6543', '18')], vendorState: '33', shipToState: '27' },
      // 123456.789 × 987.6543 = 121932628.5200427 → 121932628.52; 18% = 21947873.1336 → 21947873.13
      lines: { a: [['igst', '18', '21947873.13']] },
      totals: { taxable: '121932628.52', grand: '143880501.65' },
    },
  ];
  for (const t of cases) {
    it(t.name, () => {
      const r = computeGst(t.input);
      for (const [id, comps] of Object.entries(t.lines)) {
        expect(r.lines[id]!.taxes.map(x => [x.component, x.ratePct, x.taxAmount])).toEqual(comps);
      }
      expect(r.totals).toMatchObject(t.totals);
    });
  }
});

describe('GST on purchase orders (API)', () => {
  let c: Ctx;
  let f: PoFixture;
  beforeAll(async () => {
    c = await bootApp();
    f = await poTenant(c);
  });
  afterAll(async () => closeApp(c));

  it('Maharashtra vendor → CGST + SGST; Tamil Nadu vendor → IGST; line_tax rows + header totals on every save', async () => {
    // item 0 = GST18, item 1 = GST12
    const { selection } = await approvedSelection(c, f, ['10', '4'], [[0, 0, '10', '100'], [1, 0, '4', '250']]);
    const p = poApi(c, f.po.token);
    const [po] = await mustOk(p.fromLines({ picks: selection.lines.map((l: { id: string; values: { qty: string } }) => ({ sourceLineId: l.id, qty: String(Number(l.values.qty)) })) }), 201);
    expect(po.values).toMatchObject({ taxable_amount: '2000.00', cgst_amount: '150.00', sgst_amount: '150.00', igst_amount: '0.00', grand_total: '2300.00' });
    const taxes = await mustOk(p.taxes(po.id));
    expect(taxes.lines[po.lines[0].id]).toEqual([
      { component: 'cgst', ratePct: '9', taxableAmount: '1000.00', taxAmount: '90.00' }, { component: 'sgst', ratePct: '9', taxableAmount: '1000.00', taxAmount: '90.00' },
    ]);
    expect(taxes.lines[po.lines[1].id].map((t: { component: string; taxAmount: string }) => [t.component, t.taxAmount])).toEqual([['cgst', '60.00'], ['sgst', '60.00']]);
    expect(taxes.totals).toMatchObject({ taxable: '2000.00', tax: '300.00', grand: '2300.00' });

    // edit: discount, freight → recomputed on save
    const ed = await mustOk(p.update(po.id, {
      version: po.version, values: { ...pickHeader(po.values), discount_amount: '200', freight: '50' },
      lines: po.lines.map((l: { id: string; values: Record<string, unknown> }) => ({ id: l.id, values: l.values })),
    }));
    // discount 200 over 1000/1000 → 100 each → taxable 900 + 900; tax 162 + 108 = 270; grand 1800 + 270 + 50
    expect(ed.values).toMatchObject({ taxable_amount: '1800.00', tax_amount: '270.00', grand_total: '2120.00' });

    // Tamil Nadu vendor (state 33) → IGST
    const { selection: s2 } = await approvedSelection(c, f, ['10'], [[0, 1, '10', '100']]);
    const [igst] = await mustOk(p.fromLines({ picks: [{ sourceLineId: s2.lines[0].id, qty: '10' }] }), 201);
    expect(igst.values).toMatchObject({ igst_amount: '180.00', cgst_amount: '0.00', grand_total: '1180.00' });
    // a different tax code chosen on the line wins over the item's
    const line = igst.lines[0];
    const changed = await mustOk(p.update(igst.id, { version: igst.version, values: pickHeader(igst.values), lines: [{ id: line.id, values: { ...line.values, tax_code: f.taxCodes.GST28 } }] }));
    expect(changed.values.igst_amount).toBe('280.00');
    const sub = await mustOk(p.submit(changed.id, changed.version));
    await approvePo(c, f, sub);
    expect((await mustOk(p.taxes(sub.id))).totals.igst).toBe('280.00');
  });

  it('ship-to state from the nearest ancestor with a state code (Pune Store → Pune Plant 27)', async () => {
    const { selection } = await approvedSelection(c, f, ['1'], [[0, 0, '1', '100']], { location: f.puneStore });
    const [po] = await mustOk(poApi(c, f.po.token).fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '1' }] }), 201);
    expect(po.values.location).toBe(f.puneStore);
    expect(po.values).toMatchObject({ cgst_amount: '9.00', sgst_amount: '9.00' });
    // Chennai has no state code and the tenant address none → inter-state
    const { selection: ch } = await approvedSelection(c, f, ['1'], [[0, 0, '1', '100']], { location: f.chennai });
    const [cpo] = await mustOk(poApi(c, f.po.token).fromLines({ picks: [{ sourceLineId: ch.lines[0].id, qty: '1' }] }), 201);
    expect(cpo.values).toMatchObject({ igst_amount: '18.00' });
  });
});

function pickHeader(v: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of ['location', 'party', 'doc_date', 'payment_terms', 'terms', 'freight', 'other_charges', 'discount_amount', 'currency']) if (v[k] !== undefined) out[k] = v[k];
  return out;
}

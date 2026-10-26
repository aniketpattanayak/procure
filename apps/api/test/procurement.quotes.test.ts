import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DbService } from '../src/core/db.service';
import { vendorQuoteSource } from '../src/modules/procurement';
import { effectiveRate, freightPerUnit, landedCost, validateSlabs } from '../src/modules/procurement/quotes/slabs';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { approvedIndent, BUYER_KEYS, proc, procTenant, ProcFixture, quote, scoped, submittedIndent } from './procurement-helpers';

describe('slab maths (pure)', () => {
  const slabQuote = [{ fromQty: '0', toQty: '999', rate: '50' }, { fromQty: '1000', discountPct: '10' }];
  it.each([
    ['1', '50'], ['500', '50'], ['999', '50'], ['999.5', '50' /* gap → base rate */], ['1000', '45'], ['1000.001', '45'], ['25000', '45'],
  ])('rate + discount slabs at %s kg → %s', (qty, rate) => expect(effectiveRate('50', slabQuote, qty)).toBe(rate));

  it.each([
    ['10', '100'], ['99', '100'], ['100', '95.5'], ['499', '95.5'], ['500', '90'], ['9999', '90'],
  ])('absolute rate slabs at %s → %s', (qty, rate) => {
    expect(effectiveRate('100', [{ fromQty: '100', toQty: '499', rate: '95.5' }, { fromQty: '500', rate: '90' }], qty)).toBe(rate);
  });

  it.each([
    ['12.5', '87.5'], ['33.3333', '66.6667'], ['100', '0'],
  ])('discount %s%% off 100 → %s', (pct, rate) => expect(effectiveRate('100', [{ fromQty: '0', discountPct: pct }], '5')).toBe(rate));

  it('no slabs → quoted rate', () => expect(effectiveRate('42.125', [], '7')).toBe('42.125'));

  it('validates slabs: overlap, open-ended in the middle, inverted range, discount > 100', () => {
    expect(validateSlabs([{ fromQty: '0', toQty: '999', rate: '50' }, { fromQty: '1000', discountPct: '10' }])).toEqual([]);
    expect(validateSlabs([{ fromQty: '0', toQty: '1000', rate: '50' }, { fromQty: '1000', discountPct: '10' }])).toEqual([{ path: 'slabs.1.fromQty', message: 'Slabs overlap.' }]);
    expect(validateSlabs([{ fromQty: '1000', discountPct: '10' }, { fromQty: '0', rate: '50' }])).toEqual([{ path: 'slabs.1.toQty', message: 'Only the last slab may be open-ended.' }]);
    expect(validateSlabs([{ fromQty: '10', toQty: '5', rate: '1' }]).map(i => i.path)).toEqual(['slabs.0.toQty']);
    expect(validateSlabs([{ fromQty: '0', discountPct: '120' }]).map(i => i.path)).toEqual(['slabs.0.discountPct']);
  });

  it('freight per unit and landed cost (default + custom formula + broken formula falls back)', () => {
    expect(freightPerUnit('1000', 'lump_sum', '400')).toBe('2.5');
    expect(freightPerUnit('3', 'per_unit', '400')).toBe('3');
    expect(freightPerUnit('100', 'lump_sum', '0')).toBe('0');
    const v = { rate: '45', qty: '1000', freight: '500', freight_per_unit: '0.5', tax_pct: '18', lead_time_days: 10, moq: null };
    expect(landedCost('rate * (1 + tax_pct / 100) + freight_per_unit', v).perUnit).toBe('53.6');
    expect(landedCost('rate + freight_per_unit + lead_time_days * 0.1', v).perUnit).toBe('46.5');
    const broken = landedCost('rate * (', v);
    expect(broken).toEqual({ perUnit: '53.6', usedDefault: true });
  });
});

let c: Ctx;
let f: ProcFixture;
beforeAll(async () => {
  c = await bootApp();
  f = await procTenant(c);
});
afterAll(async () => closeApp(c));

describe('quote log', () => {
  it('logs quotes append-only: versions, supersedes, history with ?all=true', async () => {
    const ind = await approvedIndent(c, f, ['100']);
    const line = ind.lines[0].id;
    const p = proc(c, f.buyer.token);
    const [q1] = await mustOk(p.logQuote(line, quote(f.vendors[0], { quotedRate: '50' })), 201);
    expect(q1).toMatchObject({ version: 1, isCurrent: true, supersedesId: null, quotedRate: '50', vendor: { id: f.vendors[0], name: 'Vendor A' }, indentLineId: line });
    expect(q1.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/); // default from procurement.quote_validity_days
    const q2 = await mustOk(p.revise(q1.id, quote(f.vendors[0], { quotedRate: '48' })));
    expect(q2).toMatchObject({ version: 2, isCurrent: true, supersedesId: q1.id, quotedRate: '48' });
    // logging the same vendor again supersedes too
    const [q3] = await mustOk(p.logQuote(line, quote(f.vendors[0], { quotedRate: '47', validUntil: '2099-01-01' })), 201);
    expect(q3).toMatchObject({ version: 3, supersedesId: q2.id, validUntil: '2099-01-01' });
    // editing a superseded version is refused
    expect((await p.revise(q1.id, quote(f.vendors[0]))).status).toBe(409);
    expect((await p.revise(q3.id, quote(f.vendors[1]))).status).toBe(400);
    const cur = await mustOk(p.quotes(line));
    expect(cur.map((q: { version: number }) => q.version)).toEqual([3]);
    const all = await mustOk(p.quotes(line, true));
    expect(all.map((q: { version: number; quotedRate: string; isCurrent: boolean }) => [q.version, q.quotedRate, q.isCurrent])).toEqual([[3, '47', true], [2, '48', false], [1, '50', false]]);
    // never overwritten: rows in the DB keep their original rates
    const rows = await c.db.selectFrom('app.vendor_quote').select(['version', 'quoted_rate']).where('indent_line_id', '=', line).orderBy('version').execute();
    expect(rows.map(r => Number(r.quoted_rate))).toEqual([50, 48, 47]);
    // outbox
    const ev = await c.db.selectFrom('app.outbox_event').select('payload').where('tenant_id', '=', f.tenantId).where('event_type', '=', 'indent.quote_logged').execute();
    expect(ev.length).toBeGreaterThanOrEqual(3);
  });

  it('logs one quote for several lines of the same item (alsoForLineIds)', async () => {
    const a = await approvedIndent(c, f, ['10'], { items: [f.items[1]!] });
    const b = await approvedIndent(c, f, ['20'], { items: [f.items[1]!] });
    const other = await approvedIndent(c, f, ['5'], { items: [f.items[2]!] });
    const p = proc(c, f.buyer.token);
    const rows = await mustOk(p.logQuote(a.lines[0].id, quote(f.vendors[1], { alsoForLineIds: [b.lines[0].id] })), 201);
    expect(rows.map((r: { indentLineId: string }) => r.indentLineId)).toEqual([a.lines[0].id, b.lines[0].id]);
    const res = await p.logQuote(a.lines[0].id, quote(f.vendors[1], { alsoForLineIds: [other.lines[0].id] }));
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe('alsoForLineIds.0');
  });

  it('validates vendor, line state and slabs', async () => {
    const ind = await approvedIndent(c, f, ['10']);
    const line = ind.lines[0].id;
    const p = proc(c, f.buyer.token);
    const slabRes = await p.logQuote(line, quote(f.vendors[0], { slabs: [{ fromQty: '0', toQty: '100', rate: '5' }, { fromQty: '50', rate: '4' }] }));
    expect(slabRes.status).toBe(400);
    expect(slabRes.body.errors[0].path).toBe('slabs.1.fromQty');
    expect((await p.logQuote(line, quote(f.items[0]!))).status).toBe(400); // not a vendor
    expect((await p.logQuote(line, quote(f.vendors[0], { slabs: [{ fromQty: '0', rate: '1', discountPct: '2' }] }))).status).toBe(400);
    // inactive vendor
    const v = await mustOk(api(c, f.token).post('/masters/vendor/records', { name: 'Sleepy vendor', data: {} }), 201);
    await mustOk(api(c, f.token).post(`/masters/vendor/records/${v.id}/deactivate`, {}), 200, 201);
    expect((await p.logQuote(line, quote(v.id))).body.errors?.[0]?.message).toBe('This vendor is inactive.');
    // line not approved yet
    const sub = await submittedIndent(c, f, ['5']);
    expect((await p.logQuote(sub.lines[0].id, quote(f.vendors[0]))).status).toBe(409);
    // unknown line
    expect((await p.logQuote('00000000-0000-7000-8000-000000000000', quote(f.vendors[0]))).status).toBe(404);
  });

  it('permissions: no log_quote → 403; compare needs compare; out-of-scope lines are 404', async () => {
    const ind = await approvedIndent(c, f, ['10']);
    const line = ind.lines[0].id;
    const viewer = await scoped(c, f.token, f.code, BUYER_KEYS.filter(k => !k.endsWith('log_quote') && !k.endsWith('compare')));
    expect((await proc(c, viewer.token).logQuote(line, quote(f.vendors[0]))).status).toBe(403);
    expect((await proc(c, viewer.token).compareLine(line)).status).toBe(403);
    expect((await proc(c, viewer.token).quotes(line)).status).toBe(200);
    const chennaiBuyer = await scoped(c, f.token, f.code, BUYER_KEYS, f.chennai);
    expect((await proc(c, chennaiBuyer.token).logQuote(line, quote(f.vendors[0]))).status).toBe(404);
    expect((await proc(c, chennaiBuyer.token).quotes(line)).status).toBe(404);
    expect((await proc(c, chennaiBuyer.token).compareLine(line)).status).toBe(404);
  });
});

describe('comparison sheet', () => {
  it('applies slabs at qty, computes landed cost and picks the best valid quote with warnings', async () => {
    const ind = await approvedIndent(c, f, ['1200'], { items: [f.items[0]!] });
    const line = ind.lines[0].id;
    const p = proc(c, f.buyer.token);
    // A: slab quote ₹50/kg ≤ 999, 10% off ≥ 1000; 18% tax; freight 1200 lump sum
    await mustOk(p.logQuote(line, quote(f.vendors[0], { quotedRate: '50', taxPct: '18', freight: '1200', slabs: [{ fromQty: '0', toQty: '999', rate: '50' }, { fromQty: '1000', discountPct: '10' }] })), 201);
    // B: ₹44 but MOQ 5000 → below_moq
    await mustOk(p.logQuote(line, quote(f.vendors[1], { quotedRate: '44', taxPct: '18', moq: '5000' })), 201);
    // C: ₹40 but expired
    await mustOk(p.logQuote(line, quote(f.vendors[2], { quotedRate: '40', taxPct: '18', validUntil: '2020-01-01' })), 201);
    const s = await mustOk(p.compareLine(line));
    expect(s.qty).toBe('1200');
    expect(s.itemName).toBe('Steel rod');
    expect(s.lines).toEqual([{ lineId: line, documentNumber: ind.number, lineNo: 1, pendingSelection: '1200' }]);
    const by = (name: string) => s.vendors.find((v: { vendor: { name: string } }) => v.vendor.name === name);
    expect(by('Vendor A')).toMatchObject({ effectiveRate: '45', freightPerUnit: '1', landedCostPerUnit: '54.1', landedTotal: '64920', isBest: true, warnings: [] });
    expect(by('Vendor B')).toMatchObject({ isBest: false, warnings: ['below_moq'], moq: '5000' });
    expect(by('Vendor C')).toMatchObject({ isBest: false, expired: true, warnings: ['expired'] });
    expect(s.history).toEqual([]);
    // at 999 kg the slab gives ₹50
    const s999 = await mustOk(p.compareLine(line, '999'));
    expect(s999.vendors.find((v: { vendor: { name: string } }) => v.vendor.name === 'Vendor A').effectiveRate).toBe('50');
  });

  it('uses the tenant landed-cost formula and flags other currencies', async () => {
    const ind = await approvedIndent(c, f, ['100'], { items: [f.items[2]!] });
    const line = ind.lines[0].id;
    const p = proc(c, f.buyer.token);
    await mustOk(p.logQuote(line, quote(f.vendors[0], { quotedRate: '10', taxPct: '0', leadTimeDays: 30 })), 201);
    await mustOk(p.logQuote(line, quote(f.vendors[1], { quotedRate: '11', taxPct: '0', leadTimeDays: 0 })), 201);
    await mustOk(p.logQuote(line, quote(f.vendors[2], { quotedRate: '1', taxPct: '0', currency: 'USD' })), 201);
    let s = await mustOk(p.compareLine(line));
    expect(s.vendors.find((v: { isBest: boolean }) => v.isBest).vendor.name).toBe('Vendor A');
    expect(s.vendors.find((v: { vendor: { name: string } }) => v.vendor.name === 'Vendor C').warnings).toEqual(['currency_differs']);
    // lead time costs 0.1 per day → B wins
    await mustOk(proc(c, f.token).setSettings({ 'procurement.landed_cost_formula': 'rate + lead_time_days * 0.1' }));
    s = await mustOk(p.compareLine(line));
    expect(s.vendors.map((v: { vendor: { name: string }; landedCostPerUnit: string }) => [v.vendor.name, v.landedCostPerUnit])).toEqual([['Vendor C', '1.7'], ['Vendor B', '11'], ['Vendor A', '13']]);
    expect(s.vendors.find((v: { isBest: boolean }) => v.isBest).vendor.name).toBe('Vendor B');
    await mustOk(proc(c, f.token).setSettings({ 'procurement.landed_cost_formula': null }));
  });

  it('item-wise comparison across open indent lines of the item (optionally per location)', async () => {
    const item = (await mustOk(api(c, f.token).post('/masters/item/records', { name: 'Gasket', data: { uom: f.kg } }), 201)).id;
    const a = await approvedIndent(c, f, ['30'], { items: [item] });
    const b = await approvedIndent(c, f, ['70'], { items: [item], location: f.chennai });
    const p = proc(c, f.buyer.token);
    await mustOk(p.logQuote(a.lines[0].id, quote(f.vendors[0], { quotedRate: '9' })), 201);
    await mustOk(p.logQuote(b.lines[0].id, quote(f.vendors[0], { quotedRate: '8' })), 201);
    await mustOk(p.logQuote(b.lines[0].id, quote(f.vendors[1], { quotedRate: '8.5' })), 201);
    const s = await mustOk(p.compareItem(item));
    expect(s.qty).toBe('100');
    expect(s.lines.map((l: { pendingSelection: string }) => l.pendingSelection).sort()).toEqual(['30', '70']);
    expect(s.vendors.map((v: { vendor: { name: string }; quotesLogged: number; quotedRate: string }) => [v.vendor.name, v.quotedRate, v.quotesLogged])).toEqual([['Vendor A', '8', 2], ['Vendor B', '8.5', 1]]);
    const pune = await mustOk(p.compareItem(item, f.pune));
    expect(pune.qty).toBe('30');
    expect(pune.vendors.map((v: { vendor: { name: string } }) => v.vendor.name)).toEqual(['Vendor A']);
  });
});

describe('report source vendor_quote', () => {
  it('describes allow-listed columns whose SQL runs under tenant RLS', async () => {
    const src = vendorQuoteSource();
    expect(src).toMatchObject({ key: 'vendor_quote', viewKey: 'doc.indent:action.view', requiresFeature: 'vendor_quotes' });
    const ind = await approvedIndent(c, f, ['10']);
    await mustOk(proc(c, f.buyer.token).logQuote(ind.lines[0].id, quote(f.vendors[0], { slabs: [{ fromQty: '0', rate: '49' }] })), 201);
    const rows = await c.app.get(DbService).tenantTx(f.tenantId, async tx => {
      const b = await src.build({ tx, tenantId: f.tenantId, userId: null });
      const cols = sql.join(b.fields.map(x => sql`${x.expr} as ${sql.ref(x.id.replace('.', '_'))}`));
      return (await sql<Record<string, unknown>>`select ${b.rowId} as id, ${b.link} as link, ${b.scope!.path}::text as path, ${cols} from ${b.from} where ${sql.join(b.where, sql` and `)} and d.id = ${ind.id}`.execute(tx)).rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vendor_name: 'Vendor A', indent_number: ind.number, has_slabs: true, is_current: true, link: `/docs/indent/${ind.id}` });
  });
});

/**
 * QA batch (Phases 4/6/7) — procurement, black-box through the HTTP API:
 *   partial quantities end to end (indent partial approval → over-approval within the cap → split selection →
 *   selection reduction → several POs per vendor / ship-to → partial PO approval → re-order of the remainder →
 *   concurrent last-unit orders), GST intra/inter-state incl. edge inputs, PO amendment diff + re-approval,
 *   quote versions / slabs / landed cost, permission enforcement (403) for every Phase 4 action key, and
 *   cross-tenant isolation on every Phase 4 endpoint.
 *
 * Known bugs are `it.fails` with their QA47-BUG id (docs/qa/phase-4-6-7-report.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import { ALL_VIEWS, approvedIndent, BUYER_KEYS, docs, proc, quote, scoped } from './procurement-helpers';
import { approvedSelection, approvePo, decidePo, poApi, poTenant, PoFixture, PO_VIEWS, qtyOf, setSettings } from './procurement-po-helpers';

type Line = { id: string; values: Record<string, unknown>; qty: Record<string, string> };
type Doc = { id: string; version: number; number: string | null; statusKey: string; values: Record<string, unknown>; lines: Line[] };

const sel = (indentLineId: string, vendorId: string, qty: string, extra: Record<string, unknown> = {}) => ({ indentLineId, vendorId, qty, rate: '100', ...extra });

let c: Ctx;
let f: PoFixture;
let senior: { token: string; userId: string; roleId: string };

beforeAll(async () => {
  c = await bootApp();
  f = await poTenant(c);
  senior = await scoped(c, f.token, f.code, [...BUYER_KEYS, 'doc.vendor_selection:action.over_approve']);
}, 120_000);
afterAll(async () => closeApp(c));

// ===================================================================================================== partial quantities
describe('partial quantities end to end', () => {
  it('indent 100 → approve 60 → select 30 A + 36 B (over-approved 6 = 10% cap) → selection cuts B to 30 → POs per vendor and ship-to → partial PO approval → remainder re-ordered', async () => {
    await setSettings(c, f.token, { 'selection.max_over_approval_pct': 10 });
    const ind = await approvedIndent(c, f, ['100', '50'], { approve: ['60', '50'] });
    const [l0, l1] = ind.lines as Line[];
    expect(await qtyOf(c, l0!.id)).toMatchObject({ requested: 100, approved: 60, rejected: 40 });
    expect(ind.statusKey).toBe('partially_approved');

    // cap = 10% of APPROVED (60) = 6, not of requested (100)
    const s = proc(c, senior.token);
    const over7 = await s.select({ submit: true, lines: [sel(l0!.id, f.vendors[0]!, '30'), sel(l0!.id, f.vendors[1]!, '37', { reason: 'Cutting wastage' })] });
    expect(over7.status).toBe(409);
    expect(over7.body.code).toBe('QTY_EXCEEDS_REMAINING');
    expect(await qtyOf(c, l0!.id)).toMatchObject({ selected: 0 }); // nothing half-applied

    const selection = await mustOk<Doc>(s.select({
      submit: true,
      lines: [sel(l0!.id, f.vendors[0]!, '30', { rate: '100' }), sel(l0!.id, f.vendors[1]!, '36', { rate: '95', reason: 'Cutting wastage' }), sel(l1!.id, f.vendors[2]!, '50', { rate: '40' })],
    }), 201);
    expect(selection.lines[1]!.values.over_qty).toBe('6.000');
    expect(await qtyOf(c, l0!.id)).toMatchObject({ approved: 60, selected: 66 });
    const sum0 = await c.db.selectFrom('app.line_qty_summary').select('over_approved').where('line_id', '=', l0!.id).executeTakeFirstOrThrow();
    expect(Number(sum0.over_approved)).toBe(6);
    // nothing left and the cap is used up
    expect((await s.select({ submit: true, lines: [sel(l0!.id, f.vendors[0]!, '1', { reason: 'one more' })] })).status).toBe(409);

    // selection approver trims B to 30 (6 back on the indent line), approves the rest
    const decided = await mustOk<Doc>(docs(c, f.token, 'vendor_selection').act(selection.id, {
      action: 'decide', stageKey: 'approve',
      decisions: [
        { lineId: selection.lines[0]!.id, approve: '30' },
        { lineId: selection.lines[1]!.id, approve: '30', reject: '6', reason: 'No over-supply' },
        { lineId: selection.lines[2]!.id, approve: '50' },
      ],
    }));
    expect(['approved', 'partially_approved']).toContain(decided.statusKey);
    expect(await qtyOf(c, l0!.id)).toMatchObject({ selected: 60 });

    // second indent for the same vendor A but shipped to Chennai → same vendor, different ship-to
    const { selection: chSel } = await approvedSelection(c, f, ['12'], [[0, 0, '12', '100']], { location: f.chennai });

    const p = poApi(c, f.po.token);
    const orderable = await mustOk(p.orderable(`q=${encodeURIComponent(selection.number!)}`));
    expect(orderable.data.map((r: { pendingOrder: string }) => r.pendingOrder).sort()).toEqual(['30', '30', '50']);

    // one call → one draft PO per (vendor, ship-to): A@Pune (20 of 30), B@Pune, C@Pune, A@Chennai
    const pos = await mustOk<Doc[]>(p.fromLines({
      picks: [
        { sourceLineId: selection.lines[0]!.id, qty: '20' }, { sourceLineId: selection.lines[1]!.id, qty: '30' },
        { sourceLineId: selection.lines[2]!.id, qty: '50' }, { sourceLineId: chSel.lines[0].id, qty: '12' },
      ],
    }), 201);
    expect(pos).toHaveLength(4);
    const key = (d: Doc) => `${d.values.party}|${d.values.location}`;
    expect(new Set(pos.map(key)).size).toBe(4);
    const poA = pos.find(d => d.values.party === f.vendors[0] && d.values.location === f.pune)!;
    const poB = pos.find(d => d.values.party === f.vendors[1])!;
    const poC = pos.find(d => d.values.party === f.vendors[2])!;
    const poACh = pos.find(d => d.values.party === f.vendors[0] && d.values.location === f.chennai)!;
    // GST: A (27) → Pune (27) intra; C (29) inter; A → Chennai (no state code, tenant none) inter
    expect(poA.values).toMatchObject({ cgst_amount: '180.00', sgst_amount: '180.00', igst_amount: '0.00', taxable_amount: '2000.00', grand_total: '2360.00' });
    expect(poC.values).toMatchObject({ igst_amount: '240.00', cgst_amount: '0.00' }); // item 1 = GST12 on 50 × 40
    expect(poACh.values).toMatchObject({ igst_amount: '216.00', cgst_amount: '0.00' }); // 12 × 100 × 18%

    // drafts reserve nothing
    expect(await qtyOf(c, selection.lines[0]!.id)).toMatchObject({ ordered: 0 });
    // submit + partial approval of B's PO: approve 25, reject 5 → 5 back to order on the selection line
    const subB = await mustOk<Doc>(p.submit(poB.id, poB.version));
    await mustOk(decidePo(c, f, poB.id, [{ lineId: subB.lines[0]!.id, approve: '25', reject: '5', reason: 'Only 25 needed now' }]));
    expect(await qtyOf(c, selection.lines[1]!.id)).toMatchObject({ ordered: 25 });
    const subA = await mustOk<Doc>(p.submit(poA.id, poA.version));
    await approvePo(c, f, subA as never);
    expect(await qtyOf(c, l0!.id)).toMatchObject({ ordered: 45 });

    // remainder of A: 10; asking 11 is refused, two concurrent POs for the last 10 → exactly one wins
    const tooMuch = await p.fromLines({ picks: [{ sourceLineId: selection.lines[0]!.id, qty: '11' }] });
    expect(tooMuch.status).toBe(400);
    const [x] = await mustOk<Doc[]>(p.fromLines({ picks: [{ sourceLineId: selection.lines[0]!.id, qty: '10' }] }), 201);
    const [y] = await mustOk<Doc[]>(p.fromLines({ picks: [{ sourceLineId: selection.lines[0]!.id, qty: '10' }] }), 201);
    const res = await Promise.all([p.submit(x!.id, x!.version), p.submit(y!.id, y!.version)]);
    expect(res.map(r => r.status).sort()).toEqual([200, 409]);
    expect(res.find(r => r.status === 409)!.body.code).toBe('QTY_EXCEEDS_REMAINING');
    expect(await qtyOf(c, selection.lines[0]!.id)).toMatchObject({ ordered: 30 });
    // B's 5 rejected units are orderable again
    const again = await mustOk(p.orderable(`q=${encodeURIComponent(selection.number!)}`));
    expect(again.data.find((r: { sourceLineId: string }) => r.sourceLineId === selection.lines[1]!.id)?.pendingOrder).toBe('5');
    await setSettings(c, f.token, { 'selection.max_over_approval_pct': null });
  });

  it('GST on the C (Karnataka 29 → Pune 27) PO is IGST at the item rate (GST12)', async () => {
    const { selection } = await approvedSelection(c, f, ['1', '50'], [[1, 2, '50', '40']]);
    const [po] = await mustOk<Doc[]>(poApi(c, f.po.token).fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '50' }] }), 201);
    expect(po!.values).toMatchObject({ taxable_amount: '2000.00', igst_amount: '240.00', cgst_amount: '0.00', sgst_amount: '0.00', grand_total: '2240.00' });
  });

  // QA47-BUG-001: excess (over-approved) qty rejected in the selection workflow stays in `over_approved`, so it is
  // selectable again by a buyer WITHOUT doc.vendor_selection:action.over_approve and without a reason.
  it('QA47-BUG-001: over-approved qty cut by the selection approver is not selectable again without the over_approve key', async () => {
    await setSettings(c, f.token, { 'selection.max_over_approval_pct': 10 });
    try {
      const ind = await approvedIndent(c, f, ['100']);
      const lid = ind.lines[0].id;
      const s = await mustOk<Doc>(proc(c, senior.token).select({ submit: true, lines: [sel(lid, f.vendors[0]!, '110', { reason: 'Cutting wastage' })] }), 201);
      await mustOk(docs(c, f.token, 'vendor_selection').act(s.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: s.lines[0]!.id, approve: '100', reject: '10', reason: 'Approved qty only' }] }));
      // a plain buyer (no over_approve key) now selects 10 more than the indent approved
      const r = await proc(c, f.buyer.token).select({ submit: true, lines: [sel(lid, f.vendors[1]!, '10')] });
      expect(r.status).toBe(409);
      // regression: the unused over-approval is taken back on the ledger; the cap is free again for the key holder
      const over = async () => Number((await c.db.selectFrom('app.line_qty_summary').select('over_approved').where('line_id', '=', lid).executeTakeFirstOrThrow()).over_approved);
      expect(await qtyOf(c, lid)).toMatchObject({ approved: 100, selected: 100 });
      expect(await over()).toBe(0);
      const ev = await c.db.selectFrom('app.line_event').select(['qty']).where('line_id', '=', lid).where('event_type', '=', 'over_approval_cancelled').execute();
      expect(ev.map(e => Number(e.qty))).toEqual([10]);
      expect((await proc(c, senior.token).select({ submit: true, lines: [sel(lid, f.vendors[1]!, '10')] })).status).toBe(400); // reason still needed
      await mustOk(proc(c, senior.token).select({ submit: true, lines: [sel(lid, f.vendors[1]!, '10', { reason: 'Second thoughts' })] }), 201);
      expect(await qtyOf(c, lid)).toMatchObject({ selected: 110 });
      expect(await over()).toBe(10);
    } finally {
      await setSettings(c, f.token, { 'selection.max_over_approval_pct': null });
    }
  });

  it('over-approval: setting 0 → never; without the key → 409; key but no reason → 400; cap counts earlier over-approvals', async () => {
    const ind = await approvedIndent(c, f, ['40']);
    const lid = ind.lines[0].id;
    await setSettings(c, f.token, { 'selection.max_over_approval_pct': 0 });
    expect((await proc(c, senior.token).select({ submit: true, lines: [sel(lid, f.vendors[0]!, '41', { reason: 'Wastage' })] })).status).toBe(409);
    await setSettings(c, f.token, { 'selection.max_over_approval_pct': 25 });
    expect((await proc(c, f.buyer.token).select({ submit: true, lines: [sel(lid, f.vendors[0]!, '41', { reason: 'Wastage' })] })).body.code).toBe('QTY_EXCEEDS_REMAINING');
    const nr = await proc(c, senior.token).select({ submit: true, lines: [sel(lid, f.vendors[0]!, '41')] });
    expect(nr.status).toBe(400);
    // 25% of 40 = 10 → 45 then 5 more (total excess 10) OK, 1 beyond → 409
    await mustOk(proc(c, senior.token).select({ submit: true, lines: [sel(lid, f.vendors[0]!, '45', { reason: 'Wastage' })] }), 201);
    await mustOk(proc(c, senior.token).select({ submit: true, lines: [sel(lid, f.vendors[1]!, '5', { reason: 'Wastage' })] }), 201);
    expect((await proc(c, senior.token).select({ submit: true, lines: [sel(lid, f.vendors[1]!, '1', { reason: 'Wastage' })] })).status).toBe(409);
    expect(await qtyOf(c, lid)).toMatchObject({ approved: 40, selected: 50 });
    await setSettings(c, f.token, { 'selection.max_over_approval_pct': null });
  });

  it('a short-closed indent remainder can no longer be selected or ordered', async () => {
    const ind = await approvedIndent(c, f, ['20']);
    const lid = ind.lines[0].id;
    await mustOk(proc(c, f.buyer.token).select({ submit: true, lines: [sel(lid, f.vendors[0]!, '8')] }), 201);
    await mustOk(proc(c, f.buyer.token).shortClose(ind.id, { reason: 'Rest not needed' }));
    expect(await qtyOf(c, lid)).toMatchObject({ shortClosed: 12 });
    expect((await proc(c, f.buyer.token).select({ submit: true, lines: [sel(lid, f.vendors[0]!, '1')] })).status).toBeGreaterThanOrEqual(400);
  });
});

// ===================================================================================================== GST edges
describe('GST edge inputs', () => {
  it('vendor without a state code → IGST; header discount allocated before tax; freight untaxed', async () => {
    const v = await mustOk(api(c, f.token).post('/masters/vendor/records', { name: `No-state ${uid(4)}`, data: {} }), 201);
    f.vendors.push(v.id);
    const vi = f.vendors.length - 1;
    const { selection } = await approvedSelection(c, f, ['10'], [[0, vi, '10', '100']]);
    const p = poApi(c, f.po.token);
    const [po] = await mustOk<Doc[]>(p.fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '10' }], values: { discount_amount: '100', freight: '250' } }), 201);
    // 1000 − 100 = 900 taxable; IGST 18% = 162; + freight 250
    expect(po!.values).toMatchObject({ taxable_amount: '900.00', igst_amount: '162.00', cgst_amount: '0.00', grand_total: '1312.00' });
  });

  it('a line discount above 100% or below 0 is refused (no negative taxable value)', async () => {
    const { selection } = await approvedSelection(c, f, ['10'], [[0, 0, '10', '100']]);
    const p = poApi(c, f.po.token);
    const [po] = await mustOk<Doc[]>(p.fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '10' }] }), 201);
    const l = po!.lines[0]!;
    const r = await p.update(po!.id, { version: po!.version, values: { location: po!.values.location, party: po!.values.party }, lines: [{ id: l.id, values: { ...l.values, discount_pct: '150' } }] });
    expect(r.status).toBe(400);
    const neg = await p.update(po!.id, { version: po!.version, values: { location: po!.values.location, party: po!.values.party }, lines: [{ id: l.id, values: { ...l.values, discount_pct: '-20' } }] });
    expect(neg.status).toBe(400);
    const big = await p.update(po!.id, { version: po!.version, values: { location: po!.values.location, party: po!.values.party, discount_amount: '999999' }, lines: [{ id: l.id, values: l.values }] });
    // a header discount above the net value is capped at the net value (taxable never negative)
    if (big.status === 200) expect(big.body.values).toMatchObject({ taxable_amount: '0.00', tax_amount: '0.00' });
  });

  it('the taxes endpoint matches line_tax rows; another tenant\'s PO id is 404', async () => {
    const { selection } = await approvedSelection(c, f, ['3'], [[0, 0, '3', '33.33']], { items: [f.items[2]] } as never);
    const p = poApi(c, f.po.token);
    const [po] = await mustOk<Doc[]>(p.fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '3' }] }), 201);
    const t = await mustOk(p.taxes(po!.id));
    // GST5 intra on 99.99 → 2.50 + 2.50 (half-up per component)
    expect(t.lines[po!.lines[0]!.id].map((x: { component: string; taxAmount: string }) => [x.component, x.taxAmount])).toEqual([['cgst', '2.50'], ['sgst', '2.50']]);
    expect(t.totals).toMatchObject({ taxable: '99.99', tax: '5.00', grand: '104.99' });
  });
});

// ===================================================================================================== amendments
describe('PO amendment diff + re-approval', () => {
  async function issued(qty = '100') {
    const s = await approvedSelection(c, f, [qty], [[0, 0, qty, '10']]);
    const p = poApi(c, f.po.token);
    const [po] = await mustOk<Doc[]>(p.fromLines({ picks: [{ sourceLineId: s.selection.lines[0].id, qty: '80' }] }), 201);
    const sub = await mustOk<Doc>(p.submit(po!.id, po!.version));
    const ok = await approvePo(c, f, sub as never);
    return { ...s, po: ok as Doc };
  }

  it('rate + freight change: header and line diff, back to approval, GST recomputed on approval, ledger untouched', async () => {
    const { selection, po } = await issued();
    const p = poApi(c, f.po.token);
    const am = await mustOk<Doc>(p.amend(po.id, 'Rate renegotiated'));
    const l = am.lines[0]!;
    const ed = await mustOk<Doc>(p.update(po.id, { version: am.version, values: { location: am.values.location, party: am.values.party, freight: '500' }, lines: [{ id: l.id, values: { ...l.values, rate: '9' } }] }));
    const sent = await mustOk<Doc>(p.submit(ed.id, ed.version));
    expect(sent.statusKey).toBe('waiting_approve');
    const revs = await mustOk(p.revisions(po.id));
    const diff = revs.find((r: { revNo: number }) => r.revNo === 1).diff;
    expect(diff.header).toEqual([expect.objectContaining({ field: 'freight' })]);
    expect(diff.lines).toEqual([expect.objectContaining({ lineNo: 1, change: 'changed', fields: [expect.objectContaining({ field: 'rate' })] })]);
    // the indenter-side ledger does not move on a rate-only amendment
    const cur = await mustOk<Doc>(p.get(po.id));
    await mustOk(decidePo(c, f, po.id, [{ lineId: cur.lines[0]!.id, approve: String(Number(cur.lines[0]!.values.qty)) }]));
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 80 });
    const after = await mustOk<Doc>(p.get(po.id));
    expect(after.statusKey).toBe('approved');
    // 80 × 9 = 720 taxable, 18% intra → 64.80 + 64.80, + freight 500
    expect(after.values).toMatchObject({ taxable_amount: '720.00', cgst_amount: '64.80', grand_total: '1349.60' });
  });

  it('QA47-BUG-003: an amendment raising qty beyond what the source has left is refused at resubmit (not first at approval)', async () => {
    const { po } = await issued('100'); // 20 left on the selection line
    const p = poApi(c, f.po.token);
    const am = await mustOk<Doc>(p.amend(po.id, 'Vendor can do more'));
    const l = am.lines[0]!;
    const ed = await mustOk<Doc>(p.update(po.id, { version: am.version, values: { location: am.values.location, party: am.values.party }, lines: [{ id: l.id, values: { ...l.values, qty: '150', schedule: [{ date: '2026-12-01', qty: '150' }] } }] }));
    const r = await p.submit(ed.id, ed.version);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('QTY_EXCEEDS_REMAINING');
  });

  it('QA47-BUG-003 regression: an amendment within the source remainder resubmits and orders on approval', async () => {
    const { po, selection } = await issued('100'); // 80 ordered, 20 left
    const p = poApi(c, f.po.token);
    const am = await mustOk<Doc>(p.amend(po.id, 'Vendor can do 100'));
    const l = am.lines[0]!;
    const ed = await mustOk<Doc>(p.update(po.id, { version: am.version, values: { location: am.values.location, party: am.values.party }, lines: [{ id: l.id, values: { ...l.values, qty: '100', schedule: [{ date: '2026-12-01', qty: '100' }] } }] }));
    const sent = await mustOk<Doc>(p.submit(ed.id, ed.version));
    expect(sent.statusKey).toBe('waiting_approve');
    const cur = await mustOk<Doc>(p.get(po.id));
    await mustOk(decidePo(c, f, po.id, [{ lineId: cur.lines[0]!.id, approve: '100' }]));
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 100 });
  });

  it('observed: an over-source amendment reaches the approver, whose approval then fails with 409 (PO stays waiting)', async () => {
    const { po, selection } = await issued('100');
    const p = poApi(c, f.po.token);
    const am = await mustOk<Doc>(p.amend(po.id, 'Vendor can do more'));
    const l = am.lines[0]!;
    const ed = await mustOk<Doc>(p.update(po.id, { version: am.version, values: { location: am.values.location, party: am.values.party }, lines: [{ id: l.id, values: { ...l.values, qty: '150', schedule: [{ date: '2026-12-01', qty: '150' }] } }] }));
    const sub = await p.submit(ed.id, ed.version);
    if (sub.status === 409) return; // fixed (QA47-BUG-003)
    expect(sub.status).toBe(200);
    const cur = await mustOk<Doc>(p.get(po.id));
    const r = await decidePo(c, f, po.id, [{ lineId: cur.lines[0]!.id, approve: '150' }]);
    expect(r.status).toBe(409);
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 80 });
    // rejecting restores rev 0
    const rej = await mustOk<Doc>(decidePo(c, f, po.id, [{ lineId: cur.lines[0]!.id, reject: '150', reason: 'Too much' }]));
    expect(rej.statusKey).toBe('approved');
    expect(String(rej.lines[0]!.values.qty)).toMatch(/^80/);
  });

  it('needs doc.po:action.amend; a draft PO cannot be amended', async () => {
    const { po } = await issued();
    const noAmend = await scoped(c, f.token, f.code, ['doc.po:action.view', 'doc.po:action.edit', ...PO_VIEWS]);
    expect((await poApi(c, noAmend.token).amend(po.id, 'Try it')).status).toBe(403);
    const { selection } = await approvedSelection(c, f, ['5'], [[0, 0, '5', '10']]);
    const [d] = await mustOk<Doc[]>(poApi(c, f.po.token).fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '5' }] }), 201);
    expect((await poApi(c, f.po.token).amend(d!.id, 'Draft amend')).status).toBe(409);
  });
});

// ===================================================================================================== quotes
describe('quote versions, slabs and landed cost', () => {
  it('revising a superseded version → 409; history keeps every version; comparison uses the current one', async () => {
    const ind = await approvedIndent(c, f, ['1000']);
    const lid = ind.lines[0].id;
    const b = proc(c, f.buyer.token);
    const [v1] = await mustOk(b.logQuote(lid, quote(f.vendors[0]!, { quotedRate: '50' })), 201);
    const v2 = await mustOk(b.revise(v1.id, quote(f.vendors[0]!, { quotedRate: '48' })));
    expect(v2.version).toBe(2);
    const stale = await b.revise(v1.id, quote(f.vendors[0]!, { quotedRate: '47' }));
    expect(stale.status).toBe(409);
    const all = await mustOk(b.quotes(lid, true));
    expect(all.map((q: { version: number; isCurrent: boolean }) => [q.version, q.isCurrent])).toEqual([[2, true], [1, false]]);
    // vendor cannot change on revise
    expect((await b.revise(v2.id, quote(f.vendors[1]!, { quotedRate: '47' }))).status).toBe(400);
  });

  it('slab boundary (999 vs 1000 kg), lump-sum freight per unit and landed cost; best = lowest landed among valid quotes', async () => {
    const ind = await approvedIndent(c, f, ['1000']);
    const lid = ind.lines[0].id;
    const b = proc(c, f.buyer.token);
    await mustOk(b.logQuote(lid, quote(f.vendors[0]!, { quotedRate: '50', taxPct: '18', freight: '1000', slabs: [{ fromQty: '0', toQty: '999', rate: '50' }, { fromQty: '1000', discountPct: '10' }] })), 201);
    await mustOk(b.logQuote(lid, quote(f.vendors[1]!, { quotedRate: '46', taxPct: '18', freight: '0' })), 201);
    const at1000 = await mustOk(b.compareLine(lid, '1000'));
    const a = at1000.vendors.find((v: { vendor: { id: string } }) => v.vendor.id === f.vendors[0]);
    // 50 − 10% = 45; 45 × 1.18 + 1000/1000 = 54.1
    expect(a).toMatchObject({ effectiveRate: '45', freightPerUnit: '1', landedCostPerUnit: '54.1', landedTotal: '54100' });
    const bq = at1000.vendors.find((v: { vendor: { id: string } }) => v.vendor.id === f.vendors[1]);
    expect(bq.landedCostPerUnit).toBe('54.28');
    expect(a.isBest).toBe(true);
    const at999 = await mustOk(b.compareLine(lid, '999'));
    expect(at999.vendors.find((v: { vendor: { id: string } }) => v.vendor.id === f.vendors[0]).effectiveRate).toBe('50');
    expect(at999.vendors.find((v: { isBest: boolean }) => v.isBest).vendor.id).toBe(f.vendors[1]);
    // garbage qty
    expect((await b.compareLine(lid, '1e3')).status).toBe(400);
  });

  it('QA47-BUG-004 (fixed in QA): out-of-range quote numbers are 400, not accepted (tax % > 100) or a 500 numeric overflow', async () => {
    const ind = await approvedIndent(c, f, ['10']);
    const b = proc(c, f.buyer.token);
    for (const over of [{ taxPct: '150' }, { taxPct: '1800' }, { quotedRate: '99999999999999999999999' }, { freight: '99999999999999999999' }, { moq: '1'.repeat(30) }]) {
      const r = await b.logQuote(ind.lines[0].id, quote(f.vendors[0]!, over));
      expect([JSON.stringify(over), r.status]).toEqual([JSON.stringify(over), 400]);
    }
    await mustOk(b.logQuote(ind.lines[0].id, quote(f.vendors[0]!, { taxPct: '100', quotedRate: '99999999999999' })), 201);
  });

  it('quotes only on approved open lines; alsoForLineIds must be the same item', async () => {
    const ind = await approvedIndent(c, f, ['10', '10'], { approve: ['10', '0'] });
    const b = proc(c, f.buyer.token);
    expect((await b.logQuote(ind.lines[1].id, quote(f.vendors[0]!))).status).toBe(409); // fully rejected line
    expect((await b.logQuote(ind.lines[0].id, quote(f.vendors[0]!, { alsoForLineIds: [ind.lines[1].id] }))).status).toBeGreaterThanOrEqual(400);
  });
});

// ===================================================================================================== permissions
describe('permission enforcement for every Phase 4 action key', () => {
  it('a view-only user gets 403 on every Phase 4 action; scoped users see 404 out of scope', async () => {
    const viewer = await scoped(c, f.token, f.code, [
      'doc.indent:action.view', ...ALL_VIEWS.map(v => `doc.indent:view.${v}`), 'doc.indent:view.waiting_verify',
      'doc.vendor_selection:action.view', ...ALL_VIEWS.map(v => `doc.vendor_selection:view.${v}`),
      'doc.po:action.view', ...PO_VIEWS,
    ]);
    const { indent, selection } = await approvedSelection(c, f, ['10'], [[0, 0, '10', '10']]);
    const p0 = poApi(c, f.po.token);
    const [po] = await mustOk<Doc[]>(p0.fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '5' }] }), 201);
    const sub = await mustOk<Doc>(p0.submit(po!.id, po!.version));
    const okPo = await approvePo(c, f, sub as never) as Doc;
    const [q] = await mustOk(proc(c, f.buyer.token).logQuote(indent.lines[0].id, quote(f.vendors[0]!)), 201);
    const v = api(c, viewer.token);
    const lid = indent.lines[0].id;
    const calls: [string, Promise<{ status: number; body: unknown }>][] = [
      ['log_quote', v.post(`/procurement/indent-lines/${lid}/quotes`, quote(f.vendors[0]!))],
      ['log_quote (revise)', v.put(`/procurement/quotes/${q.id}`, quote(f.vendors[0]!))],
      ['compare (line)', v.get(`/procurement/indent-lines/${lid}/comparison`)],
      ['compare (item)', v.get(`/procurement/items/${f.items[0]}/comparison`)],
      ['indent short_close', v.post(`/docs/indent/${indent.id}/short-close`, { reason: 'Not needed' })],
      ['vendor_selection add (selectable)', v.get('/procurement/selectable-lines')],
      ['vendor_selection add (create)', v.post('/procurement/selections', { lines: [sel(lid, f.vendors[0]!, '1')] })],
      ['po add (orderable)', v.get('/procurement/orderable-lines')],
      ['po add (from-lines)', v.post('/procurement/po/from-lines', { picks: [{ sourceLineId: selection.lines[0].id, qty: '1' }] })],
      ['po followup', v.post(`/docs/po/${okPo.id}/followups`, { contactMode: 'call', notes: 'x' })],
      ['po amend', v.post(`/docs/po/${okPo.id}/amend`, { reason: 'Change it' })],
      ['po amend withdraw', v.del(`/docs/po/${okPo.id}/amend`)],
      ['po short_close', v.post(`/docs/po/${okPo.id}/short-close`, { reason: 'Close it' })],
      ['po create (direct)', v.post('/docs/po', { values: { location: f.pune, party: f.vendors[0] }, lines: [{ values: { item: f.items[0], qty: '1', rate: '1' } }] })],
    ];
    const out = await Promise.all(calls.map(async ([n, r]) => [n, (await r).status] as const));
    expect(out.filter(([, s]) => s !== 403)).toEqual([]);
    // reads with view work
    await mustOk(v.get(`/procurement/indent-lines/${lid}/quotes`));
    await mustOk(v.get(`/docs/po/${okPo.id}/taxes`));
    await mustOk(v.get(`/docs/po/${okPo.id}/followups`));
    await mustOk(v.get(`/docs/po/${okPo.id}/revisions`));

    // selection submit needs …submit
    const noSubmit = await scoped(c, f.token, f.code, BUYER_KEYS.filter(k => k !== 'doc.vendor_selection:action.submit'));
    const ind2 = await approvedIndent(c, f, ['3']);
    expect((await proc(c, noSubmit.token).select({ submit: true, lines: [sel(ind2.lines[0].id, f.vendors[0]!, '1')] })).status).toBe(403);
    // po:add without create_direct → direct PO refused even with flow.po.direct_allowed
    await setSettings(c, f.token, { 'flow.po.direct_allowed': true });
    const adder = await scoped(c, f.token, f.code, ['doc.po:action.view', 'doc.po:action.add', 'doc.po:action.edit', ...PO_VIEWS]);
    expect((await api(c, adder.token).post('/docs/po', { values: { location: f.pune, party: f.vendors[0] }, lines: [{ values: { item: f.items[0], qty: '1', rate: '1' } }] })).status).toBe(403);
    await setSettings(c, f.token, { 'flow.po.direct_allowed': false });

    // data scope: a Chennai-only buyer cannot see Pune lines anywhere
    const chennai = await scoped(c, f.token, f.code, [...BUYER_KEYS, 'doc.po:action.add', 'doc.po:action.view', ...PO_VIEWS], f.chennai);
    const ch = api(c, chennai.token);
    expect((await ch.get(`/procurement/indent-lines/${lid}/quotes`)).status).toBe(404);
    expect((await ch.get(`/procurement/indent-lines/${lid}/comparison`)).status).toBe(404);
    expect((await ch.post(`/procurement/indent-lines/${lid}/quotes`, quote(f.vendors[0]!))).status).toBe(404);
    const selPage = await mustOk(ch.get(`/procurement/selectable-lines?q=${encodeURIComponent(indent.number)}`));
    expect(selPage.data).toEqual([]);
    const ordPage = await mustOk(ch.get(`/procurement/orderable-lines?q=${encodeURIComponent(selection.number)}`));
    expect(ordPage.data).toEqual([]);
    expect((await ch.post('/procurement/po/from-lines', { picks: [{ sourceLineId: selection.lines[0].id, qty: '1' }] })).status).toBe(400);
  });
});

// ===================================================================================================== cross-tenant
describe('cross-tenant isolation on every Phase 4 endpoint', () => {
  it("tenant A's admin on B's ids: 404 everywhere, nothing of B leaks or changes", async () => {
    const g = await poTenant(c);
    const { indent, selection } = await approvedSelection(c, g, ['10'], [[0, 0, '10', '10']]);
    const pb = poApi(c, g.po.token);
    const [po] = await mustOk<Doc[]>(pb.fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '10' }] }), 201);
    const sub = await mustOk<Doc>(pb.submit(po!.id, po!.version));
    const bPo = await approvePo(c, g, sub as never) as Doc;
    const [bq] = await mustOk(proc(c, g.buyer.token).logQuote(indent.lines[0].id, quote(g.vendors[0]!)), 201);
    const before = await qtyOf(c, selection.lines[0].id);

    const a = api(c, f.token);
    const lid = indent.lines[0].id;
    const calls: [string, Promise<{ status: number; body: unknown }>][] = [
      ['quotes list', a.get(`/procurement/indent-lines/${lid}/quotes?all=true`)],
      ['quote log', a.post(`/procurement/indent-lines/${lid}/quotes`, quote(f.vendors[0]!))],
      ['quote revise', a.put(`/procurement/quotes/${bq.id}`, quote(g.vendors[0]!))],
      ['compare line', a.get(`/procurement/indent-lines/${lid}/comparison`)],
      ['indent short-close', a.post(`/docs/indent/${indent.id}/short-close`, { reason: 'Steal' })],
      ['po taxes', a.get(`/docs/po/${bPo.id}/taxes`)],
      ['po followups', a.get(`/docs/po/${bPo.id}/followups`)],
      ['po followup add', a.post(`/docs/po/${bPo.id}/followups`, { contactMode: 'call', notes: 'x' })],
      ['po amend', a.post(`/docs/po/${bPo.id}/amend`, { reason: 'Steal it' })],
      ['po revisions', a.get(`/docs/po/${bPo.id}/revisions`)],
      ['po short-close', a.post(`/docs/po/${bPo.id}/short-close`, { reason: 'Steal' })],
      ['po print', a.post(`/docs/po/${bPo.id}/print`, {})],
      ['po messages', a.get(`/docs/po/${bPo.id}/messages`)],
    ];
    const out = await Promise.all(calls.map(async ([n, r]) => { const x = await r; return [n, x.status, JSON.stringify(x.body)] as const; }));
    expect(out.filter(([, s]) => s !== 404).map(([n, s]) => `${n}:${s}`)).toEqual([]);
    for (const [, , body] of out) expect(body).not.toContain(g.vendors[0]);
    // ids of B used as inputs on A's create endpoints
    const selRes = await a.post('/procurement/selections', { lines: [sel(lid, f.vendors[0]!, '1')] });
    expect(selRes.status).toBe(404);
    const fl = await a.post('/procurement/po/from-lines', { picks: [{ sourceLineId: selection.lines[0].id, qty: '1' }] });
    expect(fl.status).toBe(400);
    expect(JSON.stringify(fl.body)).not.toContain(g.vendors[0]);
    const listA = await mustOk(a.get('/procurement/orderable-lines?limit=500'));
    expect(listA.data.map((r: { sourceLineId: string }) => r.sourceLineId)).not.toContain(selection.lines[0].id);
    expect(await qtyOf(c, selection.lines[0].id)).toEqual(before);
    expect((await pb.revisions(bPo.id)).body.length).toBe(1);
  });

  it('QA47-BUG-005: item comparison with another tenant\'s (or any unknown) item id is 404, not an empty 200 sheet', async () => {
    const g = await poTenant(c);
    const r = await api(c, f.token).get(`/procurement/items/${g.items[0]}/comparison`);
    expect(JSON.stringify(r.body)).not.toContain('Steel'); // no data leaks either way
    expect(r.status).toBe(404);
    // regression: a random id and a non-item master record (a vendor) are 404 too; an own item still gets a sheet
    expect((await api(c, f.token).get('/procurement/items/00000000-0000-4000-8000-000000000001/comparison')).status).toBe(404);
    expect((await api(c, f.token).get(`/procurement/items/${f.vendors[0]}/comparison`)).status).toBe(404);
    expect((await api(c, f.token).get(`/procurement/items/${f.items[0]}/comparison`)).status).toBe(200);
  });
});

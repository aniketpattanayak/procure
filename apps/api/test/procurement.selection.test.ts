import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { approvedIndent, buckets, BUYER_KEYS, docs, proc, procTenant, ProcFixture, quote, scoped, submittedIndent } from './procurement-helpers';

let c: Ctx;
let f: ProcFixture;
beforeAll(async () => {
  c = await bootApp();
  f = await procTenant(c);
});
afterAll(async () => closeApp(c));

const line = (indentLineId: string, vendorId: string, qty: string, extra: Record<string, unknown> = {}) => ({ indentLineId, vendorId, qty, rate: '50', ...extra });
const decide = (id: string, decisions: unknown[]) => docs(c, f.token, 'vendor_selection').act(id, { action: 'decide', stageKey: 'approve', decisions });

describe('vendor selection', () => {
  it('lists selectable lines and splits one indent line across two vendors', async () => {
    const ind = await approvedIndent(c, f, ['700', '50']);
    const [l1, l2] = ind.lines;
    const p = proc(c, f.buyer.token);
    const page = await mustOk(p.selectable(`item=${f.items[0]}`));
    const row = page.data.find((r: { indentLineId: string }) => r.indentLineId === l1.id);
    expect(row).toMatchObject({ sourceKind: 'indent', pendingOrder: '700', indentNumber: ind.number, item: { id: f.items[0], name: 'Steel rod' }, location: { id: f.pune } });
    const [qa] = await mustOk(p.logQuote(l1.id, quote(f.vendors[0])), 201);
    const sel = await mustOk(p.select({ submit: true, lines: [line(l1.id, f.vendors[0], '300', { quoteId: qa.id }), line(l1.id, f.vendors[1], '400', { rate: '49' })] }), 201);
    expect(sel.docTypeKey).toBe('vendor_selection');
    expect(sel.number).toMatch(/^VS\//);
    expect(sel.statusKey).toBe('waiting_approve');
    expect(sel.lines.map((l: { values: Record<string, unknown> }) => [l.values.vendor, l.values.qty, l.values.indent_line])).toEqual([[f.vendors[0], '300.000', l1.id], [f.vendors[1], '400.000', l1.id]]);
    expect(await buckets(c, l1.id)).toMatchObject({ approved: 700, selected: 700, overApproved: 0 });
    const links = await c.db.selectFrom('app.line_link').select(['to_line_id', 'qty', 'link_type']).where('from_line_id', '=', l1.id).execute();
    expect(links.map(l => [Number(l.qty), l.link_type]).sort()).toEqual([[300, 'selected'], [400, 'selected']]);
    // fully selected line is no longer selectable; the other one still is
    const after = await mustOk(p.selectable(`q=${encodeURIComponent(ind.number)}`));
    expect(after.data.map((r: { indentLineId: string }) => r.indentLineId)).toEqual([l2.id]);
    // item-wise indent list shows the selected bucket
    const items = await mustOk(docs(c, f.buyer.token, 'indent').list(`view=item&q=${encodeURIComponent(ind.number)}`));
    const il = items.data.find((r: { lineId: string }) => r.lineId === l1.id);
    expect(il.qty).toMatchObject({ approved: '700', selected: '700' });
    const ev = await c.db.selectFrom('app.outbox_event').select('payload').where('tenant_id', '=', f.tenantId).where('event_type', '=', 'selection.submitted').where('aggregate_id', '=', sel.id).execute();
    expect(ev).toHaveLength(1);
  });

  it('rejects selecting more than is left (no over-approval rights / cap 0)', async () => {
    const ind = await approvedIndent(c, f, ['100']);
    const p = proc(c, f.buyer.token);
    const res = await p.select({ submit: true, lines: [line(ind.lines[0].id, f.vendors[0], '101')] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QTY_EXCEEDS_REMAINING');
    expect(await buckets(c, ind.lines[0].id)).toMatchObject({ selected: 0 });
    // a draft is fine; submitting it is checked
    const draft = await mustOk(p.select({ lines: [line(ind.lines[0].id, f.vendors[0], '60')] }), 201);
    expect(draft.statusKey).toBe('draft');
    expect(await buckets(c, ind.lines[0].id)).toMatchObject({ selected: 0 });
    await mustOk(docs(c, f.buyer.token, 'vendor_selection').submit(draft.id, draft.version));
    expect(await buckets(c, ind.lines[0].id)).toMatchObject({ selected: 60 });
  });

  it('over-approval needs the key, a reason and stays within selection.max_over_approval_pct', async () => {
    await mustOk(proc(c, f.token).setSettings({ 'selection.max_over_approval_pct': 10 }));
    const ind = await approvedIndent(c, f, ['100']);
    const lid = ind.lines[0].id;
    const buyer = proc(c, f.buyer.token);
    // buyer lacks over_approve
    expect((await buyer.select({ submit: true, lines: [line(lid, f.vendors[0], '105', { reason: 'Wastage' })] })).body.code).toBe('QTY_EXCEEDS_REMAINING');
    const senior = await scoped(c, f.token, f.code, [...BUYER_KEYS, 'doc.vendor_selection:action.over_approve']);
    const p = proc(c, senior.token);
    // no reason
    const noReason = await p.select({ submit: true, lines: [line(lid, f.vendors[0], '105')] });
    expect(noReason.status).toBe(400);
    expect(noReason.body.errors[0].path).toBe('lines.0.reason');
    // above the cap (10% of 100 = 10)
    const tooMuch = await p.select({ submit: true, lines: [line(lid, f.vendors[0], '111', { reason: 'Wastage' })] });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.code).toBe('QTY_EXCEEDS_REMAINING');
    // within the cap
    const ok = await mustOk(p.select({ submit: true, lines: [line(lid, f.vendors[0], '60'), line(lid, f.vendors[1], '50', { reason: 'Cutting wastage' })] }), 201);
    expect(ok.lines[1].values.over_qty).toBe('10.000');
    expect(await buckets(c, lid)).toMatchObject({ approved: 100, selected: 110, overApproved: 10 });
    // nothing left, and the cap is used up
    expect((await p.select({ submit: true, lines: [line(lid, f.vendors[0], '1', { reason: 'More' })] })).status).toBe(409);
    // the indent line is still "approved" (over-approval is not pending approval)
    const det = await mustOk(docs(c, f.buyer.token, 'indent').get(ind.id));
    expect(det.lines[0].qty.pendingApproval).toBe('0');
    await mustOk(proc(c, f.token).setSettings({ 'selection.max_over_approval_pct': null }));
  });

  it('concurrency: two selections consuming the same approved qty → exactly one 409', async () => {
    const ind = await approvedIndent(c, f, ['50']);
    const lid = ind.lines[0].id;
    const other = await scoped(c, f.token, f.code, BUYER_KEYS);
    const [r1, r2] = await Promise.all([
      proc(c, f.buyer.token).select({ submit: true, lines: [line(lid, f.vendors[0], '50')] }),
      proc(c, other.token).select({ submit: true, lines: [line(lid, f.vendors[1], '50')] }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect([r1, r2].find(r => r.status === 409)!.body.code).toBe('QTY_EXCEEDS_REMAINING');
    expect(await buckets(c, lid)).toMatchObject({ selected: 50 });
  });

  it('rejection or reduction in the selection workflow restores selectable qty on the indent line', async () => {
    const ind = await approvedIndent(c, f, ['200']);
    const lid = ind.lines[0].id;
    const sel = await mustOk(proc(c, f.buyer.token).select({ submit: true, lines: [line(lid, f.vendors[0], '120'), line(lid, f.vendors[1], '80')] }), 201);
    expect(await buckets(c, lid)).toMatchObject({ selected: 200 });
    const out = await mustOk(decide(sel.id, [
      { lineId: sel.lines[0].id, approve: '100', reject: '20', reason: 'Reduce A' },
      { lineId: sel.lines[1].id, approve: '0', reject: '80', reason: 'Vendor B is blacklisted' },
    ]));
    expect(out.statusKey).toBe('partially_approved');
    expect(await buckets(c, lid)).toMatchObject({ selected: 100 });
    const ev = await c.db.selectFrom('app.line_event').select(['event_type', 'qty', 'ref_line_id']).where('line_id', '=', lid).where('event_type', '=', 'selection_cancelled').orderBy('id').execute();
    expect(ev.map(e => [Number(e.qty), e.ref_line_id])).toEqual([[20, sel.lines[0].id], [80, sel.lines[1].id]]);
    const link = await c.db.selectFrom('app.line_link').select('is_cancelled').where('to_line_id', '=', sel.lines[1].id).executeTakeFirstOrThrow();
    expect(link.is_cancelled).toBe(true);
    const page = await mustOk(proc(c, f.buyer.token).selectable(`q=${encodeURIComponent(ind.number)}`));
    expect(page.data[0].pendingOrder).toBe('100');
  });

  it('send back to draft gives the qty back; resubmitting consumes it again (no double count)', async () => {
    const ind = await approvedIndent(c, f, ['40']);
    const lid = ind.lines[0].id;
    const sel = await mustOk(proc(c, f.buyer.token).select({ submit: true, lines: [line(lid, f.vendors[0], '40')] }), 201);
    await mustOk(docs(c, f.token, 'vendor_selection').act(sel.id, { action: 'send_back', stageKey: 'approve', toStage: '_draft', reason: 'Use vendor B' }));
    expect(await buckets(c, lid)).toMatchObject({ selected: 0 });
    const draft = await mustOk(docs(c, f.buyer.token, 'vendor_selection').get(sel.id));
    await mustOk(docs(c, f.buyer.token, 'vendor_selection').submit(sel.id, draft.version));
    expect(await buckets(c, lid)).toMatchObject({ selected: 40 });
    // cancelling the whole selection while pending gives it back
    await mustOk(api(c, f.buyer.token).post(`/docs/vendor_selection/${sel.id}/cancel`, { reason: 'Changed plan' }));
    expect(await buckets(c, lid)).toMatchObject({ selected: 0 });
  });

  it('validates lines: unapproved indent line, inactive vendor, foreign quote, out of scope, missing indent link on generic submit', async () => {
    const ind = await approvedIndent(c, f, ['10']);
    const sub = await submittedIndent(c, f, ['5']);
    const p = proc(c, f.buyer.token);
    expect((await p.select({ lines: [line(sub.lines[0].id, f.vendors[0], '1')] })).status).toBe(400);
    const [q] = await mustOk(p.logQuote(ind.lines[0].id, quote(f.vendors[0])), 201);
    const bad = await p.select({ lines: [line(ind.lines[0].id, f.vendors[1], '1', { quoteId: q.id })] });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].path).toBe('lines.0.quoteId');
    const chennai = await scoped(c, f.token, f.code, BUYER_KEYS, f.chennai);
    expect((await proc(c, chennai.token).select({ lines: [line(ind.lines[0].id, f.vendors[0], '1')] })).status).toBe(404);
    // generic document API without an indent link: draft ok, submit refused
    const d = docs(c, f.buyer.token, 'vendor_selection');
    const raw = await mustOk(d.create({ values: { location: f.pune }, lines: [{ values: { item: f.items[0], qty: '1', rate: '1', vendor: f.vendors[0] } }] }), 201);
    const r = await d.submit(raw.id, raw.version);
    expect(r.status).toBe(400);
    expect(r.body.errors[0].path).toBe('lines.0.indent_line');
    // inactive vendor at submit
    const v = await mustOk(api(c, f.token).post('/masters/vendor/records', { name: 'Gone vendor', data: {} }), 201);
    const dr = await mustOk(p.select({ lines: [line(ind.lines[0].id, v.id, '1')] }), 201);
    await mustOk(api(c, f.token).post(`/masters/vendor/records/${v.id}/deactivate`, {}), 200, 201);
    const rs = await d.submit(dr.id, dr.version);
    expect(rs.status).toBe(400);
    expect(rs.body.errors[0].path).toBe('lines.0.vendor');
  });

  it('permissions and flow toggles: no add → 403; selection flow off hides the keys', async () => {
    const ind = await approvedIndent(c, f, ['10']);
    expect((await proc(c, f.indenter.token).select({ lines: [line(ind.lines[0].id, f.vendors[0], '1')] })).status).toBe(403);
    expect((await proc(c, f.indenter.token).selectable()).status).toBe(403);
    const noSubmit = await scoped(c, f.token, f.code, BUYER_KEYS.filter(k => k !== 'doc.vendor_selection:action.submit'));
    expect((await proc(c, noSubmit.token).select({ submit: true, lines: [line(ind.lines[0].id, f.vendors[0], '1')] })).status).toBe(403);
    await mustOk(proc(c, f.token).setSettings({ 'flow.vendor_selection.enabled': false }));
    try {
      expect((await proc(c, f.buyer.token).select({ lines: [line(ind.lines[0].id, f.vendors[0], '1')] })).status).toBe(403);
      // short-close then uses the unordered remainder (selection off)
      const r = await mustOk(proc(c, f.buyer.token).shortClose(ind.id, { reason: 'Selection off' }));
      expect(r.lines[0].qty.shortClosed).toBe('10');
    } finally {
      await mustOk(proc(c, f.token).setSettings({ 'flow.vendor_selection.enabled': true }));
    }
  });
});

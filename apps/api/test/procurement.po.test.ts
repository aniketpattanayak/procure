import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { approvedIndent, docs, proc, scoped } from './procurement-helpers';
import { approvedSelection, approvePo, decidePo, poApi, poTenant, PoFixture, PO_BUYER_KEYS, qtyOf, setSettings } from './procurement-po-helpers';

let c: Ctx;
let f: PoFixture;
beforeAll(async () => {
  c = await bootApp();
  f = await poTenant(c);
});
afterAll(async () => closeApp(c));

const pick = (sourceLineId: string, qty: string, extra: Record<string, unknown> = {}) => ({ sourceLineId, qty, ...extra });

describe('PO provisioning', () => {
  it('installs the po type, numbering, default workflow, tax codes, item tax_code and the extra keys', async () => {
    const a = api(c, f.token);
    const types = await mustOk(a.get('/doc-types'));
    const po = types.find((t: { key: string }) => t.key === 'po');
    expect(po).toMatchObject({ kind: 'system', name: 'Purchase Order', settings: { editableStatuses: ['draft', 'amending'] } });
    expect(po.statuses.map((s: { key: string }) => s.key)).toContain('waiting_approve');
    const series = await mustOk(a.get('/config/numbering?docType=po'));
    expect(series[0].pattern).toBe('PO/{FYS}/{SEQ:5}');
    const wf = await mustOk(a.get('/config/workflows/po'));
    expect(wf.published).toMatchObject({ granularity: 'line', stages: [{ key: 'approve', name: 'PO approval' }] });
    const codes = await mustOk(a.get('/masters/tax_code/records?limit=50'));
    expect(codes.data.map((r: { code: string }) => r.code).sort()).toEqual(['GST0', 'GST12', 'GST18', 'GST28', 'GST5']);
    const item = await mustOk(a.get('/config/forms/item'));
    expect(JSON.stringify(item)).toContain('"tax_code"');
    const defs = await c.db.selectFrom('app.permission_def').select(['key', 'requires_setting', 'requires_feature']).where('tenant_id', '=', f.tenantId)
      .where('key', 'like', 'doc.po:%').execute();
    const byKey = new Map(defs.map(d => [d.key, d]));
    for (const k of ['followup', 'amend', 'short_close', 'create_direct']) expect(byKey.has(`doc.po:action.${k}`)).toBe(true);
    expect(byKey.get('doc.po:action.create_direct')!.requires_setting).toBe('flow.po.direct_allowed');
    expect(byKey.has('doc.po:view.amending')).toBe(true);
    // idempotent: running the installer again changes nothing
    const { ProcurementInstaller } = await import('../src/modules/procurement');
    const { DbService } = await import('../src/core/db.service');
    await c.app.get(DbService).tenantTx(f.tenantId, tx => c.app.get(ProcurementInstaller).ensure(tx, f.tenantId));
    expect((await mustOk(a.get('/masters/tax_code/records?limit=50'))).data).toHaveLength(5);
  });
});

describe('PO from lines', () => {
  it('lists approved selection lines and creates one draft PO per vendor', async () => {
    const { indent, selection } = await approvedSelection(c, f, ['700', '50'], [[0, 0, '300', '50'], [0, 1, '400', '49'], [1, 0, '50', '120']]);
    const p = poApi(c, f.po.token);
    const page = await mustOk(p.orderable(`q=${encodeURIComponent(selection.number)}`));
    expect(page.data).toHaveLength(3);
    const first = page.data.find((r: { sourceLineId: string }) => r.sourceLineId === selection.lines[0].id);
    expect(first).toMatchObject({ lineNo: 1, sourceKind: 'selection', indentLineId: indent.lines[0].id, indentNumber: indent.number, vendor: { id: f.vendors[0] }, rate: '50', pendingOrder: '300', location: { id: f.pune } });
    const vendorFilter = await mustOk(p.orderable(`vendor=${f.vendors[1]}&q=${encodeURIComponent(selection.number)}`));
    expect(vendorFilter.data.map((r: { sourceLineId: string }) => r.sourceLineId)).toEqual([selection.lines[1].id]);

    const pos = await mustOk(p.fromLines({ picks: selection.lines.map((l: { id: string; values: { qty: string } }) => pick(l.id, String(Number(l.values.qty)))), values: { doc_date: '2026-10-20' } }), 201);
    expect(pos).toHaveLength(2);
    const a = pos.find((x: { values: { party: string } }) => x.values.party === f.vendors[0]);
    const b = pos.find((x: { values: { party: string } }) => x.values.party === f.vendors[1]);
    expect(a.statusKey).toBe('draft');
    expect(a.lines).toHaveLength(2);
    expect(a.lines[0].values).toMatchObject({ source_line: selection.lines[0].id, rate: '50.00', item: f.items[0], tax_code: f.taxCodes.GST18 });
    expect(b.lines[0].values).toMatchObject({ source_line: selection.lines[1].id, rate: '49.00' });
    expect(a.values.currency).toBe('INR');
    // drafts reserve nothing
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 0 });
    const ev = await c.db.selectFrom('app.outbox_event').select('payload').where('event_type', '=', 'po.created_from_lines').execute();
    expect(ev.some(e => JSON.stringify(e.payload).includes(a.id))).toBe(true);

    // submit: ordered on the selection line and its indent line, line links, number
    const sub = await mustOk(p.submit(a.id, a.version));
    expect(sub.number).toMatch(/^PO\/\d{2}-?\d{2}\/\d{5}$|^PO\/.+\/\d{5}$/);
    expect(sub.statusKey).toBe('waiting_approve');
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 300 });
    expect(await qtyOf(c, indent.lines[0].id)).toMatchObject({ ordered: 300, selected: 700 });
    const links = await c.db.selectFrom('app.line_link').select(['from_line_id', 'link_type', 'qty']).where('to_line_id', '=', sub.lines[0].id).execute();
    expect(links.map(l => [l.from_line_id, l.link_type, Number(l.qty)]).sort()).toEqual([[indent.lines[0].id, 'ordered', 300], [selection.lines[0].id, 'ordered', 300]].sort());
    // no longer orderable
    const after = await mustOk(p.orderable(`q=${encodeURIComponent(selection.number)}`));
    expect(after.data.map((r: { sourceLineId: string }) => r.sourceLineId)).toEqual([selection.lines[1].id]);
    // approval → PO lines carry `ordered` (pending receipt) and rev 0 + T&C snapshot exist
    const ok = await approvePo(c, f, sub);
    expect(ok.statusKey).toBe('approved');
    expect(ok.lines[0].qty).toMatchObject({ approved: '300', ordered: '300', pendingReceipt: '300' });
    const revs = await mustOk(p.revisions(sub.id));
    expect(revs).toMatchObject([{ revNo: 0, status: 'approved' }]);
  });

  it('validates picks: unknown lines, too much qty, duplicate picks', async () => {
    const { selection } = await approvedSelection(c, f, ['10'], [[0, 0, '10', '5']]);
    const p = poApi(c, f.po.token);
    const too = await p.fromLines({ picks: [pick(selection.lines[0].id, '11')] });
    expect(too.status).toBe(400);
    expect(too.body.errors[0].path).toBe('picks.0.qty');
    const dup = await p.fromLines({ picks: [pick(selection.lines[0].id, '1'), pick(selection.lines[0].id, '2')] });
    expect(dup.status).toBe(400);
    const unknown = await p.fromLines({ picks: [pick(f.items[0], '1')] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors[0].path).toBe('picks.0.sourceLineId');
  });

  it('two POs ordering the same remaining quantity concurrently: exactly one wins', async () => {
    const { selection } = await approvedSelection(c, f, ['100'], [[0, 2, '100', '10']]);
    const p = poApi(c, f.po.token);
    const [x] = await mustOk(p.fromLines({ picks: [pick(selection.lines[0].id, '100')] }), 201);
    const [y] = await mustOk(p.fromLines({ picks: [pick(selection.lines[0].id, '60')] }), 201);
    const res = await Promise.all([p.submit(x.id, x.version), p.submit(y.id, y.version)]);
    const codes = res.map(r => r.status).sort();
    expect(codes).toEqual([200, 409]);
    expect(res.find(r => r.status === 409)!.body.code).toBe('QTY_EXCEEDS_REMAINING');
    const q = await qtyOf(c, selection.lines[0].id);
    expect([100, 60]).toContain(q.ordered);
    // the loser stays a draft
    const loser = res[0]!.status === 409 ? x : y;
    expect((await mustOk(p.get(loser.id))).statusKey).toBe('draft');
  });

  it('partial approval: approve one line, reduce one, reject one → order_cancelled back on the sources', async () => {
    const { indent, selection } = await approvedSelection(c, f, ['30', '40', '50'], [[0, 1, '30', '10'], [1, 1, '40', '20'], [2, 1, '50', '30']]);
    const p = poApi(c, f.po.token);
    const [po] = await mustOk(p.fromLines({ picks: selection.lines.map((l: { id: string; values: { qty: string } }) => pick(l.id, String(Number(l.values.qty)))) }), 201);
    const sub = await mustOk(p.submit(po.id, po.version));
    for (const l of selection.lines) expect((await qtyOf(c, l.id)).ordered).toBe(Number(l.values.qty));
    const [l1, l2, l3] = sub.lines;
    const res = await mustOk(decidePo(c, f, sub.id, [
      { lineId: l1.id, approve: '30' },
      { lineId: l2.id, approve: '25', reject: '15', reason: 'Only 25 needed this month' },
      { lineId: l3.id, reject: '50', reason: 'Wrong grade' },
    ]));
    expect(res.statusKey).toBe('partially_approved');
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 30 });
    expect(await qtyOf(c, selection.lines[1].id)).toMatchObject({ ordered: 25 });
    expect(await qtyOf(c, selection.lines[2].id)).toMatchObject({ ordered: 0 });
    expect(await qtyOf(c, indent.lines[1].id)).toMatchObject({ ordered: 25 });
    expect(await qtyOf(c, indent.lines[2].id)).toMatchObject({ ordered: 0 });
    expect(await qtyOf(c, l2.id)).toMatchObject({ approved: 25, rejected: 15, ordered: 25 });
    const ev = await c.db.selectFrom('app.line_event').select(['event_type', 'qty']).where('line_id', '=', selection.lines[1].id).orderBy('id').execute();
    expect(ev.map(e => [e.event_type, Number(e.qty)])).toEqual(expect.arrayContaining([['ordered', 40], ['order_cancelled', 15]]));
    // rejected qty is orderable again
    const again = await mustOk(p.orderable(`q=${encodeURIComponent(selection.number)}`));
    expect(again.data.map((r: { sourceLineId: string; pendingOrder: string }) => [r.sourceLineId, r.pendingOrder]).sort()).toEqual([[selection.lines[1].id, '15'], [selection.lines[2].id, '50']].sort());
  });

  it('cancelling a pending PO line gives the quantity back', async () => {
    const { selection } = await approvedSelection(c, f, ['12'], [[0, 0, '12', '10']]);
    const p = poApi(c, f.po.token);
    const [po] = await mustOk(p.fromLines({ picks: [pick(selection.lines[0].id, '12')] }), 201);
    const sub = await mustOk(p.submit(po.id, po.version));
    await mustOk(p.cancel(sub.id, { reason: 'Vendor cannot supply' }));
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 0 });
  });
});

describe('direct PO and ordering from indents', () => {
  const directBody = () => ({ values: { location: f.pune, party: f.vendors[0], doc_date: '2026-10-21' }, lines: [{ values: { item: f.items[0], qty: '5', rate: '100' } }] });

  it('a PO without source lines needs flow.po.direct_allowed and the create_direct key', async () => {
    const off = await poApi(c, f.token).create(directBody());
    expect(off.status).toBe(403);
    await setSettings(c, f.token, { 'flow.po.direct_allowed': true });
    try {
      const ok = await mustOk(poApi(c, f.token).create(directBody()), 201);
      expect(ok.lines[0].values.source_line).toBeUndefined();
      const sub = await mustOk(poApi(c, f.token).submit(ok.id, ok.version));
      expect(sub.number).toMatch(/^PO\//);
      // the buyer has po add but not create_direct
      const buyer = await poApi(c, f.po.token).create(directBody());
      expect(buyer.status).toBe(403);
      const direct = await scoped(c, f.token, f.code, [...PO_BUYER_KEYS, 'doc.po:action.create_direct']);
      await mustOk(poApi(c, direct.token).create(directBody()), 201);
    } finally {
      await setSettings(c, f.token, { 'flow.po.direct_allowed': false });
    }
  });

  it('a source line of another item, or of a vendor that was not selected, is refused', async () => {
    const { selection } = await approvedSelection(c, f, ['5'], [[0, 0, '5', '10']]);
    const bad = await poApi(c, f.po.token).create({
      values: { location: f.pune, party: f.vendors[1] }, lines: [{ values: { item: f.items[1], qty: '5', rate: '10', source_line: selection.lines[0].id } }],
    });
    expect(bad.status).toBe(400);
    const paths = bad.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['lines.0.item', 'party']));
  });

  it('with vendor selection off, approved indent lines are ordered directly', async () => {
    await setSettings(c, f.token, { 'flow.vendor_selection.enabled': false });
    try {
      const ind = await approvedIndent(c, f, ['80', '20']);
      const p = poApi(c, f.po.token);
      const page = await mustOk(p.orderable(`q=${encodeURIComponent(ind.number)}`));
      expect(page.data.map((r: { sourceKind: string; pendingOrder: string }) => [r.sourceKind, r.pendingOrder])).toEqual(expect.arrayContaining([['indent', '80'], ['indent', '20']]));
      const noVendor = await p.fromLines({ picks: [pick(ind.lines[0].id, '80')] });
      expect(noVendor.status).toBe(400);
      expect(noVendor.body.errors[0].path).toBe('picks.0.vendorId');
      const pos = await mustOk(p.fromLines({ picks: [pick(ind.lines[0].id, '80', { vendorId: f.vendors[2], rate: '12.5' }), pick(ind.lines[1].id, '20', { vendorId: f.vendors[2], rate: '7' })] }), 201);
      expect(pos).toHaveLength(1);
      const sub = await mustOk(p.submit(pos[0].id, pos[0].version));
      expect(await qtyOf(c, ind.lines[0].id)).toMatchObject({ approved: 80, ordered: 80 });
      const over = await p.fromLines({ picks: [pick(ind.lines[1].id, '1', { vendorId: f.vendors[0], rate: '7' })] });
      expect(over.status).toBe(400);
      await approvePo(c, f, sub);
      // item-wise indent buckets end to end
      const items = await mustOk(docs(c, f.po.token, 'indent').list(`view=item&q=${encodeURIComponent(ind.number)}`));
      const row = items.data.find((r: { lineId: string }) => r.lineId === ind.lines[0].id);
      expect(row.qty).toMatchObject({ requested: '80', approved: '80', ordered: '80', pendingOrder: '0' });
    } finally {
      await setSettings(c, f.token, { 'flow.vendor_selection.enabled': true });
    }
  });
});

describe('schedule, short-close, buckets', () => {
  it('schedule rows must add up to the line qty; expected_date = earliest open date', async () => {
    const { selection } = await approvedSelection(c, f, ['100'], [[0, 0, '100', '10']]);
    const p = poApi(c, f.po.token);
    const [po] = await mustOk(p.fromLines({ picks: [pick(selection.lines[0].id, '100')] }), 201);
    const line = po.lines[0];
    const bad = await p.update(po.id, { version: po.version, values: {}, lines: [{ id: line.id, values: { ...line.values, schedule: [{ date: '2026-11-10', qty: '60' }, { date: '2026-11-01', qty: '30' }] } }] });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].path).toBe('lines.0.schedule');
    const badDate = await p.update(po.id, { version: po.version, values: {}, lines: [{ id: line.id, values: { ...line.values, schedule: [{ date: 'soon', qty: '100' }] } }] });
    expect(badDate.status).toBe(400);
    const ok = await mustOk(p.update(po.id, { version: po.version, values: {}, lines: [{ id: line.id, values: { ...line.values, schedule: [{ date: '2026-11-10', qty: '60' }, { date: '2026-11-01', qty: '40' }] } }] }));
    expect(ok.lines[0].values.schedule).toEqual([{ date: '2026-11-01', qty: '40' }, { date: '2026-11-10', qty: '60' }]);
    expect(ok.lines[0].values.expected_date).toBe('2026-11-01');
    expect(ok.values.expected_date).toBe('2026-11-01');
    // the schedule survives an edit that does not send it
    const again = await mustOk(p.update(po.id, { version: ok.version, values: { freight: '100' }, lines: [{ id: line.id, values: { qty: '100', item: line.values.item, rate: '10', source_line: line.values.source_line } }] }));
    expect(again.lines[0].values.schedule).toHaveLength(2);
  });

  it('short-close a PO line: unreceived qty goes back to the sources; the whole PO closes', async () => {
    const { indent, selection } = await approvedSelection(c, f, ['10', '20'], [[0, 0, '10', '10'], [1, 0, '20', '10']]);
    const p = poApi(c, f.po.token);
    const [po] = await mustOk(p.fromLines({ picks: selection.lines.map((l: { id: string; values: { qty: string } }) => pick(l.id, String(Number(l.values.qty)))) }), 201);
    const sub = await mustOk(p.submit(po.id, po.version));
    const pending = await p.shortClose(sub.id, { reason: 'Vendor stopped this grade' });
    expect(pending.status).toBe(409);
    await approvePo(c, f, sub);
    const one = await mustOk(p.shortClose(sub.id, { reason: 'Vendor stopped this grade', lineIds: [sub.lines[0].id] }));
    expect(one.lines[0].statusKey).toBe('closed');
    expect(await qtyOf(c, sub.lines[0].id)).toMatchObject({ ordered: 0, shortClosed: 10 });
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 0 });
    expect(await qtyOf(c, indent.lines[0].id)).toMatchObject({ ordered: 0 });
    const all = await mustOk(p.shortClose(sub.id, { reason: 'Closing the order' }));
    expect(all.statusKey).toBe('closed');
    expect(await qtyOf(c, selection.lines[1].id)).toMatchObject({ ordered: 0 });
    const again = await p.shortClose(sub.id, { reason: 'Closing the order' });
    expect(again.status).toBe(409);
  });

  it('item-wise indent buckets: requested / approved / selected / ordered / pending', async () => {
    const ind = await approvedIndent(c, f, ['100'], { approve: ['90'] });
    const ok = mustOk;
    const sel = await ok(proc(c, f.buyer.token).select({ submit: true, lines: [{ indentLineId: ind.lines[0].id, vendorId: f.vendors[0], qty: '90', rate: '5' }] }), 201);
    await ok(docs(c, f.token, 'vendor_selection').act(sel.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: sel.lines[0].id, approve: '90' }] }));
    const [po] = await ok(poApi(c, f.po.token).fromLines({ picks: [pick(sel.lines[0].id, '60')] }), 201);
    const sub = await ok(poApi(c, f.po.token).submit(po.id, po.version));
    await approvePo(c, f, sub);
    const items = await ok(docs(c, f.po.token, 'indent').list(`view=item&q=${encodeURIComponent(ind.number)}`));
    expect(items.data[0].qty).toMatchObject({ requested: '100', approved: '90', rejected: '10', selected: '90', ordered: '60', pendingApproval: '0' });
    const selRow = await ok(poApi(c, f.po.token).orderable(`q=${encodeURIComponent(sel.number)}`));
    expect(selRow.data[0].pendingOrder).toBe('30');
  });
});

describe('permissions and scope', () => {
  it('needs doc.po keys; data scope limits orderable lines', async () => {
    const { selection } = await approvedSelection(c, f, ['5'], [[0, 0, '5', '10']]);
    const noPo = await scoped(c, f.token, f.code, ['doc.indent:action.view']);
    expect((await poApi(c, noPo.token).orderable()).status).toBe(403);
    expect((await poApi(c, noPo.token).fromLines({ picks: [pick(selection.lines[0].id, '1')] })).status).toBe(403);
    const chennai = await scoped(c, f.token, f.code, PO_BUYER_KEYS, f.chennai);
    const page = await mustOk(poApi(c, chennai.token).orderable(`q=${encodeURIComponent(selection.number)}`));
    expect(page.data).toHaveLength(0);
    const out = await poApi(c, chennai.token).fromLines({ picks: [pick(selection.lines[0].id, '1')] });
    expect(out.status).toBe(400);
    const [po] = await mustOk(poApi(c, f.po.token).fromLines({ picks: [pick(selection.lines[0].id, '5')] }), 201);
    expect((await poApi(c, chennai.token).taxes(po.id)).status).toBe(404);
    expect((await poApi(c, noPo.token).taxes(po.id)).status).toBe(403);
  });
});

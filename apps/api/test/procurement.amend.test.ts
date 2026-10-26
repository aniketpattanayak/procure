import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { scoped } from './procurement-helpers';
import { approvedSelection, approvePo, decidePo, poApi, poTenant, PoFixture, PO_BUYER_KEYS, qtyOf } from './procurement-po-helpers';

let c: Ctx;
let f: PoFixture;
beforeAll(async () => {
  c = await bootApp();
  f = await poTenant(c);
});
afterAll(async () => closeApp(c));

/** Selection with room to grow: indent 100/50 approved, selected 100/50, PO ordered 60/50. */
async function issuedPo() {
  const sel = await approvedSelection(c, f, ['100', '50'], [[0, 0, '100', '10'], [1, 0, '50', '20']]);
  const p = poApi(c, f.po.token);
  const terms = await mustOk(poApi(c, f.token).raw.post('/masters/terms/records', { code: `T${Math.random().toString(36).slice(2, 8)}`, name: 'Delivery terms', data: { body: 'Deliver to Pune stores, 9 am – 5 pm.', applies_to: ['po'] } }), 201);
  const [po] = await mustOk(p.fromLines({ picks: [{ sourceLineId: sel.selection.lines[0].id, qty: '60' }, { sourceLineId: sel.selection.lines[1].id, qty: '50' }], values: { terms: [terms.id] } }), 201);
  const sub = await mustOk(p.submit(po.id, po.version));
  const ok = await approvePo(c, f, sub);
  expect(ok.statusKey).toBe('approved');
  return { ...sel, po: ok, termsId: terms.id as string };
}

const linesOf = (po: { lines: { id: string; values: Record<string, unknown> }[] }) => po.lines.map(l => ({ id: l.id, values: l.values }));

describe('PO amendments', () => {
  it('T&C snapshot at approval; amend opens the PO for editing; issued lines and vendor are fixed', async () => {
    const { selection, indent, po, termsId } = await issuedPo();
    const p = poApi(c, f.po.token);
    const termsRow = await c.db.selectFrom('app.document').select('custom').where('id', '=', po.id).executeTakeFirstOrThrow();
    expect((termsRow.custom as Record<string, unknown>).terms_snapshot).toEqual([expect.objectContaining({ name: 'Delivery terms', body: 'Deliver to Pune stores, 9 am – 5 pm.' })]);
    // T&C master edits do not change the issued PO
    await c.db.updateTable('app.master_record').set({ data: JSON.stringify({ body: 'CHANGED' }) }).where('id', '=', termsId).execute();

    const draft = await p.amend(po.id, 'x');
    expect(draft.status).toBe(400);
    const am = await mustOk(p.amend(po.id, 'Vendor agreed to supply more at a better rate'));
    expect(am.statusKey).toBe('amending');
    expect(am.isLocked).toBe(false);
    expect(am.values.terms_snapshot).toEqual([expect.objectContaining({ code: expect.any(String), name: 'Delivery terms' })]);
    expect(am.allowedActions).toEqual(expect.arrayContaining(['edit', 'submit']));
    expect((await p.amend(po.id)).status).toBe(409);
    // the issued lines cannot be dropped, nor the vendor changed
    const drop = await p.update(po.id, { version: am.version, values: {}, lines: [linesOf(am)[0]] });
    expect(drop.status).toBe(409);
    const vendor = await p.update(po.id, { version: am.version, values: { party: f.vendors[1] }, lines: linesOf(am) });
    expect(vendor.status).toBe(400);
    // the T&C snapshot taken at approval is unchanged by the master edit
    const still = await c.db.selectFrom('app.document').select('custom').where('id', '=', po.id).executeTakeFirstOrThrow();
    expect(JSON.stringify((still.custom as Record<string, unknown>).terms_snapshot)).toContain('Deliver to Pune stores');
    await mustOk(p.withdraw(po.id));
    void selection; void indent;
  });

  it('Rev 1: qty up + rate change → diff → re-approval → ledger deltas; Rev 2 reduces qty (unsourced new lines refused)', async () => {
    const { selection, indent, po } = await issuedPo();
    const p = poApi(c, f.po.token);
    const am = await mustOk(p.amend(po.id, 'Vendor agreed to supply more at a better rate'));
    const [l1, l2] = linesOf(am);
    const direct = await p.update(po.id, { version: am.version, values: {}, lines: [l1, l2, { values: { item: f.items[2], qty: '5', rate: '7' } }] });
    expect(direct.status).toBe(403);
    const ed = await mustOk(p.update(po.id, {
      version: am.version, values: {},
      lines: [{ id: l1!.id, values: { ...l1!.values, qty: '80', schedule: [{ date: '2026-12-01', qty: '80' }] } }, { id: l2!.id, values: { ...l2!.values, rate: '18' } }],
    }));
    const sent = await mustOk(p.submit(ed.id, ed.version));
    expect(sent.statusKey).toBe('waiting_approve');
    // nothing moves until approval
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 60 });
    const revs = await mustOk(p.revisions(po.id));
    expect(revs.map((r: { revNo: number; status: string }) => [r.revNo, r.status])).toEqual([[0, 'approved'], [1, 'open']]);
    const diff = revs[1].diff;
    expect(diff.header).toEqual([]);
    expect(diff.lines).toEqual([
      { lineNo: 1, change: 'changed', fields: expect.arrayContaining([expect.objectContaining({ field: 'qty', before: expect.stringMatching(/^60/), after: expect.stringMatching(/^80/) }), expect.objectContaining({ field: 'schedule' })]) },
      { lineNo: 2, change: 'changed', fields: [expect.objectContaining({ field: 'rate', label: 'Rate', before: expect.stringMatching(/^20/), after: expect.stringMatching(/^18/) })] },
    ]);
    const cur = await mustOk(p.get(po.id));
    const done = await mustOk(decidePo(c, f, po.id, cur.lines.map((l: { id: string; values: { qty: string } }) => ({ lineId: l.id, approve: String(Number(l.values.qty)) }))));
    expect(done.statusKey).toBe('approved');
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 80 });
    expect(await qtyOf(c, indent.lines[0].id)).toMatchObject({ ordered: 80 });
    expect(await qtyOf(c, po.lines[0].id)).toMatchObject({ ordered: 80, approved: 80 });
    expect(await qtyOf(c, selection.lines[1].id)).toMatchObject({ ordered: 50 });
    const after = await mustOk(p.revisions(po.id));
    expect(after.map((r: { revNo: number; status: string }) => [r.revNo, r.status])).toEqual([[0, 'approved'], [1, 'approved']]);
    const row = await c.db.selectFrom('app.document').select(['rev_no', 'custom']).where('id', '=', po.id).executeTakeFirstOrThrow();
    expect(row.rev_no).toBe(1);
    expect((await mustOk(p.get(po.id))).revNo).toBe(1);
    expect((row.custom as Record<string, unknown>).__amendment).toBeUndefined();
    const ev = await c.db.selectFrom('app.outbox_event').select('payload').where('event_type', '=', 'po.amended').where('aggregate_id', '=', po.id).execute();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ revNo: 1 });
    // a second amendment reducing qty releases quantity to the sources
    const am2 = await mustOk(p.amend(po.id, 'Second lot no longer needed'));
    const [m1, m2] = linesOf(am2);
    const ed2 = await mustOk(p.update(po.id, { version: am2.version, values: {}, lines: [{ id: m1!.id, values: { ...m1!.values, qty: '40', schedule: [{ date: '2026-12-01', qty: '40' }] } }, m2] }));
    await mustOk(p.submit(ed2.id, ed2.version));
    const cur2 = await mustOk(p.get(po.id));
    await mustOk(decidePo(c, f, po.id, cur2.lines.map((l: { id: string; values: { qty: string } }) => ({ lineId: l.id, approve: String(Number(l.values.qty)) }))));
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 40 });
    expect(await qtyOf(c, po.lines[0].id)).toMatchObject({ ordered: 40 });
    expect((await c.db.selectFrom('app.document').select('rev_no').where('id', '=', po.id).executeTakeFirstOrThrow()).rev_no).toBe(2);
  });

  it('rejection restores the previous revision; a withdrawn amendment changes nothing', async () => {
    const { selection, po } = await issuedPo();
    const p = poApi(c, f.po.token);
    const am = await mustOk(p.amend(po.id, 'Try a higher quantity'));
    const [l1, l2] = linesOf(am);
    const ed = await mustOk(p.update(po.id, { version: am.version, values: { freight: '500' }, lines: [{ id: l1!.id, values: { ...l1!.values, qty: '90', schedule: [{ date: '2026-12-01', qty: '90' }] } }, l2] }));
    expect(ed.values.freight).toBe('500.00');
    await mustOk(p.submit(ed.id, ed.version));
    const cur = await mustOk(p.get(po.id));
    const rej = await mustOk(decidePo(c, f, po.id, cur.lines.map((l: { id: string; values: { qty: string } }, i: number) => (i === 0
      ? { lineId: l.id, reject: String(Number(l.values.qty)), reason: 'Budget not available' }
      : { lineId: l.id, approve: String(Number(l.values.qty)) }))));
    expect(rej.statusKey).toBe('approved');
    const back = await mustOk(p.get(po.id));
    expect(back.lines[0].values.qty).toMatch(/^60/);
    expect(back.values.freight ?? null).toBe(po.values.freight ?? null);
    expect(await qtyOf(c, selection.lines[0].id)).toMatchObject({ ordered: 60 });
    expect(await qtyOf(c, po.lines[0].id)).toMatchObject({ ordered: 60, rejected: 0 });
    const revs = await mustOk(p.revisions(po.id));
    expect(revs.map((r: { revNo: number; status: string }) => [r.revNo, r.status])).toEqual([[0, 'approved'], [1, 'rejected']]);
    expect((await c.db.selectFrom('app.document').select('rev_no').where('id', '=', po.id).executeTakeFirstOrThrow()).rev_no).toBe(0);

    // withdraw
    const am2 = await mustOk(p.amend(po.id, 'Maybe change the rate'));
    const [w1, w2] = linesOf(am2);
    const ed2 = await mustOk(p.update(po.id, { version: am2.version, values: {}, lines: [{ id: w1!.id, values: { ...w1!.values, rate: '1' } }, w2] }));
    expect(ed2.lines[0].values.rate).toBe('1.00');
    const nothing = await p.submit(ed2.id, ed2.version + 100);
    expect(nothing.status).toBe(409);
    const wd = await mustOk(p.withdraw(po.id));
    expect(wd.statusKey).toBe('approved');
    expect(wd.lines[0].values.rate).toBe('10.00');
    expect((await p.withdraw(po.id)).status).toBe(409);
    // resubmitting an amendment without changes is refused
    const am3 = await mustOk(p.amend(po.id, 'No change really'));
    const same = await p.submit(am3.id, am3.version);
    expect(same.status).toBe(409);
    await mustOk(p.withdraw(po.id));
  });

  it('only approved POs, with the amend key', async () => {
    const { po } = await issuedPo();
    const noKey = await scoped(c, f.token, f.code, PO_BUYER_KEYS.filter(k => k !== 'doc.po:action.amend'));
    expect((await poApi(c, noKey.token).amend(po.id)).status).toBe(403);
    const { selection } = await approvedSelection(c, f, ['1'], [[0, 0, '1', '1']]);
    const [draft] = await mustOk(poApi(c, f.po.token).fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '1' }] }), 201);
    expect((await poApi(c, f.po.token).amend(draft.id)).status).toBe(409);
  });
});

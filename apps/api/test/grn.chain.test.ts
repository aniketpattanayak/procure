/**
 * Phase 5 GRN verification chain with quality: QA reject → block_stock (quarantine) → routed to disposition →
 * reject = return_to_vendor (draft RTV) → RTV approval (stock out, `returned`, PO re-opened per rtv.reopens_po);
 * disposition approve keeps the stock blocked; batches/expiry create stock_batch; manual RTV after acceptance.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { docs } from './procurement-helpers';
import { approvedPo, decideGrn, docStatus, grnTenant, GrnFixture, inv, lineQty, requireQc, stockAt, submittedGrn } from './grn-helpers';

let c: Ctx;
let f: GrnFixture;

beforeAll(async () => {
  c = await bootApp();
  f = await grnTenant(c);
  await requireQc(c, [f.items[0]!]);
});
afterAll(async () => closeApp(c));

async function rtvFor(grnId: string) {
  return c.db.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select(['d.id', 'd.status_key', 'd.custom', 'd.party_id'])
    .where('t.key', '=', 'rtv').where(sql<boolean>`d.custom->>'grn' = ${grnId}`).execute();
}

describe('quality reject → block → disposition → RTV', () => {
  it('runs the whole chain with line granularity and partial decisions', async () => {
    const po = await approvedPo(c, f, ['500']);
    const pl = po.lines[0]!.id;
    const g = await submittedGrn(c, f, po, [[0, '300', { batchNo: 'LOT-7', mfgDate: '2026-09-01', expiryDate: '2027-09-01' }]]);
    const gl = g.lines[0]!.id;
    expect(g.lines[0]!.values.requires_qc).toBe(true);
    await mustOk(decideGrn(c, f.token, g.id, 'gate', [[gl, '300']]));
    const st = await mustOk(decideGrn(c, f.token, g.id, 'store', [[gl, '300']]));
    expect(st.statusKey).toBe('waiting_quality');
    const batch = await c.db.selectFrom('app.stock_batch').selectAll().where('item_id', '=', f.items[0]!).where('batch_no', '=', 'LOT-7').executeTakeFirstOrThrow();
    const exp = await sql<{ d: string }>`select expiry_date::text as d from app.stock_batch where id = ${batch.id}`.execute(c.db);
    expect(exp.rows[0]!.d).toBe('2027-09-01');
    expect(batch.vendor_id).toBe(f.vendors[0]);
    const s1 = await stockAt(c, f.items[0]!, f.pune);
    expect(s1.available).toBe(300);
    // QA approves 250, rejects 50 → 50 blocked (quarantine) and routed to disposition.
    const qa = await mustOk(decideGrn(c, f.token, g.id, 'quality', [[gl, '250', '50']], 'Rust spots'));
    expect(qa.statusKey).toBe('waiting_disposition');
    expect(await stockAt(c, f.items[0]!, f.pune)).toMatchObject({ available: 250, quarantine: 50 });
    const blocks = await c.db.selectFrom('app.stock_movement').selectAll().where('line_id', '=', gl).where('movement_type', '=', 'block').execute();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.pair_id).toBe(blocks[1]!.pair_id);
    expect(blocks.every(b => b.batch_id === batch.id)).toBe(true);
    // Posted qty rejected later is NOT rejected_at_receipt.
    expect(await lineQty(c, pl)).toMatchObject({ received: 300, accepted: 300, rejectedAtReceipt: 0 });
    expect(await rtvFor(g.id)).toHaveLength(0);
    // Disposition rejects → draft RTV for 50 from quarantine.
    const dis = await mustOk(decideGrn(c, f.token, g.id, 'disposition', [[gl, '0', '50']], 'Return to vendor'));
    expect(dis.statusKey).toBe('partially_approved');
    const rtvs = await rtvFor(g.id);
    expect(rtvs).toHaveLength(1);
    expect(rtvs[0]!.status_key).toBe('draft');
    expect(rtvs[0]!.party_id).toBe(f.vendors[0]);
    const rtv = await mustOk(docs(c, f.token, 'rtv').get(rtvs[0]!.id));
    expect(rtv.lines).toHaveLength(1);
    expect(rtv.lines[0].values).toMatchObject({ grn_line: gl, from_status: 'quarantine', batch_no: 'LOT-7', item: f.items[0] });
    expect(Number(rtv.lines[0].values.qty)).toBe(50);
    // Submit + approve the RTV → stock out of quarantine, returned on GRN + PO lines, PO re-opened.
    expect(await docStatus(c, po.id)).toBe('partially_received');
    const sub = await mustOk(docs(c, f.storekeeper.token, 'rtv').submit(rtv.id, rtv.version));
    const ap = await mustOk(docs(c, f.token, 'rtv').act(sub.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: sub.lines[0].id, approve: '50' }] }));
    expect(ap.statusKey).toBe('approved');
    expect(await stockAt(c, f.items[0]!, f.pune)).toMatchObject({ available: 250, quarantine: 0 });
    const out = await c.db.selectFrom('app.stock_movement').selectAll().where('document_id', '=', sub.id).execute();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ movement_type: 'rtv', stock_status: 'quarantine' });
    expect(await lineQty(c, gl)).toMatchObject({ accepted: 300, returned: 50 });
    expect(await lineQty(c, pl)).toMatchObject({ received: 300, returned: 50 });
    const page = await mustOk(inv(c, f.storekeeper.token).receivable(`po=${po.id}`));
    expect(page.data[0]).toMatchObject({ received: '250', pendingReceipt: '250' });
    // The PO detail (documents core) agrees with the receivable list, per rtv.reopens_po.
    const poDoc = await mustOk(api(c, f.token).get(`/docs/po/${po.id}`));
    expect(poDoc.lines[0].qty.pendingReceipt).toBe('250');
    await mustOk(inv(c, f.token).settings({ 'rtv.reopens_po': false }));
    expect((await mustOk(api(c, f.token).get(`/docs/po/${po.id}`))).lines[0].qty.pendingReceipt).toBe('200');
    expect((await mustOk(inv(c, f.storekeeper.token).receivable(`po=${po.id}`))).data[0].pendingReceipt).toBe('200');
    await mustOk(inv(c, f.token).settings({ 'rtv.reopens_po': true }));
    // GRN lines (no ordered qty) never show a pending receipt.
    expect((await mustOk(docs(c, f.token, 'grn').get(g.id))).lines[0].qty.pendingReceipt).toBe('0');
    // Retrying the effect for the same action does not create a second RTV.
    expect(await rtvFor(g.id)).toHaveLength(1);
    // Debit note: the starter template `rtv_debit_note` is installed and renders the RTV.
    const tpl = await c.db.selectFrom('app.message_template').select(['body', 'is_default']).where('tenant_id', '=', f.tenantId).where('key', '=', 'rtv_debit_note').executeTakeFirstOrThrow();
    expect(tpl.is_default).toBe(true);
    const out2 = await mustOk(api(c, f.token).post('/config/templates/preview', { documentId: sub.id, template: { channel: 'pdf', docTypeKey: 'rtv', key: 'rtv_preview', name: 'x', body: tpl.body } }));
    expect(out2.html).toContain('Debit Note');
    expect(out2.html).toContain('Vendor A');
    expect(out2.html).toContain(sub.number);
  });

  it('disposition approve keeps the stock blocked (rework); quality approve of everything skips disposition', async () => {
    const po = await approvedPo(c, f, ['100']);
    const g = await submittedGrn(c, f, po, [[0, '100']]);
    const gl = g.lines[0]!.id;
    const base = await stockAt(c, f.items[0]!, f.pune);
    await mustOk(decideGrn(c, f.token, g.id, 'gate', [[gl, '100']]));
    await mustOk(decideGrn(c, f.token, g.id, 'store', [[gl, '100']]));
    await mustOk(decideGrn(c, f.token, g.id, 'quality', [[gl, '90', '10']], 'Coating defects'));
    const done = await mustOk(decideGrn(c, f.token, g.id, 'disposition', [[gl, '10']]));
    expect(done.statusKey).toBe('approved');
    const now = await stockAt(c, f.items[0]!, f.pune);
    expect(now.available - base.available).toBe(90);
    expect(now.quarantine - base.quarantine).toBe(10);
    expect(await rtvFor(g.id)).toHaveLength(0);

    const po2 = await approvedPo(c, f, ['20']);
    const g2 = await submittedGrn(c, f, po2, [[0, '20']]);
    const l2 = g2.lines[0]!.id;
    await mustOk(decideGrn(c, f.token, g2.id, 'gate', [[l2, '20']]));
    await mustOk(decideGrn(c, f.token, g2.id, 'store', [[l2, '20']]));
    const q = await mustOk(decideGrn(c, f.token, g2.id, 'quality', [[l2, '20']]));
    expect(q.statusKey).toBe('approved');
  });

  it('items without requires_qc skip the quality stage', async () => {
    const po = await approvedPo(c, f, ['10', '10']);
    // Line 1 = item 1 (no QC); a GRN of only that line skips quality.
    const g = await submittedGrn(c, f, po, [[1, '10']]);
    expect(g.lines[0]!.values.requires_qc).toBe(false);
    await mustOk(decideGrn(c, f.token, g.id, 'gate', [[g.lines[0]!.id, '10']]));
    const s = await mustOk(decideGrn(c, f.token, g.id, 'store', [[g.lines[0]!.id, '10']]));
    expect(s.statusKey).toBe('approved');
  });

  it('requires_qc on a linked master (item category) also routes to quality', async () => {
    const cat = await mustOk(api(c, f.token).post('/masters/department/records', { code: `QC${Math.floor(Math.random() * 1e6)}`, name: 'QC category', data: {} }), 201);
    await c.db.updateTable('app.master_record').set({ data: JSON.stringify({ requires_qc: true }) }).where('id', '=', cat.id).execute();
    await sql`update app.master_record set data = data || jsonb_build_object('category', ${cat.id}::text) where id = ${f.items[2]!}`.execute(c.db);
    const po = await approvedPo(c, f, ['1', '1', '4']);
    const g = await submittedGrn(c, f, po, [[2, '4']]);
    expect(g.lines[0]!.values.requires_qc).toBe(true);
    await mustOk(decideGrn(c, f.token, g.id, 'gate', [[g.lines[0]!.id, '4']]));
    const s = await mustOk(decideGrn(c, f.token, g.id, 'store', [[g.lines[0]!.id, '4']]));
    expect(s.statusKey).toBe('waiting_quality');
  });
});

describe('manual RTV after acceptance', () => {
  it('returns available stock; cannot exceed accepted − returned − open returns; rtv.reopens_po = false keeps the PO closed', async () => {
    const po = await approvedPo(c, f, ['40', '40']);
    const pl = po.lines[1]!.id;
    const g = await submittedGrn(c, f, po, [[1, '40']]);
    const gl = g.lines[0]!.id;
    await mustOk(decideGrn(c, f.token, g.id, 'gate', [[gl, '40']]));
    await mustOk(decideGrn(c, f.token, g.id, 'store', [[gl, '40']]));
    const list = await mustOk(inv(c, f.storekeeper.token).returnableGrn(`grn=${g.id}`));
    expect(list.data[0]).toMatchObject({ grnLineId: gl, accepted: '40', returned: '0', returnable: '40' });
    const tooMuch = await inv(c, f.storekeeper.token).rtvFromGrn({ lines: [{ grnLineId: gl, qty: '41' }] });
    expect(tooMuch.status).toBe(400);
    const r1 = await mustOk(inv(c, f.storekeeper.token).rtvFromGrn({ submit: true, lines: [{ grnLineId: gl, qty: '30', reason: 'Excess supply' }] }), 201);
    expect(r1.statusKey).toBe('waiting_approve');
    // A second RTV over the remaining 10 fails at submit (30 already in an open return).
    const r2 = await mustOk(inv(c, f.storekeeper.token).rtvFromGrn({ lines: [{ grnLineId: gl, qty: '10' }] }), 201);
    await c.db.updateTable('app.document_line').set({ qty: '11' }).where('document_id', '=', r2.id).execute();
    const bad = await docs(c, f.storekeeper.token, 'rtv').submit(r2.id, r2.version);
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('QTY_EXCEEDS_REMAINING');
    await mustOk(inv(c, f.token).settings({ 'rtv.reopens_po': false }));
    try {
      const before = await stockAt(c, f.items[1]!, f.pune);
      await mustOk(docs(c, f.token, 'rtv').act(r1.id, { action: 'decide', stageKey: 'approve', decisions: [{ lineId: r1.lines[0].id, approve: '30' }] }));
      expect(before.available - (await stockAt(c, f.items[1]!, f.pune)).available).toBe(30);
      expect(await lineQty(c, pl)).toMatchObject({ received: 40, returned: 30 });
      expect(await docStatus(c, po.id)).toBe('partially_received'); // line 0 not received; line 1 still counts as received
      const page = await mustOk(inv(c, f.storekeeper.token).receivable(`po=${po.id}`));
      expect(page.data.find((l: { poLineId: string }) => l.poLineId === pl)).toBeUndefined();
    } finally {
      await mustOk(inv(c, f.token).settings({ 'rtv.reopens_po': true }));
    }
    const page = await mustOk(inv(c, f.storekeeper.token).receivable(`po=${po.id}`));
    expect(page.data.find((l: { poLineId: string }) => l.poLineId === pl)).toMatchObject({ pendingReceipt: '30' });
  });
});

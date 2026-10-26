import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors';
import { applyEvent, documentStatus, emptyBuckets, fromUnits, lineStatus, statusLabel, toQuantityBuckets, toUnits } from '../src/modules/documents';
import { Buckets, qty } from '../src/modules/documents/qty';
import { mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import {
  addStageViews, capexBody, createCapexType, docsApi, docsTenant, DocsFixture, documentsPort, FakeWorkflow, submittedCapex, tenantTx, workflowLink,
} from './documents-helpers';

const B = (o: Partial<Record<keyof Buckets, number>>): Buckets => {
  const b = emptyBuckets();
  for (const [k, v] of Object.entries(o)) b[k as keyof Buckets] = toUnits(String(v));
  return b;
};
const S = (o: Record<string, [number, number]>) => Object.fromEntries(Object.entries(o).map(([k, [p, h]]) => [k, { pending: toUnits(String(p)), held: toUnits(String(h)) }]));

describe('quantity arithmetic (pure)', () => {
  it('parses and prints decimals exactly', () => {
    expect(fromUnits(toUnits('12.5'))).toBe('12.5');
    expect(fromUnits(toUnits('0012.5000'))).toBe('12.5');
    expect(fromUnits(toUnits('0.0001'))).toBe('0.0001');
    expect(fromUnits(toUnits('-3'))).toBe('-3');
    expect(qty('10.0000')).toBe('10');
    expect(fromUnits(toUnits('0.1') + toUnits('0.2'))).toBe('0.3');
    expect(() => toUnits('1.23456')).toThrow();
    expect(() => toUnits('abc')).toThrow();
    expect(toUnits(null)).toBe(0n);
  });

  it('applies events and enforces invariants', () => {
    const b = emptyBuckets();
    expect(applyEvent(b, 'requested', toUnits('10'))).toBeNull();
    expect(applyEvent(b, 'held', toUnits('3'))).toBeNull();
    expect(applyEvent(b, 'unheld', toUnits('3'))).toBeNull();
    expect(applyEvent(b, 'unheld', toUnits('1'))).toBe('held');
    const c = B({ requested: 10 });
    expect(applyEvent(c, 'approved', toUnits('7'))).toBeNull();
    expect(applyEvent(c, 'rejected', toUnits('4'))).toBe('rejected');
    const d = B({ requested: 10, approved: 7 });
    expect(applyEvent(d, 'over_approved', toUnits('2'))).toBeNull();
    expect(applyEvent(d, 'approved', toUnits('5'))).toBeNull();
    expect(applyEvent(d, 'cancelled', toUnits('0.0001'))).toBe('cancelled');
    expect(applyEvent(B({}), 'selection_cancelled', 1n)).toBe('selected');
    expect(applyEvent(B({ ordered: 1 }), 'order_cancelled', toUnits('1'))).toBeNull();
    expect(applyEvent(B({}), 'teleported', 1n)).toBe('invariant');
  });

  it('derives pending figures', () => {
    expect(toQuantityBuckets(B({ requested: 10, approved: 6, rejected: 1, held: 2 }))).toMatchObject({ pendingApproval: '3', pendingOrder: '6', pendingReceipt: '0' });
    expect(toQuantityBuckets(B({ requested: 10, approved: 10, ordered: 7, short_closed: 1, received: 5 }))).toMatchObject({ pendingOrder: '2', pendingReceipt: '2' });
    expect(toQuantityBuckets(B({ requested: 5, over_approved: 2, approved: 7 }))).toMatchObject({ pendingApproval: '0', pendingOrder: '9', overApproved: '2' });
  });
});

describe('status computation (table-driven)', () => {
  const order = ['hod', 'finance', 'director'];
  const lineCases: [string, Buckets, Record<string, { pending: bigint; held: bigint }>, boolean, string][] = [
    ['pending at the first stage', B({ requested: 5 }), S({ hod: [5, 0] }), false, 'waiting_hod'],
    ['split across stages → earliest with pending', B({ requested: 5 }), S({ finance: [2, 0], hod: [3, 0] }), false, 'waiting_hod'],
    ['held at hod while the rest waits at finance', B({ requested: 5, held: 2 }), S({ hod: [0, 2], finance: [3, 0] }), false, 'waiting_finance'],
    ['only held qty remains', B({ requested: 5, held: 2, approved: 3 }), S({ hod: [0, 2] }), false, 'on_hold'],
    ['held without workflow state (ledger only)', B({ requested: 5, held: 2 }), {}, false, 'on_hold'],
    ['fully cancelled', B({ requested: 5, cancelled: 5 }), {}, false, 'cancelled'],
    ['all rejected', B({ requested: 5, rejected: 5 }), {}, false, 'rejected'],
    ['reduced', B({ requested: 5, approved: 3, rejected: 2 }), {}, false, 'partially_approved'],
    ['approved after a partial cancel', B({ requested: 5, approved: 3, cancelled: 2 }), {}, false, 'approved'],
    ['approved', B({ requested: 5, approved: 5 }), {}, false, 'approved'],
    ['over-approved', B({ requested: 5, over_approved: 1, approved: 6 }), {}, false, 'approved'],
    ['document closed', B({ requested: 5, approved: 5 }), {}, true, 'closed'],
    ['short-closed line', B({ requested: 5, approved: 5, short_closed: 5 }), {}, false, 'closed'],
    ['partly ordered then short-closed', B({ requested: 5, approved: 5, ordered: 3, short_closed: 2 }), {}, false, 'closed'],
    ['unknown stage sorts after known ones', B({ requested: 5 }), S({ zzz: [1, 0], director: [4, 0] }), false, 'waiting_director'],
  ];
  for (const [name, b, st, closed, want] of lineCases) {
    it(`line: ${name} → ${want}`, () => expect(lineStatus({ buckets: b, stages: st }, order, closed)).toBe(want));
  }

  const docCases: [string, { submitted?: boolean; cancelled?: boolean; closed?: boolean }, string[], string][] = [
    ['not submitted', { submitted: false }, ['approved'], 'draft'],
    ['earliest waiting stage across lines', {}, ['waiting_finance', 'waiting_hod', 'approved'], 'waiting_hod'],
    ['hold beats outcomes', {}, ['on_hold', 'approved'], 'on_hold'],
    ['waiting beats hold', {}, ['on_hold', 'waiting_director'], 'waiting_director'],
    ['mix of approved and rejected', {}, ['approved', 'rejected'], 'partially_approved'],
    ['a reduced line', {}, ['approved', 'partially_approved'], 'partially_approved'],
    ['approved (cancelled lines ignored)', {}, ['approved', 'cancelled'], 'approved'],
    ['rejected', {}, ['rejected', 'rejected'], 'rejected'],
    ['all lines cancelled', {}, ['cancelled', 'cancelled'], 'cancelled'],
    ['explicitly cancelled document', { cancelled: true }, ['approved', 'cancelled'], 'cancelled'],
    ['closed document', { closed: true }, ['closed', 'closed'], 'closed'],
    ['all lines short-closed', {}, ['closed', 'closed'], 'closed'],
    ['closed + approved lines', {}, ['closed', 'approved'], 'approved'],
    ['closed + rejected lines', {}, ['closed', 'rejected'], 'partially_approved'],
    ['no lines', {}, [], 'approved'],
  ];
  for (const [name, d, lines, want] of docCases) {
    it(`document: ${name} → ${want}`, () => expect(documentStatus({ submitted: d.submitted ?? true, cancelled: !!d.cancelled, closed: !!d.closed }, lines, ['hod', 'finance', 'director'])).toBe(want));
  }

  it('labels', () => {
    expect(statusLabel('waiting_hod', { waiting_hod: 'With HOD' })).toBe('With HOD');
    expect(statusLabel('waiting_cost_centre', {})).toBe('Waiting for Cost centre');
    expect(statusLabel('partially_approved', {})).toBe('Partially approved');
    expect(statusLabel('ordered', {})).toBe('Ordered');
  });
});

describe('DocumentsPort (integration)', () => {
  let c: Ctx;
  let f: DocsFixture;
  const fake = new FakeWorkflow();

  beforeAll(async () => {
    c = await bootApp();
    f = await docsTenant(c);
    await createCapexType(c, f.token);
    await addStageViews(c, f, 'capex', ['hod', 'finance']);
    workflowLink(c).override(fake);
  });
  afterAll(async () => {
    workflowLink(c).override(undefined);
    await closeApp(c);
  });

  const expectInvariant = async (p: Promise<unknown>, bucket: string) => {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(409);
    expect((e as AppError).code).toBe('QTY_INVARIANT');
    expect((e as AppError).meta?.bucket).toBe(bucket);
  };

  it('snapshot: values by form keys, lines, lookup attributes for routing', async () => {
    const sub = await submittedCapex(c, f);
    const snap = await tenantTx(c, f.tenantId, tx => documentsPort(c).snapshot(tx, sub.id));
    expect(snap).toMatchObject({ id: sub.id, tenantId: f.tenantId, docTypeKey: 'capex', number: sub.number, statusKey: 'waiting_hod', locationNodeId: f.pune, createdBy: f.adminId, submittedBy: f.adminId });
    expect(snap.values).toMatchObject({ purpose: sub.values.purpose, total_amount: '120000.00', location: f.pune });
    expect(snap.lines.map(l => [l.lineNo, l.qty, l.isCancelled])).toEqual([[1, '2', false], [2, '1', false]]);
    expect(snap.lookups.location).toMatchObject({ name: 'Pune plant' });
    expect(snap.lineLookups[snap.lines[0]!.id]!.item).toMatchObject({ name: 'Laptop', uom: f.uom });
    expect(snap.locationPath).toMatch(/^[\w.]+$/);
  });

  it('negative buckets and over-approval are 409 QTY_INVARIANT and nothing is written', async () => {
    const sub = await submittedCapex(c, f);
    const line = sub.lines[0].id;
    const port = documentsPort(c);
    await expectInvariant(tenantTx(c, f.tenantId, tx => port.recordQuantities(tx, sub.id, [{ lineId: line, type: 'approved', qty: '3' }], null)), 'approved');
    await expectInvariant(tenantTx(c, f.tenantId, tx => port.recordQuantities(tx, sub.id, [{ lineId: line, type: 'unheld', qty: '1' }], null)), 'held');
    await expectInvariant(tenantTx(c, f.tenantId, tx => port.recordQuantities(tx, sub.id, [
      { lineId: line, type: 'approved', qty: '1' }, { lineId: line, type: 'rejected', qty: '1.0001' },
    ], null)), 'rejected');
    const ev = await c.db.selectFrom('app.line_event').select('event_type').where('line_id', '=', line).execute();
    expect(ev.map(e => e.event_type)).toEqual(['requested']);
    // malformed and foreign lines
    await expect(tenantTx(c, f.tenantId, tx => port.recordQuantities(tx, sub.id, [{ lineId: line, type: 'approved', qty: '-1' }], null))).rejects.toMatchObject({ status: 400 });
    const other = await submittedCapex(c, f);
    await expect(tenantTx(c, f.tenantId, tx => port.recordQuantities(tx, sub.id, [{ lineId: other.lines[0].id, type: 'approved', qty: '1' }], null))).rejects.toMatchObject({ status: 404 });
    // valid batch updates the summary in the same transaction
    await tenantTx(c, f.tenantId, tx => port.recordQuantities(tx, sub.id, [{ lineId: line, type: 'approved', qty: '1.5' }, { lineId: line, type: 'rejected', qty: '0.5' }], f.adminId));
    const s = await c.db.selectFrom('app.line_qty_summary').selectAll().where('line_id', '=', line).executeTakeFirstOrThrow();
    expect([s.requested, s.approved, s.rejected].map(Number)).toEqual([2, 1.5, 0.5]);
    const last = await c.db.selectFrom('app.line_event').select(['id', 'actor_id']).where('line_id', '=', line).orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(String(s.last_event_id)).toBe(String(last.id));
    expect(last.actor_id).toBe(f.adminId);
  });

  it('concurrent recordQuantities on the same line serialise: exactly one of two over-committing writers wins', async () => {
    const sub = await submittedCapex(c, f, { lines: [{ qty: '10', est_rate: '1' }] });
    const line = sub.lines[0].id;
    const port = documentsPort(c);
    const attempt = () => tenantTx(c, f.tenantId, async tx => {
      await port.recordQuantities(tx, sub.id, [{ lineId: line, type: 'approved', qty: '6' }], null);
      await new Promise(r => setTimeout(r, 50));
    });
    const res = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(res.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res.filter(x => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'QTY_INVARIANT' });
    const s = await c.db.selectFrom('app.line_qty_summary').select('approved').where('line_id', '=', line).executeTakeFirstOrThrow();
    expect(Number(s.approved)).toBe(6);
    // and many small concurrent writers all land, in some order, with an exact total
    await Promise.all(Array.from({ length: 8 }, () => tenantTx(c, f.tenantId, tx => port.recordQuantities(tx, sub.id, [{ lineId: line, type: 'rejected', qty: '0.5' }], null))));
    const s2 = await c.db.selectFrom('app.line_qty_summary').select(['approved', 'rejected']).where('line_id', '=', line).executeTakeFirstOrThrow();
    expect(Number(s2.rejected)).toBe(4);
    const sum = await c.db.selectFrom('app.line_event').select(eb => eb.fn.sum<string>('qty').as('t')).where('line_id', '=', line).where('event_type', '=', 'rejected').executeTakeFirstOrThrow();
    expect(Number(sum.t)).toBe(4);
  });

  it('recomputeStatus follows the workflow: stages, hold, completion, audit + outbox on change', async () => {
    const sub = await submittedCapex(c, f, { lines: [{ qty: '4', est_rate: '1' }, { qty: '2', est_rate: '1' }] });
    const [l1, l2] = sub.lines.map((l: { id: string }) => l.id);
    await fake.decide(c, f.tenantId, sub.id, l1, 'hod', { approve: 4 });
    let d = await mustOk(docsApi(c, f.token).get(sub.id));
    expect([d.statusKey, ...d.lines.map((l: { statusKey: string }) => l.statusKey)]).toEqual(['waiting_hod', 'waiting_finance', 'waiting_hod']);
    await fake.decide(c, f.tenantId, sub.id, l2, 'hod', { hold: 2 });
    d = await mustOk(docsApi(c, f.token).get(sub.id));
    expect([d.statusKey, ...d.lines.map((l: { statusKey: string }) => l.statusKey)]).toEqual(['waiting_finance', 'waiting_finance', 'on_hold']);
    await fake.decide(c, f.tenantId, sub.id, l1, 'finance', { approve: 4 });
    d = await mustOk(docsApi(c, f.token).get(sub.id));
    expect(d.statusKey).toBe('on_hold');
    const r = await tenantTx(c, f.tenantId, tx => documentsPort(c).recomputeStatus(tx, sub.id));
    expect(r).toEqual({ statusKey: 'on_hold', changed: false });
    const audit = await c.db.selectFrom('app.audit_log').select(['action', 'before', 'after']).where('entity_id', '=', sub.id).where('action', '=', 'status').orderBy('id').execute();
    expect(audit.map(a => (a.after as { status: string }).status)).toEqual(['waiting_hod', 'waiting_finance', 'on_hold']);
    expect((audit[0]!.before as { status: string }).status).toBe('draft');
    const ob = await c.db.selectFrom('app.outbox_event').select('payload').where('aggregate_id', '=', sub.id).where('event_type', '=', 'document.status_changed').orderBy('id').execute();
    expect(ob.map(o => (o.payload as { to: string }).to)).toEqual(['waiting_hod', 'waiting_finance', 'on_hold']);
  });

  it('setLocked, applyLineEdits (allowed fields only), close and emit', async () => {
    const sub = await submittedCapex(c, f);
    const port = documentsPort(c);
    await tenantTx(c, f.tenantId, tx => port.setLocked(tx, sub.id, false));
    expect((await mustOk(docsApi(c, f.token).get(sub.id))).isLocked).toBe(false);
    await tenantTx(c, f.tenantId, tx => port.applyLineEdits(tx, sub.id, [{ lineId: sub.lines[0].id, values: { est_rate: '40000' } }], ['est_rate']));
    const edited = await mustOk(docsApi(c, f.token).get(sub.id));
    expect(edited.lines[0].values).toMatchObject({ est_rate: '40000.00', amount: '80000.00' });
    expect(edited.values.total_amount).toBe('100000.00');
    await expect(tenantTx(c, f.tenantId, tx => port.applyLineEdits(tx, sub.id, [{ lineId: sub.lines[0].id, values: { remarks: 'x' } }], ['est_rate']))).rejects.toMatchObject({ code: 'FIELD_READ_ONLY' });
    await expect(tenantTx(c, f.tenantId, tx => port.applyLineEdits(tx, sub.id, [{ lineId: sub.lines[0].id, values: { qty: '9' } }], ['qty']))).rejects.toMatchObject({ status: 409 });
    await expect(tenantTx(c, f.tenantId, tx => port.applyLineEdits(tx, sub.id, [{ lineId: sub.lines[0].id, values: { est_rate: 'abc' } }], ['est_rate']))).rejects.toMatchObject({ status: 400 });
    await fake.decide(c, f.tenantId, sub.id, sub.lines[0].id, 'hod', { reject: 2 });
    await fake.decide(c, f.tenantId, sub.id, sub.lines[1].id, 'hod', { reject: 1 });
    expect((await mustOk(docsApi(c, f.token).get(sub.id))).statusKey).toBe('rejected');
    await tenantTx(c, f.tenantId, tx => port.close(tx, sub.id, 'Closed by workflow', null));
    const closed = await mustOk(docsApi(c, f.token).get(sub.id));
    expect(closed.statusKey).toBe('closed');
    await tenantTx(c, f.tenantId, tx => port.close(tx, sub.id, 'twice', null)); // idempotent
    await tenantTx(c, f.tenantId, tx => port.emit(tx, 'workflow.completed', { kind: 'document', id: sub.id }, { ok: true }));
    const ev = await c.db.selectFrom('app.outbox_event').select(['event_type', 'tenant_id']).where('aggregate_id', '=', sub.id).orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(ev).toEqual({ event_type: 'workflow.completed', tenant_id: f.tenantId });
  });

  it('returnToDraft keeps the number, cancels what was in approval and re-requests on resubmit', async () => {
    const sub = await submittedCapex(c, f, { lines: [{ qty: '3', est_rate: '1' }] });
    const line = sub.lines[0].id;
    await fake.decide(c, f.tenantId, sub.id, line, 'hod', { hold: 1 });
    fake.state.delete(sub.id); // the workflow cancels its instance before handing back
    await tenantTx(c, f.tenantId, tx => documentsPort(c).returnToDraft(tx, sub.id, f.adminId, 'Please add quotes'));
    const draft = await mustOk(docsApi(c, f.token).get(sub.id));
    expect(draft).toMatchObject({ statusKey: 'draft', number: sub.number, isLocked: false });
    expect(draft.lines[0]).toMatchObject({ statusKey: 'draft' });
    expect(draft.lines[0].qty).toMatchObject({ requested: '3', cancelled: '3', held: '0', pendingApproval: '0' });
    expect(draft.allowedActions).toEqual(expect.arrayContaining(['edit', 'submit']));
    const edited = await mustOk(docsApi(c, f.token).update(sub.id, { version: draft.version, values: draft.values, lines: [{ id: line, values: { ...draft.lines[0].values, qty: '5' } }] }));
    const again = await mustOk(docsApi(c, f.token).submit(sub.id, edited.version));
    expect(again.number).toBe(sub.number);
    expect(again.lines[0].qty).toMatchObject({ requested: '8', cancelled: '3', pendingApproval: '5' });
    expect(again.statusKey).toBe('waiting_hod');
    const tl = await mustOk(docsApi(c, f.token).raw.get(`/docs/capex/${sub.id}/timeline`));
    expect(tl.some((e: { title: string }) => e.title === 'Returned to draft')).toBe(true);
  });

  it('submit with the real workflow module (no published workflow) approves immediately', async () => {
    workflowLink(c).override(undefined);
    try {
      const d = docsApi(c, f.token);
      const doc = await mustOk(d.create(capexBody(f)), 201);
      const sub = await mustOk(d.submit(doc.id, doc.version));
      expect(sub.statusKey).toBe('approved');
      expect(sub.lines[0].qty).toMatchObject({ requested: '2', approved: '2' });
    } finally {
      workflowLink(c).override(fake);
    }
  });
});

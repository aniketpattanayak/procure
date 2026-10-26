/**
 * Phase 5 GRN: concurrent GRNs on the same PO line (row locks), permissions and data scope on the inventory
 * endpoints, tenant isolation (RLS) of GRN documents / receivable lines, and the `engine:receipts` report source.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { docs, scoped } from './procurement-helpers';
import { approvedPo, decideGrn, grnTenant, GrnFixture, inv, lineQty, STOREKEEPER_KEYS, submittedGrn } from './grn-helpers';

let c: Ctx;
let f: GrnFixture;

beforeAll(async () => {
  c = await bootApp();
  f = await grnTenant(c);
});
afterAll(async () => closeApp(c));

describe('concurrency', () => {
  it('two GRNs submitted at once against the same PO line: exactly one fits the pending qty', async () => {
    const po = await approvedPo(c, f, ['100']);
    const pl = po.lines[0]!.id;
    const mk = async () => (await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: pl, qty: '60' }] }), 201))[0];
    const [a, b] = [await mk(), await mk()];
    const res = await Promise.all([a, b].map(g => docs(c, f.storekeeper.token, 'grn').submit(g.id, g.version)));
    const codes = res.map(r => r.status).sort();
    expect(codes).toEqual([200, 409]);
    expect(res.find(r => r.status === 409)!.body.code).toBe('QTY_EXCEEDS_REMAINING');
    expect((await lineQty(c, pl)).received).toBe(60);
  });

  it('five concurrent submits of 30 on a 100 line: at most 105 received', async () => {
    const po = await approvedPo(c, f, ['100']);
    const pl = po.lines[0]!.id;
    const drafts = [];
    for (let i = 0; i < 5; i++) drafts.push((await mustOk(inv(c, f.storekeeper.token).fromPo({ lines: [{ poLineId: pl, qty: '30' }] }), 201))[0]);
    const res = await Promise.all(drafts.map(g => docs(c, f.storekeeper.token, 'grn').submit(g.id, g.version)));
    expect(res.filter(r => r.status === 200)).toHaveLength(3);
    expect(res.filter(r => r.status === 409)).toHaveLength(2);
    expect((await lineQty(c, pl)).received).toBe(90);
  });
});

describe('permissions and scope', () => {
  it('needs doc.grn:action.add for receivable lines / from-po, and doc.rtv:action.add for RTV helpers', async () => {
    const viewer = await scoped(c, f.token, f.code, ['doc.grn:action.view', 'doc.grn:view.draft']);
    expect((await inv(c, viewer.token).receivable()).status).toBe(403);
    expect((await inv(c, viewer.token).fromPo({ lines: [{ poLineId: '00000000-0000-4000-8000-000000000000', qty: '1' }] })).status).toBe(403);
    expect((await inv(c, viewer.token).returnableGrn()).status).toBe(403);
    expect((await inv(c, viewer.token).rtvFromGrn({ lines: [{ grnLineId: '00000000-0000-4000-8000-000000000000', qty: '1' }] })).status).toBe(403);
    expect((await inv(c, viewer.token).issuable()).status).toBe(403);
    expect((await inv(c, viewer.token).returnable()).status).toBe(403);
  });

  it('receivable lines follow the GRN data scope (PO location)', async () => {
    const po = await approvedPo(c, f, ['7']);
    const chennaiOnly = await scoped(c, f.token, f.code, STOREKEEPER_KEYS, f.chennai);
    const page = await mustOk(inv(c, chennaiOnly.token).receivable(`po=${po.id}`));
    expect(page.data).toHaveLength(0);
    const r = await inv(c, chennaiOnly.token).fromPo({ lines: [{ poLineId: po.lines[0]!.id, qty: '1' }] });
    expect(r.status).toBe(400);
  });

  it('a storekeeper without the stage key cannot decide at the gate', async () => {
    const po = await approvedPo(c, f, ['3']);
    const g = await submittedGrn(c, f, po, [[0, '3']]);
    const r = await decideGrn(c, f.storekeeper.token, g.id, 'gate', [[g.lines[0]!.id, '3']]);
    expect([403, 404]).toContain(r.status);
  });
});

describe('tenant isolation', () => {
  it('another tenant cannot see or receive against this tenant\'s POs / GRNs', async () => {
    const po = await approvedPo(c, f, ['9']);
    const g = await submittedGrn(c, f, po, [[0, '4']]);
    const other = await grnTenant(c);
    expect((await docs(c, other.token, 'grn').get(g.id)).status).toBe(404);
    const page = await mustOk(inv(c, other.token).receivable());
    expect(page.data.find((l: { poId: string }) => l.poId === po.id)).toBeUndefined();
    expect((await inv(c, other.token).fromPo({ lines: [{ poLineId: po.lines[0]!.id, qty: '1' }] })).status).toBe(400);
    expect((await inv(c, other.token).returnableGrn(`grn=${g.id}`)).body.data).toHaveLength(0);
    // RLS: under the other tenant's context the rows do not exist at all.
    const { sql } = await import('kysely');
    const n = await c.db.connection().execute(async conn => {
      await sql`set role app_user`.execute(conn);
      await sql`select set_config('app.tenant_id', ${other.tenantId}, false)`.execute(conn);
      const r = await sql<{ n: string }>`select count(*)::text as n from app.document_line where id = ${g.lines[0]!.id}`.execute(conn);
      await sql`reset role`.execute(conn);
      await sql`select set_config('app.tenant_id', '', false)`.execute(conn);
      return r.rows[0]!.n;
    });
    expect(n).toBe('0');
  });
});

describe('engine:receipts report source', () => {
  it('lists GRN lines with PO, vendor, quantities and on-time flag', async () => {
    const po = await approvedPo(c, f, ['12']);
    const g = await submittedGrn(c, f, po, [[0, '12']]);
    await mustOk(decideGrn(c, f.token, g.id, 'gate', [[g.lines[0]!.id, '10', '2']], 'Short weight'));
    const def = {
      source: { kind: 'engine', key: 'receipts' },
      columns: [{ field: 'grn_number' }, { field: 'po_number' }, { field: 'vendor.name' }, { field: 'received_qty' }, { field: 'rejected_at_receipt' }, { field: 'on_time' }],
      filters: [{ field: 'grn_number', op: 'eq', value: g.number }],
    };
    const res = await mustOk(api(c, f.token).post('/reports/preview', { definition: def, params: {} }));
    expect(res.rows).toHaveLength(1);
    const [num, poNum, vendor, recv, rar, onTime] = res.rows[0];
    expect(num).toBe(g.number);
    expect(poNum).toBe(po.number);
    expect(vendor).toBe('Vendor A');
    expect(Number(recv)).toBe(12);
    expect(Number(rar)).toBe(2);
    expect(onTime).toBe(true);
  });
});

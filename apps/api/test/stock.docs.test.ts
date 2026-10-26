/**
 * Store documents (Phase 5 contract "Store documents"): stock_transfer / stock_adjustment / stock_count as system
 * types provisioned for `store` tenants, with default workflows whose approval runs `post_stock`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/core/db.service';
import { StockEffects } from '../src/modules/stock';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { docs } from './procurement-helpers';
import { stockWorld, StockWorld } from './stock-helpers';

let c: Ctx;
let w: StockWorld;

const balance = async (item: string, node: string, status = 'available') => {
  const r = await c.db.selectFrom('app.stock_balance').select(['qty', 'value']).where('tenant_id', '=', w.tenantId).where('item_id', '=', item).where('node_id', '=', node)
    .where('stock_status', '=', status as 'available').execute();
  return { qty: r.reduce((t, x) => t + Number(x.qty), 0), value: r.reduce((t, x) => t + Number(x.value), 0) };
};
const decideAll = (type: string, id: string, lines: { id: string; qty: string }[], approve?: Record<string, string>) =>
  docs(c, w.adminToken, type).act(id, {
    action: 'decide', stageKey: 'approve',
    decisions: lines.map(l => {
      const ap = approve?.[l.id] ?? l.qty;
      const rej = (Number(l.qty) - Number(ap)).toString();
      return { lineId: l.id, approve: ap, reject: rej, ...(rej !== '0' ? { reason: 'Partly' } : {}) };
    }),
  });

beforeAll(async () => {
  c = await bootApp();
  w = await stockWorld(c);
  const a = api(c, w.adminToken);
  // The lone admin submits and approves (no-actor fallback assignment): allow self-approval for this tenant (QA3-BUG-004).
  await mustOk(a.put('/config/settings', { 'workflow.block_self_approval': false }));
  await mustOk(a.post('/stock/opening', {
    asOf: '2026-04-01',
    rows: [
      { itemId: w.items[0], nodeId: w.store, qty: '10', unitCost: '7' },
      { itemId: w.items[1], nodeId: w.store, qty: '3', unitCost: '100' },
      { itemId: w.items[2], nodeId: w.store, batchNo: 'B-1', expiryDate: '2027-01-31', qty: '5', unitCost: '2.5' },
    ],
  }));
});
afterAll(async () => closeApp(c));

describe('provisioning', () => {
  it('installs the three store types with published workflows only for tenants with feature store', async () => {
    const keys = async (tid: string) => (await c.db.selectFrom('app.doc_type').select('key').where('tenant_id', '=', tid).execute()).map(r => r.key);
    expect(await keys(w.tenantId)).toEqual(expect.arrayContaining(['stock_transfer', 'stock_adjustment', 'stock_count']));
    const wf = await c.db.selectFrom('app.workflow_def as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select(['t.key', 'd.current_version_id'])
      .where('d.tenant_id', '=', w.tenantId).where('t.key', 'in', ['stock_transfer', 'stock_adjustment', 'stock_count']).execute();
    expect(wf.filter(x => x.current_version_id)).toHaveLength(3);
    const noStore = await stockWorld(c, { features: ['indent', 'purchase'] });
    expect(await keys(noStore.tenantId)).not.toContain('stock_transfer');
  });
});

describe('stock_transfer', () => {
  it('approval posts paired transfer_out / transfer_in at source cost; partial approval moves only the approved qty', async () => {
    const d = docs(c, w.adminToken, 'stock_transfer');
    const draft = await mustOk(d.create({ values: { location: w.store, to_location: w.bin }, lines: [{ values: { item: w.items[0], qty: '4' } }, { values: { item: w.items[2], qty: '2', batch: 'B-1' } }] }), 201);
    const sub = await mustOk(d.submit(draft.id, draft.version));
    const lines = sub.lines.map((l: { id: string; values: { qty: string } }) => ({ id: l.id, qty: l.values.qty }));
    await mustOk(decideAll('stock_transfer', sub.id, lines, { [lines[0].id]: '3' }));
    expect(await balance(w.items[0]!, w.store)).toEqual({ qty: 7, value: 49 });
    expect(await balance(w.items[0]!, w.bin)).toEqual({ qty: 3, value: 21 });
    expect(await balance(w.items[2]!, w.bin)).toEqual({ qty: 2, value: 5 });
    const mv = await c.db.selectFrom('app.stock_movement').select(['movement_type', 'pair_id', 'line_id', 'batch_id', 'document_id']).where('document_id', '=', sub.id).orderBy('id').execute();
    expect(mv.map(m => m.movement_type).sort()).toEqual(['transfer_in', 'transfer_in', 'transfer_out', 'transfer_out']);
    const byLine = new Map<string, string[]>();
    for (const m of mv) byLine.set(m.line_id!, [...(byLine.get(m.line_id!) ?? []), m.pair_id!]);
    for (const pairs of byLine.values()) expect(new Set(pairs).size).toBe(1);
    expect(mv.filter(m => m.batch_id).length).toBe(2);
  });

  it('re-running the effect for the same workflow action posts nothing new (idempotent)', async () => {
    const d = docs(c, w.adminToken, 'stock_transfer');
    const draft = await mustOk(d.create({ values: { location: w.store, to_location: w.bin }, lines: [{ values: { item: w.items[1], qty: '1' } }] }), 201);
    const sub = await mustOk(d.submit(draft.id, draft.version));
    await mustOk(decideAll('stock_transfer', sub.id, [{ id: sub.lines[0].id, qty: '1' }]));
    const action = await c.db.selectFrom('app.wf_action').select('id').where('document_id', '=', sub.id).where('action', '=', 'decide').executeTakeFirstOrThrow();
    const again = await c.app.get(DbService).tenantTx(w.tenantId, tx => c.app.get(StockEffects).run('post_stock', { effect: 'post_stock', stockStatus: 'available' }, {
      tx, tenantId: w.tenantId, documentId: sub.id, stageKey: 'approve', wfActionId: action.id, actorId: w.adminId, approved: [{ lineId: sub.lines[0].id, qty: '1' }], rejected: [],
    }));
    expect(again.every(m => m.duplicate)).toBe(true);
    expect(await balance(w.items[1]!, w.bin)).toEqual({ qty: 1, value: 100 });
  });

  it('submit refuses a transfer to the same location; approval without stock is refused and changes nothing', async () => {
    const d = docs(c, w.adminToken, 'stock_transfer');
    const same = await mustOk(d.create({ values: { location: w.store, to_location: w.store }, lines: [{ values: { item: w.items[0], qty: '1' } }] }), 201);
    const r = await d.submit(same.id, same.version);
    expect(r.status).toBe(400);
    const big = await mustOk(d.create({ values: { location: w.store, to_location: w.otherPlant }, lines: [{ values: { item: w.items[0], qty: '500' } }] }), 201);
    const sub = await mustOk(d.submit(big.id, big.version));
    const res = await decideAll('stock_transfer', sub.id, [{ id: sub.lines[0].id, qty: '500' }]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STOCK_NEGATIVE');
    expect((await mustOk(d.get(sub.id))).statusKey).toBe('waiting_approve');
  });
});

describe('stock_adjustment', () => {
  it('posts adjustment_in at the line rate (or average) and adjustment_out at the average', async () => {
    const d = docs(c, w.adminToken, 'stock_adjustment');
    const draft = await mustOk(d.create({
      values: { location: w.store },
      lines: [
        { values: { item: w.items[1], qty: '2', direction: 'in', rate: '130', reason: 'Found in yard' } },
        { values: { item: w.items[1], qty: '1', direction: 'out', reason: 'Damaged' } },
        { values: { item: w.items[2], qty: '1', direction: 'in', batch: 'B-2', reason: 'Sample received' } },
      ],
    }), 201);
    const sub = await mustOk(d.submit(draft.id, draft.version));
    await mustOk(decideAll('stock_adjustment', sub.id, sub.lines.map((l: { id: string; values: { qty: string } }) => ({ id: l.id, qty: l.values.qty }))));
    // item1 at store: 3 - 1 (transfer) = 2 @100 → +2 @130 → 4 @ 115 → -1 → 3 @ 345
    expect(await balance(w.items[1]!, w.store)).toEqual({ qty: 3, value: 345 });
    const b2 = await c.db.selectFrom('app.stock_batch').select('id').where('tenant_id', '=', w.tenantId).where('batch_no', '=', 'B-2').executeTakeFirst();
    expect(b2).toBeTruthy();
    const mv = await c.db.selectFrom('app.stock_movement').select(['movement_type', 'reason']).where('document_id', '=', sub.id).orderBy('id').execute();
    expect(mv.map(m => m.movement_type).sort()).toEqual(['adjustment_in', 'adjustment_in', 'adjustment_out']);
    expect(mv.map(m => m.reason)).toContain('Damaged');
  });
});

describe('stock_count', () => {
  it('snapshot freezes book qty; approval posts count_in / count_out for the differences', async () => {
    const a = api(c, w.adminToken);
    const draft = await mustOk(a.post('/stock/counts/snapshot', { nodeId: w.store, includeChildren: false }), 201);
    expect(draft.docTypeKey ?? 'stock_count').toBe('stock_count');
    const byItem = new Map(draft.lines.map((l: { values: Record<string, unknown> }) => [`${l.values.item}|${l.values.batch ?? ''}`, l]));
    const steel = byItem.get(`${w.items[0]}|`) as { id: string; values: Record<string, unknown> };
    const cement = byItem.get(`${w.items[1]}|`) as { id: string; values: Record<string, unknown> };
    const paint = byItem.get(`${w.items[2]}|B-1`) as { id: string; values: Record<string, unknown> };
    expect([steel.values.book_qty, cement.values.book_qty, paint.values.book_qty].map(Number)).toEqual([7, 3, 3]);
    // Counters enter counted qty; a forged book qty is recomputed from the ledger on save.
    const d = docs(c, w.adminToken, 'stock_count');
    const upd = await mustOk(a.put(`/docs/stock_count/${draft.id}`, {
      version: draft.version, values: { location: w.store },
      lines: draft.lines.map((l: { id: string; values: Record<string, unknown> }) => ({
        id: l.id, values: { ...l.values, counted_qty: l.id === steel.id ? '6.5' : l.id === cement.id ? '4' : String(l.values.book_qty), ...(l.id === steel.id ? { book_qty: '6.5' } : {}) },
      })),
    }));
    const steelLine = await c.db.selectFrom('app.document_line').select('custom').where('id', '=', steel.id).executeTakeFirstOrThrow();
    expect((steelLine.custom as Record<string, unknown>).book_qty).toBe('7');
    const sub = await mustOk(d.submit(draft.id, upd.version));
    await mustOk(decideAll('stock_count', sub.id, sub.lines.map((l: { id: string; values: { qty: string } }) => ({ id: l.id, qty: l.values.qty }))));
    const mv = await c.db.selectFrom('app.stock_movement').select(['item_id', 'movement_type', 'qty_in', 'qty_out']).where('document_id', '=', sub.id).orderBy('id').execute();
    expect(mv.map(m => [m.item_id, m.movement_type, Number(m.qty_in), Number(m.qty_out)]).sort()).toEqual([
      [w.items[0], 'count_out', 0, 0.5], [w.items[1], 'count_in', 1, 0],
    ].sort());
    expect((await balance(w.items[0]!, w.store)).qty).toBe(6.5);
  });

  it('submit requires a counted qty on every line', async () => {
    const a = api(c, w.adminToken);
    const draft = await mustOk(a.post('/stock/counts/snapshot', { nodeId: w.store, itemIds: [w.items[0]] }), 201);
    expect(draft.lines).toHaveLength(1);
    const r = await docs(c, w.adminToken, 'stock_count').submit(draft.id, draft.version);
    expect(r.status).toBe(400);
    expect(r.body.errors[0].path).toBe('lines.0.counted_qty');
  });
});

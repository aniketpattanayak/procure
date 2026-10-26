import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { poFollowupSource } from '../src/modules/procurement';
import { mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { scoped } from './procurement-helpers';
import { approvedSelection, approvePo, poApi, poTenant, PoFixture, PO_BUYER_KEYS } from './procurement-po-helpers';

let c: Ctx;
let f: PoFixture;
beforeAll(async () => {
  c = await bootApp();
  f = await poTenant(c);
});
afterAll(async () => closeApp(c));

async function approvedPo(qtys = ['10', '20']) {
  const { selection } = await approvedSelection(c, f, qtys, qtys.map((q, i) => [i, 0, q, '10'] as [number, number, string, string]));
  const p = poApi(c, f.po.token);
  const [po] = await mustOk(p.fromLines({ picks: selection.lines.map((l: { id: string; values: { qty: string } }) => ({ sourceLineId: l.id, qty: String(Number(l.values.qty)) })) }), 201);
  const lines = po.lines.map((l: { id: string; values: Record<string, unknown> }, i: number) => ({ id: l.id, values: { ...l.values, schedule: [{ date: `2026-11-0${i + 1}`, qty: qtys[i] }] } }));
  const ed = await mustOk(p.update(po.id, { version: po.version, values: {}, lines }));
  const sub = await mustOk(p.submit(ed.id, ed.version));
  return approvePo(c, f, sub);
}

describe('PO follow-ups', () => {
  it('logs follow-ups append-only; a revised expected date updates the PO and keeps the history', async () => {
    const po = await approvedPo();
    expect(po.values.expected_date).toBe('2026-11-01');
    const p = poApi(c, f.po.token);
    const noReason = await p.followup(po.id, { revisedExpectedDate: '2026-11-15' });
    expect(noReason.status).toBe(400);
    const first = await mustOk(p.followup(po.id, { contactMode: 'call', contactPerson: 'Mr. Patil', promisedDate: '2026-11-14', notes: 'Material in transit' }), 201);
    expect(first).toMatchObject({ contactMode: 'call', contactPerson: 'Mr. Patil', promisedDate: '2026-11-14', revisedExpectedDate: null, lineId: null, createdBy: { id: f.po.userId } });
    const second = await mustOk(p.followup(po.id, { contactMode: 'email', revisedExpectedDate: '2026-11-20', reason: 'Furnace breakdown at vendor' }), 201);
    expect(second).toMatchObject({ revisedExpectedDate: '2026-11-20', previousExpectedDate: '2026-11-01', reason: 'Furnace breakdown at vendor' });
    let doc = await mustOk(p.get(po.id));
    expect(doc.values.expected_date).toBe('2026-11-20');
    const third = await mustOk(p.followup(po.id, { contactMode: 'whatsapp', revisedExpectedDate: '2026-11-25', reason: 'Transporter delay' }), 201);
    expect(third.previousExpectedDate).toBe('2026-11-20');
    // line-level revision
    const lineFu = await mustOk(p.followup(po.id, { lineId: po.lines[1].id, contactMode: 'visit', revisedExpectedDate: '2026-12-05', reason: 'Second lot later' }), 201);
    expect(lineFu).toMatchObject({ lineId: po.lines[1].id, lineNo: 2, previousExpectedDate: '2026-11-02' });
    doc = await mustOk(p.get(po.id));
    expect(doc.values.expected_date).toBe('2026-11-25');
    expect(doc.lines[1].values.expected_date).toBe('2026-12-05');
    expect(doc.lines[0].values.expected_date).toBe('2026-11-01');
    const list = await mustOk(p.followups(po.id));
    expect(list.map((r: { revisedExpectedDate: string | null; previousExpectedDate: string | null }) => [r.previousExpectedDate, r.revisedExpectedDate])).toEqual([
      ['2026-11-02', '2026-12-05'], ['2026-11-20', '2026-11-25'], ['2026-11-01', '2026-11-20'], [null, null],
    ]);
    const ev = await c.db.selectFrom('app.outbox_event').select('payload').where('event_type', '=', 'po.followup_logged').where('aggregate_id', '=', po.id).execute();
    expect(ev).toHaveLength(4);
    // append-only: there is no edit / delete route
    expect((await p.raw.put(`/docs/po/${po.id}/followups/${first.id}`, {})).status).toBe(404);
    expect((await p.raw.del(`/docs/po/${po.id}/followups/${first.id}`)).status).toBe(404);
  });

  it('needs the followup key, a submitted PO and a line of this PO', async () => {
    const po = await approvedPo(['5']);
    const viewer = await scoped(c, f.token, f.code, PO_BUYER_KEYS.filter(k => k !== 'doc.po:action.followup'));
    expect((await poApi(c, viewer.token).followup(po.id, { contactMode: 'call' })).status).toBe(403);
    expect((await mustOk(poApi(c, viewer.token).followups(po.id)))).toHaveLength(0);
    const other = await approvedPo(['6']);
    expect((await poApi(c, f.po.token).followup(po.id, { lineId: other.lines[0].id })).status).toBe(404);
    const { selection } = await approvedSelection(c, f, ['1'], [[0, 0, '1', '1']]);
    const [draft] = await mustOk(poApi(c, f.po.token).fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '1' }] }), 201);
    expect((await poApi(c, f.po.token).followup(draft.id, { contactMode: 'call' })).status).toBe(409);
  });

  it('exports a report engine source descriptor for po_followup', async () => {
    const src = poFollowupSource();
    expect(src).toMatchObject({ key: 'po_followup', viewKey: 'doc.po:action.view', requiresFeature: 'purchase' });
    const { DbService } = await import('../src/core/db.service');
    const built = await c.app.get(DbService).tenantTx(f.tenantId, tx => src.build({ tx, tenantId: f.tenantId }));
    expect(built.fields.map(x => x.id)).toEqual(expect.arrayContaining(['created_at', 'po_number', 'vendor', 'revised_expected_date', 'contact_mode']));
    // the descriptor's SQL runs
    const { sql } = await import('kysely');
    const rows = await c.app.get(DbService).tenantTx(f.tenantId, tx => sql`select ${sql.join(built.fields.map(x => x.expr))} from ${built.from} where ${sql.join(built.where, sql` and `)}`.execute(tx));
    expect(rows.rows.length).toBeGreaterThan(0);
  });
});

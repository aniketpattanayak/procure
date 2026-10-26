/**
 * Fixtures for the Phase 4 PO suites owned by Procurement agent B (procurement.po*, procurement.tax*,
 * procurement.followup*, procurement.amend*). Builds on agent A's procurement-helpers (tenant with indent +
 * vendor_quotes + purchase, locations, items, vendors in states 27 / 33 / 29, indenter, buyer).
 */
import { sql } from 'kysely';
import { expect } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { Ctx } from './helpers';
import { approvedIndent, ALL_VIEWS, BUYER_KEYS, docs, proc, procTenant, ProcFixture, scoped } from './procurement-helpers';

const poActions = (list: string[]) => list.map(a => `doc.po:action.${a}`);
export const PO_VIEWS = [...ALL_VIEWS, 'waiting_approve', 'amending'].map(v => `doc.po:view.${v}`);
export const PO_BUYER_KEYS = [
  ...BUYER_KEYS, ...poActions(['view', 'add', 'edit', 'delete', 'submit', 'cancel', 'close', 'copy', 'comment', 'followup', 'amend', 'short_close']), ...PO_VIEWS,
];

export interface PoFixture extends ProcFixture {
  po: { token: string; userId: string; roleId: string };
  taxCodes: Record<string, string>;
}

/** acme-like tenant: Pune Plant state 27; items taxed GST18 / GST12 / GST5; a PO buyer (all locations). */
export async function poTenant(c: Ctx): Promise<PoFixture> {
  const f = await procTenant(c);
  const a = api(c, f.token);
  const pune = await mustOk(a.get(`/locations/${f.pune}`));
  await mustOk(a.put(`/locations/${f.pune}`, { custom: { state_code: '27' }, version: pune.version }));
  const codes = await mustOk(a.get('/masters/tax_code/records?limit=50'));
  const taxCodes = Object.fromEntries((codes.data as { code: string; id: string }[]).map(r => [r.code, r.id]));
  const map = ['GST18', 'GST12', 'GST5'];
  for (const [i, item] of f.items.entries()) {
    await sql`update app.master_record set data = jsonb_set(data, '{tax_code}', to_jsonb(${taxCodes[map[i]!]}::text)) where id = ${item}`.execute(c.db);
  }
  const po = await scoped(c, f.token, f.code, PO_BUYER_KEYS);
  return { ...f, po, taxCodes };
}

export const poApi = (c: Ctx, token: string) => {
  const a = api(c, token);
  const d = docs(c, token, 'po');
  return {
    ...d,
    update: (id: string, body: unknown) => a.put(`/docs/po/${id}`, body),
    orderable: (qs = '') => a.get(`/procurement/orderable-lines${qs ? `?${qs}` : ''}`),
    fromLines: (body: unknown) => a.post('/procurement/po/from-lines', body),
    taxes: (id: string) => a.get(`/docs/po/${id}/taxes`),
    followups: (id: string) => a.get(`/docs/po/${id}/followups`),
    followup: (id: string, body: unknown) => a.post(`/docs/po/${id}/followups`, body),
    amend: (id: string, reason = 'Price revision agreed with vendor') => a.post(`/docs/po/${id}/amend`, { reason }),
    withdraw: (id: string) => a.del(`/docs/po/${id}/amend`),
    revisions: (id: string) => a.get(`/docs/po/${id}/revisions`),
    shortClose: (id: string, body: unknown) => a.post(`/docs/po/${id}/short-close`, body),
    cancel: (id: string, body: unknown) => a.post(`/docs/po/${id}/cancel`, body),
    raw: a,
  };
};

/** Approved indent → submitted selection (lines: [indentLineIndex, vendorIndex, qty, rate]) → selection approved by the admin. */
export async function approvedSelection(c: Ctx, f: PoFixture, qtys: string[], picks: [number, number, string, string][], opts: { location?: string } = {}) {
  const ind = await approvedIndent(c, f, qtys, opts);
  const sel = await mustOk(proc(c, f.buyer.token).select({
    submit: true, lines: picks.map(([li, vi, qty, rate]) => ({ indentLineId: ind.lines[li].id, vendorId: f.vendors[vi], qty, rate })),
  }), 201);
  const done = await mustOk(docs(c, f.token, 'vendor_selection').act(sel.id, {
    action: 'decide', stageKey: 'approve', decisions: sel.lines.map((l: { id: string; values: { qty: string } }) => ({ lineId: l.id, approve: String(Number(l.values.qty)) })),
  }));
  expect(done.statusKey).toBe('approved');
  return { indent: ind, selection: done };
}

/** Admin decision at the PO `approve` stage. */
export async function decidePo(c: Ctx, f: PoFixture, id: string, decisions: { lineId: string; approve?: string; reject?: string; reason?: string }[]) {
  return poApi(c, f.token).act(id, { action: 'decide', stageKey: 'approve', decisions });
}

/** Approves every pending line of a PO in full. */
export async function approvePo(c: Ctx, f: PoFixture, po: { id: string; lines: { id: string; qty: { pendingApproval: string } }[] }) {
  const cur = await mustOk(poApi(c, f.token).get(po.id));
  return mustOk(decidePo(c, f, po.id, cur.lines.filter((l: { qty: { pendingApproval: string } }) => Number(l.qty.pendingApproval) > 0)
    .map((l: { id: string; qty: { pendingApproval: string } }) => ({ lineId: l.id, approve: l.qty.pendingApproval }))));
}

/** Summary buckets of a line (numbers). */
export async function qtyOf(c: Ctx, lineId: string) {
  const r = await c.db.selectFrom('app.line_qty_summary').selectAll().where('line_id', '=', lineId).executeTakeFirst();
  const n = (v: unknown) => Number(v ?? 0);
  return {
    requested: n(r?.requested), approved: n(r?.approved), rejected: n(r?.rejected), cancelled: n(r?.cancelled), selected: n(r?.selected),
    ordered: n(r?.ordered), shortClosed: n(r?.short_closed), received: n(r?.received),
  };
}

export async function setSettings(c: Ctx, token: string, values: Record<string, unknown>) {
  return mustOk(api(c, token).put('/config/settings', values));
}

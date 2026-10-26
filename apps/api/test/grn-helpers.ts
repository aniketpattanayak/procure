/**
 * Fixtures for the Phase 5 GRN / issue suites (grn*.test.ts, issue*.test.ts): a procurement tenant with `grn` +
 * `store`, an approved PO (through indent → selection → PO and the real workflow), a storekeeper who raises GRNs, and
 * shortcuts for the default GRN chain (gate → store → quality → disposition).
 */
import { sql } from 'kysely';
import { expect } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { Ctx } from './helpers';
import { docs, PROC_FEATURES, procTenant, ProcFixture, scoped } from './procurement-helpers';
import { approvedSelection, approvePo, PO_BUYER_KEYS, poApi, PoFixture } from './procurement-po-helpers';

export const GRN_FEATURES = [...PROC_FEATURES, 'grn', 'store', 'reports', 'report_builder', 'pdf_templates'];
const VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'];
const keys = (type: string, actions: string[], views: string[]) => [...actions.map(a => `doc.${type}:action.${a}`), ...views.map(v => `doc.${type}:view.${v}`)];

export const GRN_STAGES = ['waiting_gate', 'waiting_store', 'waiting_quality', 'waiting_disposition'];
export const STOREKEEPER_KEYS = [
  ...keys('grn', ['view', 'add', 'edit', 'delete', 'submit', 'cancel'], [...VIEWS, ...GRN_STAGES]),
  ...keys('rtv', ['view', 'add', 'edit', 'submit', 'cancel'], [...VIEWS, 'waiting_approve']),
  ...keys('po', ['view'], [...VIEWS, 'waiting_approve', 'partially_received', 'received']),
];
export const ISSUER_KEYS = [
  ...keys('issue_request', ['view'], [...VIEWS, 'waiting_approve']),
  ...keys('store_issue', ['view', 'add', 'edit', 'submit', 'cancel'], [...VIEWS, 'waiting_approve']),
  ...keys('store_return', ['view', 'add', 'edit', 'submit', 'cancel'], [...VIEWS, 'waiting_approve']),
];
export const REQUESTER_KEYS = keys('issue_request', ['view', 'add', 'edit', 'submit', 'cancel'], [...VIEWS, 'waiting_approve']);

export interface GrnFixture extends PoFixture {
  storekeeper: { token: string; userId: string; roleId: string };
}

/** acme-like tenant with grn + store: Pune Plant state 27, items with tax codes, buyer, storekeeper (all locations). */
export async function grnTenant(c: Ctx, features = GRN_FEATURES): Promise<GrnFixture> {
  const f: ProcFixture = await procTenant(c, features);
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
  // Without `store` the GRN chain has no disposition stage (stock-less default workflow).
  const storekeeper = await scoped(c, f.token, f.code, features.includes('store') ? STOREKEEPER_KEYS : STOREKEEPER_KEYS.filter(k => k !== 'doc.grn:view.waiting_disposition'));
  return { ...f, po, taxCodes, storekeeper };
}

/** Approved PO for vendor 0 at Pune: one line per qty (items cycling), rate 50. */
export async function approvedPo(c: Ctx, f: GrnFixture, qtys: string[], rate = '50') {
  const { selection } = await approvedSelection(c, f, qtys, qtys.map((qty, i) => [i, 0, qty, rate] as [number, number, string, string]));
  const created = await mustOk(poApi(c, f.po.token).fromLines({ picks: selection.lines.map((l: { id: string; values: { qty: string } }) => ({ sourceLineId: l.id, qty: String(Number(l.values.qty)) })) }), 201);
  const draft = created[0];
  const sub = await mustOk(poApi(c, f.po.token).submit(draft.id, draft.version));
  const done = await approvePo(c, f, sub);
  expect(done.statusKey).toBe('approved');
  return done as { id: string; number: string; lines: { id: string; values: Record<string, unknown> }[]; statusKey: string };
}

export const inv = (c: Ctx, token: string) => {
  const a = api(c, token);
  return {
    receivable: (qs = '') => a.get(`/inventory/receivable-po-lines${qs ? `?${qs}` : ''}`),
    fromPo: (body: unknown) => a.post('/inventory/grn/from-po', body),
    returnableGrn: (qs = '') => a.get(`/inventory/returnable-grn-lines${qs ? `?${qs}` : ''}`),
    rtvFromGrn: (body: unknown) => a.post('/inventory/rtv/from-grn', body),
    issuable: (qs = '') => a.get(`/inventory/issuable-lines${qs ? `?${qs}` : ''}`),
    issueFromRequests: (body: unknown) => a.post('/inventory/issues/from-requests', body),
    returnable: (qs = '') => a.get(`/inventory/returnable-lines${qs ? `?${qs}` : ''}`),
    returnFromIssues: (body: unknown) => a.post('/inventory/returns/from-issues', body),
    settings: (values: Record<string, unknown>) => a.put('/config/settings', values),
    raw: a,
  };
};

/** Submitted GRN against PO lines: [[poLineIndex, qty, extra?]]. */
export async function submittedGrn(c: Ctx, f: GrnFixture, po: { lines: { id: string }[] }, picks: [number, string, Record<string, unknown>?][], token = f.storekeeper.token) {
  const out = await mustOk(inv(c, token).fromPo({ submit: true, lines: picks.map(([i, qty, extra]) => ({ poLineId: po.lines[i]!.id, qty, ...(extra ?? {}) })) }), 201);
  return out[0] as { id: string; number: string; statusKey: string; version: number; lines: { id: string; values: Record<string, unknown>; qty: Record<string, string> }[] };
}

/** Decision at a GRN stage (admin by default). decisions: [lineId, approve, reject?, hold?]. */
export async function decideGrn(c: Ctx, token: string, grnId: string, stageKey: string, decisions: [string, string, string?, string?][], reason = 'Checked') {
  return docs(c, token, 'grn').act(grnId, {
    action: 'decide', stageKey,
    decisions: decisions.map(([lineId, approve, reject, hold]) => ({ lineId, approve, reject: reject ?? '0', hold: hold ?? '0', ...((reject && reject !== '0') || (hold && hold !== '0') ? { reason } : {}) })),
  });
}

/** Line buckets (numbers). */
export async function lineQty(c: Ctx, lineId: string) {
  const r = await c.db.selectFrom('app.line_qty_summary').selectAll().where('line_id', '=', lineId).executeTakeFirst();
  const n = (v: unknown) => Number(v ?? 0);
  return {
    requested: n(r?.requested), approved: n(r?.approved), rejected: n(r?.rejected), cancelled: n(r?.cancelled), ordered: n(r?.ordered), received: n(r?.received),
    accepted: n(r?.accepted), rejectedAtReceipt: n(r?.rejected_at_receipt), issued: n(r?.issued), returned: n(r?.returned), shortClosed: n(r?.short_closed),
  };
}

/** Stock balance of item × node by status (numbers). */
export async function stockAt(c: Ctx, itemId: string, nodeId: string) {
  const rows = await c.db.selectFrom('app.stock_balance').select(['stock_status', 'qty']).where('item_id', '=', itemId).where('node_id', '=', nodeId).execute();
  const out = { available: 0, quarantine: 0, rejected: 0 };
  for (const r of rows) out[r.stock_status as keyof typeof out] += Number(r.qty);
  return out;
}

export async function docStatus(c: Ctx, id: string) {
  return (await c.db.selectFrom('app.document').select('status_key').where('id', '=', id).executeTakeFirstOrThrow()).status_key;
}

/** Marks items as needing QC (data field on the item master record). */
export async function requireQc(c: Ctx, itemIds: string[]) {
  for (const id of itemIds) await sql`update app.master_record set data = data || '{"requires_qc": true}'::jsonb where id = ${id}`.execute(c.db);
}

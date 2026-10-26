/**
 * Fixtures for the Phase 4 procurement suites owned by Procurement agent A (procurement.indent*, procurement.quotes*,
 * procurement.selection*): a tenant on a plan with indent + vendor_quotes + purchase (system types provisioned on
 * tenant creation), locations, unit, items, vendors, a department, an indenter, a buyer, and shortcuts to raise
 * and approve indents through the real documents + workflow APIs.
 */
import { api, mustOk, userWithKeys } from './forms-helpers';
import { Ctx, superAdmin, tenantWithAdmin, uid } from './helpers';

export const PROC_FEATURES = ['indent', 'purchase', 'vendor_quotes', 'form_builder', 'workflow_designer'];

const views = (type: string, list: string[]) => list.map(v => `doc.${type}:view.${v}`);
const actions = (type: string, list: string[]) => list.map(a => `doc.${type}:action.${a}`);
export const ALL_VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'];

export const INDENTER_KEYS = [...actions('indent', ['view', 'add', 'edit', 'submit', 'cancel']), ...views('indent', [...ALL_VIEWS, 'waiting_verify'])];
export const BUYER_KEYS = [
  ...actions('indent', ['view', 'log_quote', 'compare', 'short_close']), ...views('indent', [...ALL_VIEWS, 'waiting_verify']),
  ...actions('vendor_selection', ['view', 'add', 'edit', 'submit', 'cancel']), ...views('vendor_selection', [...ALL_VIEWS, 'waiting_approve']),
];

export interface ProcFixture {
  tenantId: string; code: string; token: string; adminId: string;
  pune: string; puneStore: string; chennai: string; kg: string; items: string[]; vendors: string[]; department: string;
  indenter: { token: string; userId: string; roleId: string };
  buyer: { token: string; userId: string; roleId: string };
}

export async function procTenant(c: Ctx, features = PROC_FEATURES): Promise<ProcFixture> {
  const sa = await superAdmin(c);
  const { tenant, admin } = await tenantWithAdmin(c, sa.token, { features, limits: { max_users: 100, custom_forms: 20, max_locations: 20, storage_gb: 1 } });
  const a = api(c, admin.token);
  const pune = await mustOk(a.post('/locations', { code: `PUN-${uid(4)}`, name: 'Pune Plant' }), 201);
  const puneStore = await mustOk(a.post('/locations', { parentId: pune.id, code: `PST-${uid(4)}`, name: 'Pune Store' }), 201);
  const chennai = await mustOk(a.post('/locations', { code: `CHE-${uid(4)}`, name: 'Chennai Plant' }), 201);
  const kg = await mustOk(a.post('/masters/uom/records', { code: `KG${uid(3)}`, name: 'Kilogram', data: { decimals: 3 } }), 201);
  const items = [];
  for (const n of ['Steel rod', 'Copper wire', 'Paint']) items.push((await mustOk(a.post('/masters/item/records', { name: n, data: { uom: kg.id } }), 201)).id as string);
  const vendors = [];
  for (const [n, st] of [['Vendor A', '27'], ['Vendor B', '33'], ['Vendor C', '29']]) {
    vendors.push((await mustOk(a.post('/masters/vendor/records', { name: n, data: { state_code: st } }), 201)).id as string);
  }
  const dep = await mustOk(a.post('/masters/department/records', { code: `D${uid(3)}`, name: 'Maintenance', data: {} }), 201);
  const indenter = await scoped(c, admin.token, tenant.code, INDENTER_KEYS);
  const buyer = await scoped(c, admin.token, tenant.code, BUYER_KEYS);
  return {
    tenantId: tenant.tenantId, code: tenant.code, token: admin.token, adminId: admin.userId, pune: pune.id, puneStore: puneStore.id, chennai: chennai.id,
    kg: kg.id, items, vendors, department: dep.id, indenter, buyer,
  };
}

/** User with `keys`, scope = all locations (or one node + below). */
export async function scoped(c: Ctx, adminToken: string, code: string, keys: string[], nodeId?: string) {
  const u = await userWithKeys(c, adminToken, code, keys);
  await mustOk(api(c, adminToken).put(`/roles/${u.roleId}/scope`, { entries: [nodeId ? { nodeId } : { allNodes: true }] }));
  return u;
}

export const docs = (c: Ctx, token: string, type: string) => {
  const a = api(c, token);
  return {
    create: (body: unknown) => a.post(`/docs/${type}`, body),
    get: (id: string) => a.get(`/docs/${type}/${id}`),
    submit: (id: string, version: number) => a.post(`/docs/${type}/${id}/submit`, { version }),
    act: (id: string, body: unknown) => a.post(`/docs/${type}/${id}/actions`, body),
    list: (qs = '') => a.get(`/docs/${type}${qs ? `?${qs}` : ''}`),
  };
};

/** Raises + submits an indent as the indenter (qtys per line, items cycling). */
export async function submittedIndent(c: Ctx, f: ProcFixture, qtys: string[], opts: { location?: string; items?: string[] } = {}) {
  const d = docs(c, f.indenter.token, 'indent');
  const doc = await mustOk(d.create({
    values: { location: opts.location ?? f.pune, department: f.department, purpose: 'Maintenance spares', priority: 'Normal' },
    lines: qtys.map((q, i) => ({ values: { item: (opts.items ?? f.items)[i % (opts.items ?? f.items).length], qty: q, remarks: `line ${i + 1}` } })),
  }), 201);
  return mustOk(d.submit(doc.id, doc.version));
}

/** Indent approved at the `verify` stage by the admin (approve = given qty per line, default all). */
export async function approvedIndent(c: Ctx, f: ProcFixture, qtys: string[], opts: { location?: string; items?: string[]; approve?: string[] } = {}) {
  const sub = await submittedIndent(c, f, qtys, opts);
  const decisions = sub.lines.map((l: { id: string }, i: number) => {
    const ap = opts.approve?.[i] ?? qtys[i]!;
    const rej = (Number(qtys[i]) - Number(ap)).toString();
    return { lineId: l.id, approve: ap, reject: rej, ...(rej !== '0' ? { reason: 'Reduced' } : {}) };
  });
  return mustOk(docs(c, f.token, 'indent').act(sub.id, { action: 'decide', stageKey: 'verify', decisions }));
}

export function quote(vendorId: string, over: Record<string, unknown> = {}) {
  return { vendorId, quotedRate: '50', taxPct: '18', freight: '0', leadTimeDays: 7, ...over };
}

export const proc = (c: Ctx, token: string) => {
  const a = api(c, token);
  return {
    logQuote: (lineId: string, body: unknown) => a.post(`/procurement/indent-lines/${lineId}/quotes`, body),
    quotes: (lineId: string, all = false) => a.get(`/procurement/indent-lines/${lineId}/quotes${all ? '?all=true' : ''}`),
    revise: (quoteId: string, body: unknown) => a.put(`/procurement/quotes/${quoteId}`, body),
    compareLine: (lineId: string, qty?: string) => a.get(`/procurement/indent-lines/${lineId}/comparison${qty ? `?qty=${qty}` : ''}`),
    compareItem: (itemId: string, location?: string) => a.get(`/procurement/items/${itemId}/comparison${location ? `?location=${location}` : ''}`),
    selectable: (qs = '') => a.get(`/procurement/selectable-lines${qs ? `?${qs}` : ''}`),
    select: (body: unknown) => a.post('/procurement/selections', body),
    shortClose: (id: string, body: unknown) => a.post(`/docs/indent/${id}/short-close`, body),
    setSettings: (values: Record<string, unknown>) => a.put('/config/settings', values),
    raw: a,
  };
};

/** Summary buckets of a line straight from the DB. */
export async function buckets(c: Ctx, lineId: string) {
  const r = await c.db.selectFrom('app.line_qty_summary').selectAll().where('line_id', '=', lineId).executeTakeFirst();
  const n = (v: unknown) => Number(v ?? 0);
  return { approved: n(r?.approved), selected: n(r?.selected), overApproved: n(r?.over_approved), shortClosed: n(r?.short_closed), requested: n(r?.requested) };
}

/**
 * Tenancy-isolation seed for agent A's procurement table (vendor_quote) + by-id routes: a draft indent (its line is
 * the quote's indent line) and a vendor via the API; the quote row as the DB owner (the isolation plan has no
 * vendor_quotes feature and no approver, so the log-quote API is not reachable there).
 */
export async function seedProcurementIsolationA(c: Ctx, s: { tenantId: string; adminId: string; adminToken: string; locationId: string; itemId: string }) {
  const a = api(c, s.adminToken);
  const indent = await mustOk(a.post('/docs/indent', { values: { location: s.locationId }, lines: [{ values: { item: s.itemId, qty: '5' } }] }), 201);
  const vendor = await mustOk(a.post('/masters/vendor/records', { name: `Iso vendor ${uid(4)}`, data: {} }), 201);
  const q = await c.db.insertInto('app.vendor_quote').values({
    tenant_id: s.tenantId, indent_line_id: indent.lines[0].id, item_id: s.itemId, vendor_id: vendor.id, quoted_rate: '10', slabs: '[]', custom: '{}', file_ids: [], created_by: s.adminId,
  }).returning('id').executeTakeFirstOrThrow();
  return { indentId: indent.id as string, indentLineId: indent.lines[0].id as string, vendorId: vendor.id as string, quoteId: q.id };
}

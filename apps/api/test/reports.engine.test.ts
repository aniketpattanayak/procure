/**
 * Report engine integration: catalogue, compiler (every operator, grouping/aggregates/totals, presets, pagination),
 * security (unknown fields, injection, params), data scope, field access, view permissions, cross-tenant isolation,
 * report CRUD and the built-in reports.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/core/entitlements.service';
import { addDays, fyStartYear, localDate, presetRange } from '../src/modules/reports/presets';
import { mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import { bulkCapex, capexDoc, capexViewKeys, reportKeys, reportsApi, reportsTenant, ReportsFixture, reportUser } from './reports-helpers';
import { publishWorkflow } from './workflow-helpers';

type Def = Record<string, unknown>;
const capex = (o: Def = {}): Def => ({ source: { kind: 'doc', key: 'capex' }, columns: [{ field: 'number' }], ...o });

describe('reports engine', () => {
  let c: Ctx;
  let f: ReportsFixture;
  let r: ReturnType<typeof reportsApi>;
  const today = localDate(new Date(), 'Asia/Kolkata');
  const fyStart = `${fyStartYear(today, 4)}-04-01`;
  const docs: Record<string, { id: string; number: string | null }> = {};

  const rows = async (def: Def, params: Record<string, unknown> = {}, token?: string) => {
    const res = await (token ? reportsApi(c, token) : r).preview(def, params);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body as { columns: { field: string; label: string; type: string; aggregate: string }[]; rows: unknown[][]; totals: unknown[] | null; groups?: unknown[]; chart?: { x: unknown[]; series: { name: string; values: number[] }[] }; nextCursor: string | null; truncated: boolean; links?: string[] };
  };
  const numbers = async (def: Def, params: Record<string, unknown> = {}, token?: string) => (await rows(capex({ sort: [{ field: 'number' }], ...def }), params, token)).rows.map(x => x[0]).sort();

  beforeAll(async () => {
    c = await bootApp();
    f = await reportsTenant(c);
    r = reportsApi(c, f.token);
    // d1 Pune main (approved, today), d2 Chennai (approved, Urgent, in FY), d3 Pune (draft, FY start), d4 Chennai (draft, previous FY)
    const d1 = await capexDoc(c, f, { location: f.puneMain, submit: true, date: today, budget: '1000', lines: [{ qty: '2', est_rate: '50000' }, { qty: '1', est_rate: '20000' }] });
    const d2 = await capexDoc(c, f, { location: f.chennai, submit: true, date: addDays(fyStart, 10), priority: 'Urgent', lines: [{ qty: '1', est_rate: '5000' }] });
    const d3 = await capexDoc(c, f, { location: f.pune, date: fyStart, lines: [{ qty: '1', est_rate: '1000', item: f.items[1] }] });
    const d4 = await capexDoc(c, f, { location: f.chennai, date: addDays(fyStart, -1), lines: [{ qty: '3', est_rate: '100' }] });
    Object.assign(docs, { d1, d2, d3, d4 });
  });
  afterAll(async () => closeApp(c));

  describe('catalogue', () => {
    it('lists doc, item-wise, master and engine sources with typed fields', async () => {
      const list = await mustOk(r.get('/reports/sources'));
      const byKey = new Map(list.map((s: { source: { kind: string; key: string } }) => [`${s.source.kind}:${s.source.key}`, s]));
      for (const k of ['doc:capex', 'doc_line:capex', 'master:item', 'master:item_category', 'engine:documents', 'engine:audit', 'engine:users', 'engine:workflow_pending']) expect(byKey.has(k), k).toBe(true);
      const ids = (k: string) => (byKey.get(k) as { fields: { id: string }[] }).fields.map(x => x.id);
      expect(ids('doc:capex')).toEqual(expect.arrayContaining(['number', 'status', 'doc_date', 'doc_date.month', 'location.name', 'location.path', 'custom.priority', 'custom.budget', 'total_amount', 'wf.stage', 'overdue']));
      expect(ids('doc_line:capex')).toEqual(expect.arrayContaining(['item.code', 'item.name', 'item.category.name', 'item.uom.name', 'qty.requested', 'qty.pending_approval', 'qty.pending_order', 'line.custom.est_rate', 'uom.code']));
      expect(ids('master:item')).toEqual(expect.arrayContaining(['code', 'name', 'active', 'data.category.name', 'data.uom.code']));
      const amount = (byKey.get('doc:capex') as { fields: { id: string; type: string; aggregatable: boolean; groupable: boolean }[] }).fields.find(x => x.id === 'total_amount')!;
      expect(amount).toMatchObject({ type: 'currency', aggregatable: true });
    });
  });

  describe('compiler', () => {
    it('detail rows with labels, links and totals', async () => {
      const res = await rows(capex({ columns: [{ field: 'number' }, { field: 'location.name' }, { field: 'status' }, { field: 'custom.priority' }, { field: 'total_amount' }], sort: [{ field: 'total_amount', dir: 'desc' }] }));
      expect(res.rows).toHaveLength(4);
      expect(res.rows[0]).toEqual([docs.d1!.number, 'Pune main store', 'Approved', 'Normal', '120000.00']);
      expect(res.rows.map(x => x[2])).toEqual(['Approved', 'Approved', 'Draft', 'Draft']);
      expect(res.totals).toEqual([null, null, null, null, '126300.00']);
      expect(res.links![0]).toBe(`/docs/capex/${docs.d1!.id}`);
      expect(res.columns.map(x => x.type)).toEqual(['text', 'lookup', 'status', 'text', 'currency']);
    });

    it('every filter operator', async () => {
      const [n1, n2, n3, n4] = [docs.d1!.number, docs.d2!.number, docs.d3!.number, docs.d4!.number];
      const all = [n1, n2, n3, n4].map(x => x ?? null);
      const flt = (field: string, op: string, value?: unknown) => numbers({ filters: [{ field, op, value }] });
      expect(await flt('custom.priority', 'eq', 'Urgent')).toEqual([n2]);
      expect((await flt('custom.priority', 'ne', 'Urgent')).length).toBe(3);
      expect((await flt('location.name', 'in', ['Chennai plant'])).sort()).toEqual([n2, null].sort());
      expect((await flt('location.name', 'not_in', ['Chennai plant'])).length).toBe(2);
      expect(await flt('total_amount', 'gt', '5000')).toEqual([n1]);
      expect((await flt('total_amount', 'gte', 5000)).sort()).toEqual([n1, n2].sort());
      expect((await flt('total_amount', 'lt', '1000')).length).toBe(1);
      expect((await flt('total_amount', 'lte', '1000')).length).toBe(2);
      expect((await flt('doc_date', 'between', [fyStart, today])).length).toBe(3);
      expect(await flt('number', 'contains', n1!.slice(-3))).toEqual([n1]);
      expect(await flt('number', 'starts_with', n2!)).toEqual([n2]);
      expect((await flt('number', 'is_empty')).length).toBe(2); // drafts have no number
      expect((await flt('custom.budget', 'not_empty'))).toEqual([n1]);
      expect((await flt('custom.budget', 'is_empty')).length).toBe(3);
      expect((await flt('location.name', 'within_location', f.chennai)).sort()).toEqual([n2, null].sort());
      expect((await flt('location.name', 'within_location', f.pune)).sort()).toEqual([n1, null].sort()); // Pune + Pune main store
      expect((await flt('location.name', 'eq', f.pune)).length).toBe(1); // by id: exactly Pune (d3)
      expect((await flt('status', 'in', ['approved'])).length).toBe(2);
      expect((await flt('created_at', 'gte', today)).length).toBe(4); // datetime vs tenant-local date
      expect((await flt('overdue', 'eq', false)).length).toBe(4);
      expect(all).toHaveLength(4);
    });

    it('optional and required parameters', async () => {
      const def = capex({ filters: [{ field: 'location.name', op: 'within_location', param: { key: 'loc', label: 'Location' } }] });
      expect((await numbers(def)).length).toBe(4); // optional param absent → no filter
      expect((await numbers(def, { loc: f.chennai })).length).toBe(2);
      const req = capex({ filters: [{ field: 'custom.priority', op: 'eq', param: { key: 'prio', label: 'Priority', required: true } }] });
      const res = await r.preview(req, {});
      expect(res.status).toBe(400);
      expect(res.body.errors[0].path).toBe('params.prio');
      expect(await numbers(req, { prio: 'Urgent' })).toEqual([docs.d2!.number]);
    });

    it('group by + aggregates + totals + chart', async () => {
      const res = await rows(capex({
        columns: [
          { field: 'location.top', label: 'Plant' }, { field: 'number', aggregate: 'count', label: 'Docs' },
          { field: 'total_amount', aggregate: 'sum' }, { field: 'total_amount', aggregate: 'avg', label: 'Avg' },
          { field: 'total_amount', aggregate: 'min', label: 'Min' }, { field: 'total_amount', aggregate: 'max', label: 'Max' },
          { field: 'status', aggregate: 'count_distinct', label: 'Statuses' },
        ],
        groupBy: ['location.top'], chart: { type: 'bar', x: 'location.top', series: ['total_amount'] },
      }));
      expect(res.rows).toEqual([
        ['Chennai plant', 2, '5300.00', '2650.00', '300.00', '5000.00', 2],
        ['Pune plant', 2, '121000.00', '60500.00', '1000.00', '120000.00', 2],
      ]);
      expect(res.totals).toEqual([null, 4, '126300.00', '31575.00', '300.00', '120000.00', 2]);
      expect(res.chart).toEqual({ x: ['Chennai plant', 'Pune plant'], series: [{ name: 'Total amount', values: [5300, 121000] }] });
    });

    it('charts split series by the second grouping field', async () => {
      const res = await rows(capex({
        columns: [{ field: 'location.top' }, { field: 'status' }, { field: 'total_amount', aggregate: 'sum' }],
        groupBy: ['location.top', 'status'], chart: { type: 'stacked_bar', x: 'location.top', series: ['total_amount'] },
      }));
      expect(res.chart).toEqual({
        x: ['Chennai plant', 'Pune plant'],
        series: [{ name: 'Approved', values: [5000, 120000] }, { name: 'Draft', values: [300, 1000] }],
      });
    });

    it('item-wise: item lookup names, quantities, groups of detail rows', async () => {
      const agg = await rows({
        source: { kind: 'doc_line', key: 'capex' },
        columns: [{ field: 'item.category.name' }, { field: 'line.qty', aggregate: 'sum' }, { field: 'line.amount', aggregate: 'sum' }, { field: 'qty.requested', aggregate: 'sum' }, { field: 'qty.pending_approval', aggregate: 'sum' }],
        groupBy: ['item.category.name'],
      });
      // items[0] = Category A (d1 line 1, d2, d4), items[1] = Category B (d1 line 2, d3)
      expect(agg.rows).toEqual([
        ['Category A', '6', '105300.00', '3', '0'],
        ['Category B', '2', '21000.00', '1', '0'],
      ]);
      const detail = await rows({
        source: { kind: 'doc_line', key: 'capex' }, columns: [{ field: 'item.name' }, { field: 'line.amount' }], groupBy: ['item.name'],
      });
      expect(detail.rows.map(x => x[0])).toEqual(['Laptop', 'Laptop', 'Laptop', 'Printer', 'Printer']);
      expect(detail.groups).toEqual([
        { key: ['Laptop'], rowCount: 3, totals: [null, '105300.00'] },
        { key: ['Printer'], rowCount: 2, totals: [null, '21000.00'] },
      ]);
    });

    it('date presets in the tenant calendar (FY boundary)', async () => {
      expect((await numbers({ datePreset: 'this_fy' })).length).toBe(3); // d4 is the day before the FY start
      expect((await numbers({}, { datePreset: 'today' }))).toEqual([docs.d1!.number]);
      expect((await numbers({ datePreset: 'this_fy' }, { datePreset: 'none' })).length).toBe(4);
      // the tenant's own FY start (TenantCalendar): a calendar-year FY starts on 1 January
      await c.db.updateTable('platform.tenant').set({ fy_start_month: 1 }).where('id', '=', f.tenantId).execute();
      try {
        const jan = presetRange('this_fy', today, 1)!;
        const expected = [docs.d1, docs.d2, docs.d3, docs.d4].filter((_, i) => [today, addDays(fyStart, 10), fyStart, addDays(fyStart, -1)][i]! >= jan.from).length;
        expect((await numbers({ datePreset: 'this_fy' })).length).toBe(expected);
        expect(expected).toBe(4);
      } finally {
        await c.db.updateTable('platform.tenant').set({ fy_start_month: 4 }).where('id', '=', f.tenantId).execute();
      }
      const audit = await rows({ source: { kind: 'engine', key: 'audit' }, columns: [{ field: 'action' }, { field: 'at' }], datePreset: 'today' });
      expect(audit.rows.length).toBeGreaterThan(0);
    });

    it('keyset pagination is stable with ties, and rowLimit truncates', async () => {
      const def = capex({ columns: [{ field: 'number' }, { field: 'custom.priority' }], sort: [{ field: 'custom.priority', dir: 'desc' }] });
      const all = (await rows(def)).rows.map(x => JSON.stringify(x));
      const seen: string[] = [];
      let cursor: string | undefined;
      const report = await mustOk(r.create({ key: `pg_${uid(6)}`, name: 'Paging', definition: def }), 201);
      for (let i = 0; i < 10; i++) {
        const page = await mustOk(r.run(report.id, { page: { limit: 1, ...(cursor ? { cursor } : {}) } }));
        seen.push(...page.rows.map((x: unknown) => JSON.stringify(x)));
        if (i > 0) expect(page.totals).toBeNull();
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(all);
      const lim = await mustOk(r.create({ key: `lim_${uid(6)}`, name: 'Limited', definition: { ...def, rowLimit: 3 } }), 201);
      const p1 = await mustOk(r.run(lim.id, { page: { limit: 2 } }));
      expect(p1.rows).toHaveLength(2);
      const p2 = await mustOk(r.run(lim.id, { page: { limit: 2, cursor: p1.nextCursor } }));
      expect(p2.rows).toHaveLength(1);
      expect(p2.truncated).toBe(true);
      expect(p2.nextCursor).toBeNull();
      const badCursor = await r.run(lim.id, { page: { cursor: 'eyJ2IjpbMV0sIm4iOjB9' } });
      expect(badCursor.status).toBe(400);
    });
  });

  describe('security', () => {
    it('rejects fields outside the catalogue and malformed definitions', async () => {
      for (const field of ['nope', 'number; drop table app.document', 'd.custom', 'custom.purpose\') or true --']) {
        const res = await r.preview(capex({ columns: [{ field }] }));
        expect(res.status, field).toBe(400);
        expect(res.body.title).toMatch(/Unknown field/);
      }
      expect((await r.preview(capex({ filters: [{ field: 'x)--', op: 'eq', value: 1 }] }))).status).toBe(400);
      expect((await r.preview(capex({ columns: [{ field: 'number', aggregate: 'sum' }] }))).status).toBe(400);
      expect((await r.preview(capex({ columns: [{ field: 'number' }, { field: 'total_amount', aggregate: 'sum' }] }))).status).toBe(400); // ungrouped column
      expect((await r.preview(capex({ columns: [{ field: 'number' }], chart: { type: 'bar', x: 'number', series: ['number'] } }))).status).toBe(400);
      expect((await r.preview(capex({ filters: [{ field: 'total_amount', op: 'gt', value: '1 or 1=1' }] }))).status).toBe(400);
      expect((await r.preview(capex({ filters: [{ field: 'doc_date', op: 'eq', value: "2026-01-01'; --" }] }))).status).toBe(400);
      expect((await r.preview(capex({ filters: [{ field: 'number', op: 'contains', value: { $ne: 1 } }] }))).status).toBe(400);
      expect((await r.preview({ ...capex(), source: { kind: 'doc', key: 'nope' } })).status).toBe(404);
      expect((await r.preview({ ...capex(), source: { kind: 'engine', key: 'nope' } })).status).toBe(404);
    });

    it('parameterises injection strings in values and params', async () => {
      const evil = ["'; drop table app.document; --", "Normal' or '1'='1", '%', '_', '\\'];
      for (const v of evil) {
        expect(await numbers({ filters: [{ field: 'custom.priority', op: 'eq', value: v }] })).toEqual([]);
        expect(await numbers({ filters: [{ field: 'custom.priority', op: 'contains', value: v }] })).toEqual([]);
        expect(await numbers({ filters: [{ field: 'custom.priority', op: 'eq', param: { key: 'p', label: 'P' } }] }, { p: v })).toEqual([]);
      }
      const n = await sql<{ n: string }>`select count(*)::text as n from app.document where tenant_id = ${f.tenantId}`.execute(c.db);
      expect(Number(n.rows[0]!.n)).toBe(4);
    });

    it('needs reports:action.view, source access, and the builder key for preview', async () => {
      const none = await reportUser(c, f, ['dashboards:action.view']);
      expect((await reportsApi(c, none.token).get('/reports')).status).toBe(403);
      const viewer = await reportUser(c, f, ['reports:action.view']);
      expect((await reportsApi(c, viewer.token).preview(capex())).status).toBe(403);
      const builder = await reportUser(c, f, ['reports:action.view', 'reports:action.build']);
      const res = await reportsApi(c, builder.token).preview(capex());
      expect(res.status).toBe(403); // no doc.capex view
      const sources = await mustOk(reportsApi(c, builder.token).get('/reports/sources'));
      expect(sources.map((s: { source: { key: string } }) => s.source.key)).not.toContain('capex');
      expect(sources.map((s: { source: { key: string } }) => s.source.key)).not.toContain('audit');
    });

    it('data scope: a Pune-scoped user never sees Chennai rows', async () => {
      const u = await reportUser(c, f, [...reportKeys, ...capexViewKeys], f.pune);
      const nums = await numbers({}, {}, u.token);
      expect(nums.sort()).toEqual([docs.d1!.number, null].sort());
      const grouped = await rows(capex({ columns: [{ field: 'location.top' }, { field: 'number', aggregate: 'count' }], groupBy: ['location.top'] }), {}, u.token);
      expect(grouped.rows).toEqual([['Pune plant', 2]]);
      expect(grouped.totals).toEqual([null, 2]);
      expect(await numbers({ filters: [{ field: 'location.name', op: 'within_location', value: f.chennai }] }, {}, u.token)).toEqual([]);
      const lines = await rows({ source: { kind: 'doc_line', key: 'capex' }, columns: [{ field: 'location.name' }] }, {}, u.token);
      expect(lines.rows.every(x => x[0] !== 'Chennai plant')).toBe(true);
      const all = await rows({ source: { kind: 'engine', key: 'documents' }, columns: [{ field: 'location.top' }] }, {}, u.token);
      expect(all.rows.flat()).not.toContain('Chennai plant');
      expect(all.rows.length).toBe(2);
    });

    it('field access: hidden fields leave the catalogue and are rejected', async () => {
      const u = await reportUser(c, f, [...capexViewKeys, ...reportKeys], undefined, [
        { formKey: 'capex_header', fieldKey: 'budget', mode: 'hidden' }, { formKey: 'capex_line', fieldKey: 'est_rate', mode: 'hidden' },
      ]);
      const me = await mustOk(reportsApi(c, u.token).get('/auth/me'));
      expect(me.permissions.fieldAccess.capex_header).toEqual({ budget: 'hidden' });
      const sources = await mustOk(reportsApi(c, u.token).get('/reports/sources'));
      const doc = sources.find((s: { source: { kind: string; key: string } }) => s.source.kind === 'doc' && s.source.key === 'capex');
      expect(doc.fields.map((x: { id: string }) => x.id)).not.toContain('custom.budget');
      expect(doc.fields.map((x: { id: string }) => x.id)).toContain('custom.priority');
      const res = await reportsApi(c, u.token).preview(capex({ columns: [{ field: 'custom.budget' }] }));
      expect(res.status).toBe(400);
      expect((await reportsApi(c, u.token).preview(capex({ filters: [{ field: 'custom.budget', op: 'not_empty' }] }))).status).toBe(400);
      expect((await reportsApi(c, u.token).preview({ source: { kind: 'doc_line', key: 'capex' }, columns: [{ field: 'line.custom.est_rate' }] })).status).toBe(400);
      expect((await reportsApi(c, u.token).preview(capex({ columns: [{ field: 'custom.priority' }] }))).status).toBe(200);
    });

    it('view permissions: only permitted statuses, explicit others refused', async () => {
      const u = await reportUser(c, f, [...reportKeys, 'doc.capex:action.view', 'doc.capex:view.draft']);
      expect((await numbers({}, {}, u.token))).toEqual([null, null]);
      const res = await reportsApi(c, u.token).preview(capex({ filters: [{ field: 'status', op: 'eq', value: 'approved' }] }));
      expect(res.status).toBe(403);
      expect((await reportsApi(c, u.token).preview(capex({ filters: [{ field: 'status', op: 'in', value: ['draft', 'approved'] }] }))).status).toBe(403);
      expect((await numbers({ filters: [{ field: 'status', op: 'ne', value: 'approved' }] }, {}, u.token)).length).toBe(2);
    });

    it('cross-tenant: another tenant sees none of these rows or reports', async () => {
      const g = await reportsTenant(c);
      const gr = reportsApi(c, g.token);
      const mine = await mustOk(r.create({ key: `x_${uid(6)}`, name: 'Mine', definition: capex() }), 201);
      expect((await gr.get(`/reports/${mine.id}`)).status).toBe(404);
      expect((await gr.run(mine.id)).status).toBe(404);
      expect((await gr.put(`/reports/${mine.id}`, { key: 'hijack', name: 'H', definition: capex() })).status).toBe(404);
      expect((await gr.del(`/reports/${mine.id}`)).status).toBe(404);
      const theirs = await mustOk(gr.preview(capex()));
      expect(theirs.rows).toEqual([]);
      const list = await mustOk(gr.get('/reports'));
      expect(list.map((x: { id: string }) => x.id)).not.toContain(mine.id);
      // within_location with the other tenant's node id: nothing (RLS hides the node)
      expect((await mustOk(gr.preview(capex({ filters: [{ field: 'location.name', op: 'within_location', value: f.pune }] })))).rows).toEqual([]);
    });
  });

  describe('saved reports', () => {
    it('CRUD, sharing with roles, built-ins read-only', async () => {
      const list = await mustOk(r.get('/reports'));
      const builtins = list.filter((x: { kind: string }) => x.kind === 'builtin');
      // the Phase 7 built-ins (+ the standard report pack's reports this tenant's features and doc types allow: report-pack.test.ts)
      expect(builtins.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(['builtin_audit_trail', 'builtin_docs_by_status_location', 'builtin_pending_approvals', 'builtin_users_roles']));
      expect(builtins.map((x: { key: string }) => x.key)).not.toContain('builtin_stock_summary'); // no `store` feature
      const b = builtins[0];
      expect((await r.put(`/reports/${b.id}`, { key: b.key, name: 'x', definition: b.definition })).status).toBe(409);
      expect((await r.del(`/reports/${b.id}`)).status).toBe(409);
      expect((await r.create({ key: 'builtin_mine', name: 'x', definition: capex() })).status).toBe(400);

      const role = await mustOk(r.post('/roles', { key: `r_${uid(6)}`, name: 'Report readers' }), 201);
      const rep = await mustOk(r.create({ key: `cap_${uid(6)}`, name: 'Capex list', definition: capex(), sharedRoleIds: [role.id] }), 201);
      expect(rep).toMatchObject({ kind: 'custom', isMine: true, canEdit: true, sharedRoleIds: [role.id] });
      expect((await r.create({ key: rep.key, name: 'dup', definition: capex() })).status).toBe(409);
      const upd = await mustOk(r.put(`/reports/${rep.id}`, { key: rep.key, name: 'Capex list v2', definition: capex({ columns: [{ field: 'number' }, { field: 'status' }] }), sharedRoleIds: [role.id] }));
      expect(upd).toMatchObject({ name: 'Capex list v2', version: 2 });

      const other = await reportUser(c, f, [...reportKeys, ...capexViewKeys]);
      expect((await reportsApi(c, other.token).get(`/reports/${rep.id}`)).status).toBe(404);
      await mustOk(r.put(`/users/${other.userId}`, { roleIds: [other.roleId, role.id], version: (await mustOk(r.get(`/users/${other.userId}`))).version }));
      await c.app.get(EntitlementsService).bumpPermissions(f.tenantId);
      const seen = await mustOk(reportsApi(c, other.token).get(`/reports/${rep.id}`));
      expect(seen).toMatchObject({ isMine: false, canEdit: false });
      expect((await reportsApi(c, other.token).run(rep.id)).status).toBe(200);
      expect((await reportsApi(c, other.token).put(`/reports/${rep.id}`, { key: rep.key, name: 'mine now', definition: capex() })).status).toBe(403);
      const noShare = await reportUser(c, f, ['reports:action.view', 'reports:action.build', ...capexViewKeys]);
      expect((await reportsApi(c, noShare.token).create({ key: `s_${uid(6)}`, name: 'S', definition: capex(), sharedRoleIds: [role.id] })).status).toBe(403);
      expect((await r.create({ key: `s_${uid(6)}`, name: 'S', definition: capex(), sharedRoleIds: ['00000000-0000-0000-0000-000000000001'] })).status).toBe(400);

      expect((await r.del(`/reports/${rep.id}`)).status).toBe(204);
      expect((await r.get(`/reports/${rep.id}`)).status).toBe(404);
      expect((await r.get('/reports/not-a-uuid')).status).toBe(404);
    });

    it('built-in reports run', async () => {
      const list = await mustOk(r.get('/reports'));
      const id = (k: string) => list.find((x: { key: string }) => x.key === k).id;
      const byStatus = await mustOk(r.run(id('builtin_docs_by_status_location')));
      expect(byStatus.rows).toEqual(expect.arrayContaining([['Capex Request', 'Approved', 'Chennai plant', 1, '5000.00'], ['Capex Request', 'Draft', 'Pune plant', 1, '1000.00']]));
      expect((await mustOk(r.run(id('builtin_docs_by_status_location'), { params: { doc_type: 'capex' } }))).rows.length).toBe(4);
      expect((await r.run(id('builtin_docs_by_status_location'), { params: { doc_type: 'other' } })).status).toBe(403);
      const users = await mustOk(r.run(id('builtin_users_roles')));
      expect(users.rows.map((x: unknown[]) => x[1])).toContain(`admin@${f.code}.test`);
      const audit = await mustOk(r.run(id('builtin_audit_trail'), { params: { user: f.adminId } }));
      expect(audit.rows.length).toBeGreaterThan(0);
      expect(audit.rows.every((x: unknown[]) => x[1] === 'Tenant Admin')).toBe(true);

      // a workflow puts a new document at the HOD stage; the approver role's users show up
      const role = await mustOk(r.post('/roles', { key: `hod_${uid(6)}`, name: 'HOD' }), 201);
      const hod = await reportUser(c, f, ['doc.capex:action.view', 'approvals:action.view']);
      await mustOk(r.put(`/users/${hod.userId}`, { roleIds: [hod.roleId, role.id], version: (await mustOk(r.get(`/users/${hod.userId}`))).version }));
      await publishWorkflow(c, f.token, 'capex', { granularity: 'line', stages: [{ key: 'hod', name: 'HOD approval', actors: [{ type: 'role', roleId: role.id }] }] });
      const d5 = await capexDoc(c, f, { location: f.pune, submit: true, date: today, lines: [{ qty: '1', est_rate: '7000' }] });
      expect(d5.statusKey).toBe('waiting_hod');
      const pending = await mustOk(r.run(id('builtin_pending_approvals')));
      const hodName = (await mustOk(r.get(`/users/${hod.userId}`))).name;
      // role members are candidates (the engine may also assign fallback approvers, e.g. admins, when the member lacks the stage key)
      expect(pending.rows).toEqual(expect.arrayContaining([[hodName, 'Capex Request', 'HOD approval', 1, '0']]));
      expect(pending.chart.x).toEqual(expect.arrayContaining([hodName]));
      const staged = await rows(capex({ columns: [{ field: 'number' }, { field: 'wf.stage' }], filters: [{ field: 'status', op: 'eq', value: 'waiting_hod' }] }));
      expect(staged.rows).toEqual([[d5.number, expect.stringMatching(/HOD approval/)]]);
    });
  });

  describe('volume', () => {
    it('paginates 250 rows with heavy ties without gaps or repeats', async () => {
      const g = await reportsTenant(c);
      await bulkCapex(c, g, 250, 0, 'PG');
      const gr = reportsApi(c, g.token);
      const rep = await mustOk(gr.create({ key: 'ties', name: 'Ties', definition: capex({ columns: [{ field: 'number' }, { field: 'custom.priority' }, { field: 'location.name' }], sort: [{ field: 'custom.priority', dir: 'asc' }, { field: 'location.name', dir: 'desc' }] }) }), 201);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await mustOk(gr.run(rep.id, { page: { limit: 7, ...(cursor ? { cursor } : {}) } }));
        seen.push(...page.rows.map((x: unknown[]) => String(x[0])));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen).toHaveLength(250);
      expect(new Set(seen).size).toBe(250);
    });
  });
});

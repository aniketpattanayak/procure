/**
 * QA batch (Phases 4/6/7) — Phase 7 reports engine, black-box through the HTTP API:
 *   non-catalogue field ids everywhere a field id is accepted (columns, filters, groupBy, sort, chart, source keys),
 *   SQL injection in filter values / params / cursors, data scope + field access through shared reports, exports
 *   (report + list) and dashboard widgets, permission revocation between export request and processing,
 *   permissions (403) per action key and cross-tenant isolation on every Phase 7 endpoint.
 *
 * Known bugs are `it.fails` with their QA47-BUG id (docs/qa/phase-4-6-7-report.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/core/entitlements.service';
import { QueueService } from '../src/core/queue.service';
import { FilesService } from '../src/modules/files';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, drainQueues, startWorkers, uid } from './helpers';
import { capexDoc, capexViewKeys, reportKeys, reportsApi, reportsTenant, ReportsFixture, reportUser } from './reports-helpers';

const capex = (o: Record<string, unknown> = {}) => ({ source: { kind: 'doc', key: 'capex' }, columns: [{ field: 'number' }], ...o });

let c: Ctx;
let f: ReportsFixture;
let pune: { token: string; userId: string; roleId: string }; // Pune-scoped, budget + est_rate hidden
let numbers: { pune: string[]; chennai: string[] };

const exportText = async (tenantId: string, jobId: string) => {
  await drainQueues(c, ['exports'], 60_000);
  const job = await c.db.selectFrom('app.export_job').select(['file_id', 'status', 'error', 'row_count']).where('id', '=', jobId).executeTakeFirstOrThrow();
  if (job.status !== 'ready') return { status: job.status, error: job.error, text: '' };
  const row = await c.db.selectFrom('app.file_object').select(['storage_key']).where('id', '=', job.file_id!).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
  return { status: job.status, error: job.error, text: (await c.app.get(FilesService).storage.get(row.storage_key)).toString('utf8') };
};

beforeAll(async () => {
  c = await bootApp();
  await startWorkers(c);
  f = await reportsTenant(c);
  const p1 = await capexDoc(c, f, { location: f.puneMain, submit: true, budget: '777111', values: { purpose: '=HYPERLINK("http://evil.test")' }, lines: [{ qty: '2', est_rate: '45678' }] });
  const p2 = await capexDoc(c, f, { location: f.pune, submit: true, budget: '777222', lines: [{ qty: '1', est_rate: '45679' }] });
  const c1 = await capexDoc(c, f, { location: f.chennai, submit: true, budget: '888333', lines: [{ qty: '3', est_rate: '99887' }] });
  numbers = { pune: [p1.number, p2.number], chennai: [c1.number] };
  pune = await reportUser(c, f, [...capexViewKeys, ...reportKeys], f.pune, [
    { formKey: 'capex_header', fieldKey: 'budget', mode: 'hidden' }, { formKey: 'capex_line', fieldKey: 'est_rate', mode: 'hidden' },
  ]);
}, 120_000);
afterAll(async () => closeApp(c));

// ===================================================================================================== catalogue
describe('only catalogue fields, every place a field id is accepted', () => {
  const NOT_FIELDS = ['custom', 'd.custom', 'tenant_id', 'password_hash', 'id; drop table app.document', 'number) from app.tenant_user --', '__proto__', 'constructor',
    'custom.__proto__', 'custom.budget\'', 'location.path::text', '*', '1', 'qty.requested', 'custom.nonexistent'];
  it('columns / filters / groupBy / sort / chart reject anything outside the catalogue (400, never 500)', async () => {
    const r = reportsApi(c, f.token);
    const bad: string[] = [];
    for (const id of NOT_FIELDS) {
      const variants = [
        capex({ columns: [{ field: id }] }),
        capex({ filters: [{ field: id, op: 'eq', value: 'x' }] }),
        capex({ columns: [{ field: 'number', aggregate: 'count' }], groupBy: [id] }),
        capex({ sort: [{ field: id, dir: 'asc' }] }),
        capex({ columns: [{ field: 'location.name' }, { field: 'total_amount', aggregate: 'sum' }], groupBy: ['location.name'], chart: { type: 'bar', x: id, series: ['total_amount'] } }),
      ];
      for (const [i, d] of variants.entries()) {
        const res = await r.preview(d);
        if (res.status !== 400) bad.push(`${id}#${i} → ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('unknown / internal source keys are 400/404, never data', async () => {
    const r = reportsApi(c, f.token);
    for (const source of [
      { kind: 'doc', key: 'nope' }, { kind: 'doc', key: "capex' or '1'='1" }, { kind: 'master', key: 'tenant_user' }, { kind: 'master', key: '../platform.tenant' },
      { kind: 'engine', key: 'pg_catalog.pg_user' }, { kind: 'doc_line', key: 'capex;--' }, { kind: 'engine', key: '__proto__' },
    ]) {
      const res = await r.preview({ source, columns: [{ field: 'number' }] });
      expect([JSON.stringify(source), [400, 403, 404].includes(res.status)]).toEqual([JSON.stringify(source), true]);
    }
  });
});

// ===================================================================================================== SQL injection
describe('SQL injection in filters, params and cursors', () => {
  const INJ = ["' or '1'='1", "x'); delete from app.document; --", '%', '_', '\\', "1 or 1=1", "' union select password_hash from app.tenant_user --"];
  it('text values are bound: eq / in / contains / starts_with match literally (wildcards escaped)', async () => {
    const r = reportsApi(c, f.token);
    for (const v of INJ) {
      for (const flt of [{ op: 'eq', value: v }, { op: 'in', value: [v] }, { op: 'contains', value: v }, { op: 'starts_with', value: v }, { op: 'ne', value: v }]) {
        const res = await mustOk(r.preview(capex({ filters: [{ field: 'custom.purpose', ...flt }] })));
        if (flt.op === 'ne') expect(res.rows.length).toBe(3); // nothing equals the payload
        else expect([v, flt.op, res.rows]).toEqual([v, flt.op, []]);
      }
    }
    const docs = await c.db.selectFrom('app.document').select('id').where('tenant_id', '=', f.tenantId).execute();
    expect(docs.length).toBeGreaterThanOrEqual(3);
  });

  it('typed values: numbers, dates, booleans, location ids and params with SQL are 400', async () => {
    const r = reportsApi(c, f.token);
    const cases = [
      { field: 'total_amount', op: 'gt', value: '1 or 1=1' }, { field: 'total_amount', op: 'between', value: ['0', '1); drop table x; --'] },
      { field: 'doc_date', op: 'eq', value: "2026-01-01' or '1'='1" }, { field: 'doc_date', op: 'in', value: ['2026-01-01', 'now()'] },
      { field: 'location.name', op: 'within_location', value: "' or 1=1 --" }, { field: 'total_amount', op: 'eq', value: { $gt: 0 } },
      { field: 'total_amount', op: 'in', value: Array.from({ length: 501 }, (_, i) => String(i)) },
    ];
    for (const flt of cases) {
      const res = await r.preview(capex({ filters: [flt] }));
      expect([JSON.stringify(flt).slice(0, 80), res.status]).toEqual([JSON.stringify(flt).slice(0, 80), 400]);
    }
    const p = await r.preview(capex({ filters: [{ field: 'total_amount', op: 'gte', param: { key: 'min', label: 'Min' } }] }), { min: '0 or 1=1' });
    expect(p.status).toBe(400);
    const preset = await mustOk(r.preview(capex({ datePreset: 'none' }), { datePreset: "this_fy'; --" }));
    expect(preset.rows.length).toBe(3);
  });

  it('tampered keyset cursors are 400 (never a 500, never a different query)', async () => {
    const r = reportsApi(c, f.token);
    const def = capex({ columns: [{ field: 'number' }, { field: 'total_amount' }], sort: [{ field: 'total_amount', dir: 'asc' }] });
    const rep = await mustOk(r.create({ key: `cur_${uid(6)}`, name: 'Cursor', definition: def }), 201);
    const first = await mustOk(r.run(rep.id, { page: { limit: 1 } }));
    expect(first.nextCursor).toBeTruthy();
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const bad: string[] = [];
    for (const cursor of ['%%%', 'e30', enc({ v: [1, 'x'], n: 1 }), enc({ v: ['1', 'x'], n: -1 }), enc({ v: ['1'], n: 1 }), enc({ v: ["1') or true --", 'x'], n: 1 }), enc({ v: ['abc', 'x'], n: 1 })]) {
      const res = await r.run(rep.id, { page: { limit: 1, cursor } });
      if (res.status !== 400) bad.push(`${Buffer.from(cursor, 'base64url').toString().slice(0, 40)} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  });
});

// ===================================================================================================== scope + field access
describe('data scope and field access in reports, exports and dashboards', () => {
  it('a report shared with a restricted role: hidden fields are refused, out-of-scope rows never returned', async () => {
    const r = reportsApi(c, f.token);
    const withHidden = await mustOk(r.create({ key: `sh_${uid(6)}`, name: 'Shared with budget', definition: capex({ columns: [{ field: 'number' }, { field: 'custom.budget' }] }), sharedRoleIds: [pune.roleId] }), 201);
    const plain = await mustOk(r.create({ key: `sp_${uid(6)}`, name: 'Shared plain', definition: capex({ columns: [{ field: 'number' }, { field: 'location.name' }, { field: 'total_amount' }] }), sharedRoleIds: [pune.roleId] }), 201);
    const u = reportsApi(c, pune.token);
    const res = await u.run(withHidden.id);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/77711|88833/);
    const ok = await mustOk(u.run(plain.id));
    expect(ok.rows.map((x: unknown[]) => x[0]).sort()).toEqual([...numbers.pune].sort());
    // export of the hidden-field report is refused up front; of the plain one has Pune rows only
    expect((await u.post('/exports', { kind: 'report', source: { reportId: withHidden.id }, format: 'csv' })).status).toBe(400);
    const job = await mustOk(u.post('/exports', { kind: 'report', source: { reportId: plain.id }, format: 'csv' }), 201);
    const out = await exportText(f.tenantId, job.id);
    expect(out.status).toBe('ready');
    for (const n of numbers.pune) expect(out.text).toContain(n);
    for (const n of numbers.chennai) expect(out.text).not.toContain(n);
    // item-wise source: hidden line field
    expect((await u.preview({ source: { kind: 'doc_line', key: 'capex' }, columns: [{ field: 'line.custom.est_rate' }] })).status).toBe(400);
  });

  it('list exports (document-wise and item-wise) apply scope and field access; CSV formula injection is neutralised', async () => {
    const u = reportsApi(c, pune.token);
    for (const scope of ['doc.capex', 'doc.capex:item']) {
      const job = await mustOk(u.post('/exports', { kind: 'list', source: { scope, query: {} }, format: 'csv' }), 201);
      const out = await exportText(f.tenantId, job.id);
      expect([scope, out.status]).toEqual([scope, 'ready']);
      for (const n of numbers.chennai) expect(out.text).not.toContain(n);
      expect(out.text).not.toMatch(/777111|777222|888333/); // hidden header field
      // (doc-wise "Total amount" = qty × est_rate is a separate, visible field — see report "observations")
      if (scope.endsWith(':item')) expect(out.text).not.toMatch(/45678|45679/);
    }
    const admin = await mustOk(reportsApi(c, f.token).post('/exports', { kind: 'report', source: { reportId: (await mustOk(reportsApi(c, f.token).create({ key: `pu_${uid(6)}`, name: 'Purpose', definition: capex({ columns: [{ field: 'number' }, { field: 'custom.purpose' }] }) }), 201)).id }, format: 'csv' }), 201);
    const t = await exportText(f.tenantId, admin.id);
    expect(t.text).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
  });

  it('a dashboard shared to the restricted role runs every widget with the viewer\'s scope', async () => {
    const r = reportsApi(c, f.token);
    const rep = await mustOk(r.create({ key: `dw_${uid(6)}`, name: 'By location', definition: capex({ columns: [{ field: 'location.name' }, { field: 'total_amount', aggregate: 'sum' }, { field: 'number', aggregate: 'count' }], groupBy: ['location.name'] }), sharedRoleIds: [pune.roleId] }), 201);
    const dash = await mustOk(r.post('/dashboards', {
      name: 'Ops', sharedRoleIds: [pune.roleId],
      widgets: [{ id: 'k', type: 'kpi', title: 'Docs', reportId: rep.id, x: 0, y: 0, w: 3, h: 2 }, { id: 't', type: 'table', title: 'Table', reportId: rep.id, x: 3, y: 0, w: 6, h: 4 },
        { id: 'd', type: 'doc_counts', title: 'Counts', docTypeKey: 'capex', x: 0, y: 4, w: 6, h: 3 }],
    }), 201);
    const u = reportsApi(c, pune.token);
    const tbl = await mustOk(u.post('/dashboards/widgets/t/data', { dashboardId: dash.id }));
    expect(JSON.stringify(tbl)).not.toContain('Chennai');
    const kpi = await mustOk(u.post('/dashboards/widgets/k/data', { dashboardId: dash.id }));
    const adminKpi = await mustOk(r.post('/dashboards/widgets/k/data', { dashboardId: dash.id }));
    expect(kpi.value).toBeLessThan(adminKpi.value);
    const counts = await mustOk(u.post('/dashboards/widgets/d/data', { dashboardId: dash.id }));
    expect(counts.types[0].total).toBe(2);
  });

  it('permissions are re-checked when the export job runs (revoked in between → failed, no file)', async () => {
    const u = await reportUser(c, f, [...capexViewKeys, ...reportKeys]);
    const q = c.app.get(QueueService).queue('exports');
    await q.pause();
    try {
      const job = await mustOk(reportsApi(c, u.token).post('/exports', { kind: 'list', source: { scope: 'doc.capex', query: {} }, format: 'csv' }), 201);
      await mustOk(api(c, f.token).put(`/roles/${u.roleId}/permissions/tabs/doc.capex`, { actions: [], views: [] }));
      await c.app.get(EntitlementsService).bumpPermissions(f.tenantId);
      await q.resume();
      const out = await exportText(f.tenantId, job.id);
      expect(out.status).toBe('failed');
    } finally {
      await q.resume();
    }
  });
});

// ===================================================================================================== permissions
describe('Phase 7 permissions per action key', () => {
  it('each missing key → 403', async () => {
    const r = reportsApi(c, f.token);
    const rep = await mustOk(r.create({ key: `pk_${uid(6)}`, name: 'Perm', definition: capex() }), 201);
    const role = await mustOk(api(c, f.token).post('/roles', { key: `r_${uid(6)}`, name: 'Some role' }), 201);
    const viewOnly = await reportUser(c, f, [...capexViewKeys, 'reports:action.view', 'dashboards:action.view']);
    const v = reportsApi(c, viewOnly.token);
    const mine = await mustOk(r.create({ key: `ps_${uid(6)}`, name: 'Shared', definition: capex(), sharedRoleIds: [viewOnly.roleId] }), 201);
    const none = await reportUser(c, f, capexViewKeys);
    const n = reportsApi(c, none.token);
    const builder = await reportUser(c, f, [...capexViewKeys, 'reports:action.view', 'reports:action.build']);
    const calls: [string, Promise<{ status: number }>][] = [
      ['sources (no view)', n.get('/reports/sources')],
      ['list (no view)', n.get('/reports')],
      ['run (no view)', n.run(rep.id)],
      ['preview (no build)', v.preview(capex())],
      ['create (no build)', v.create({ key: `x_${uid(6)}`, name: 'X', definition: capex() })],
      ['update (no build)', v.put(`/reports/${mine.id}`, { key: 'x_y', name: 'X', definition: capex() })],
      ['delete (no build)', v.del(`/reports/${mine.id}`)],
      ['share (no share key)', reportsApi(c, builder.token).create({ key: `x_${uid(6)}`, name: 'X', definition: capex(), sharedRoleIds: [role.id] })],
      ['schedule create (no schedule)', v.post(`/reports/${mine.id}/schedules`, { cron: '0 9 * * 1', recipients: [{ type: 'user', userId: viewOnly.userId }] })],
      ['schedule list (no schedule)', v.get(`/reports/${mine.id}/schedules`)],
      ['export report (no export)', v.post('/exports', { kind: 'report', source: { reportId: mine.id }, format: 'csv' })],
      ['dashboard create (no edit)', v.post('/dashboards', { name: 'D', widgets: [] })],
      ['dashboards (no view)', n.get('/dashboards')],
    ];
    const out = await Promise.all(calls.map(async ([k, p]) => [k, (await p).status] as const));
    expect(out.filter(([, s]) => s !== 403)).toEqual([]);
  });

  // QA47-BUG-010: dashboards can be shared with / made the default for any role without reports:action.share —
  // a user holding only dashboards:action.edit replaces the home dashboard of every role (incl. ones they do not hold).
  it('QA47-BUG-010: sharing a dashboard / making it a role default needs reports:action.share', async () => {
    const editor = await reportUser(c, f, [...capexViewKeys, 'reports:action.view', 'dashboards:action.view', 'dashboards:action.edit']);
    const other = await mustOk(api(c, f.token).post('/roles', { key: `r_${uid(6)}`, name: 'Finance' }), 201);
    const res = await reportsApi(c, editor.token).post('/dashboards', { name: 'Mine for all', widgets: [], isDefaultForRoleIds: [other.id], sharedRoleIds: [other.id] });
    expect(res.status).toBe(403);
    // regression: own unshared dashboard is fine; adding a role later (shared or default) is gated too
    const e = reportsApi(c, editor.token);
    const own = await mustOk(e.post('/dashboards', { name: 'Mine', widgets: [] }), 201);
    expect((await e.put(`/dashboards/${own.id}`, { name: 'Mine', widgets: [], sharedRoleIds: [other.id] })).status).toBe(403);
    expect((await e.put(`/dashboards/${own.id}`, { name: 'Mine', widgets: [], isDefaultForRoleIds: [other.id] })).status).toBe(403);
    expect((await e.put(`/dashboards/${own.id}`, { name: 'Mine 2', widgets: [] })).status).toBe(200);
    // with reports:action.share it works, and the owner can keep editing it with the same roles
    const sharer = await reportUser(c, f, [...capexViewKeys, 'reports:action.view', 'reports:action.share', 'dashboards:action.view', 'dashboards:action.edit']);
    const sh = reportsApi(c, sharer.token);
    const d = await mustOk(sh.post('/dashboards', { name: 'For finance', widgets: [], sharedRoleIds: [other.id], isDefaultForRoleIds: [other.id] }), 201);
    expect((await sh.put(`/dashboards/${d.id}`, { name: 'For finance v2', widgets: [], sharedRoleIds: [other.id], isDefaultForRoleIds: [other.id] })).status).toBe(200);
  });
});

// ===================================================================================================== cross-tenant
describe('cross-tenant isolation on every Phase 7 endpoint', () => {
  it("tenant B on A's report / schedule / export / dashboard / widget ids → 404 and nothing of A leaks", async () => {
    const r = reportsApi(c, f.token);
    const rep = await mustOk(r.create({ key: `xt_${uid(6)}`, name: 'A only', definition: capex({ columns: [{ field: 'number' }, { field: 'custom.budget' }] }) }), 201);
    const sch = await mustOk(r.post(`/reports/${rep.id}/schedules`, { cron: '0 9 * * 1', recipients: [{ type: 'user', userId: f.adminId }] }), 201);
    const job = await mustOk(r.post('/exports', { kind: 'report', source: { reportId: rep.id }, format: 'csv' }), 201);
    await exportText(f.tenantId, job.id);
    const dash = await mustOk(r.post('/dashboards', { name: 'A dash', widgets: [{ id: 't', type: 'table', title: 'T', reportId: rep.id, x: 0, y: 0, w: 6, h: 4 }] }), 201);

    const g = await reportsTenant(c);
    const b = reportsApi(c, g.token);
    const calls: [string, Promise<{ status: number; body: unknown }>][] = [
      ['report get', b.get(`/reports/${rep.id}`)],
      ['report run', b.run(rep.id)],
      ['report put', b.put(`/reports/${rep.id}`, { key: 'hijack', name: 'H', definition: capex() })],
      ['report delete', b.del(`/reports/${rep.id}`)],
      ['schedules list', b.get(`/reports/${rep.id}/schedules`)],
      ['schedule create', b.post(`/reports/${rep.id}/schedules`, { cron: '0 9 * * 1', recipients: [{ type: 'user', userId: f.adminId }] })],
      ['schedule delete', b.del(`/reports/${rep.id}/schedules/${sch.id}`)],
      ['export get', b.get(`/exports/${job.id}`)],
      ['export request', b.post('/exports', { kind: 'report', source: { reportId: rep.id }, format: 'csv' })],
      ['dashboard get', b.get(`/dashboards/${dash.id}`)],
      ['dashboard put', b.put(`/dashboards/${dash.id}`, { name: 'H', widgets: [] })],
      ['dashboard delete', b.del(`/dashboards/${dash.id}`)],
      ['widget data', b.post('/dashboards/widgets/t/data', { dashboardId: dash.id })],
      ['dashboard with A report', b.post('/dashboards', { name: 'X', widgets: [{ id: 't', type: 'table', title: 'T', reportId: rep.id, x: 0, y: 0, w: 6, h: 4 }] })],
      ['schedule recipient = A user', b.post('/reports', { key: `z_${uid(6)}`, name: 'Z', definition: capex() }).then(async x => b.post(`/reports/${x.body.id}/schedules`, { cron: '0 9 * * 1', recipients: [{ type: 'user', userId: f.adminId }] }))],
    ];
    const out = await Promise.all(calls.map(async ([n, p]) => { const x = await p; return [n, x.status, JSON.stringify(x.body)] as const; }));
    expect(out.filter(([, s]) => s !== 404 && s !== 400).map(([n, s]) => `${n}:${s}`)).toEqual([]);
    for (const [, , body] of out) expect(body).not.toMatch(/77711|88833|A only|CAPEX\//);
    expect((await mustOk(b.get('/exports'))).map((x: { id: string }) => x.id)).not.toContain(job.id);
    // A unchanged
    expect((await mustOk(r.get(`/reports/${rep.id}`))).name).toBe('A only');
    expect((await mustOk(r.get(`/reports/${rep.id}/schedules`))).length).toBe(1);
    expect((await mustOk(r.get(`/dashboards/${dash.id}`))).name).toBe('A dash');
    // leave no active schedule behind (SchedulesService.scan is global; reports.exports asserts an empty scan)
    await mustOk(r.del(`/reports/${rep.id}/schedules/${sch.id}`), 200, 204);
  });
});

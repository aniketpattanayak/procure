/**
 * Background exports (xlsx/csv, lists, masters, expiry), schedules (fake clock) and dashboards (widget data).
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesService } from '../src/modules/files';
import { registeredSources } from '../src/modules/reports';
import { ExportsService } from '../src/modules/reports/exports.service';
import { SchedulesService } from '../src/modules/reports/schedules.service';
import { mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, drainQueues, startWorkers, uid } from './helpers';
import { bulkCapex, capexDoc, capexViewKeys, reportKeys, reportsApi, reportsTenant, ReportsFixture, reportUser } from './reports-helpers';
import { publishWorkflow } from './workflow-helpers';

const capex = (o: Record<string, unknown> = {}) => ({ source: { kind: 'doc', key: 'capex' }, columns: [{ field: 'number' }], ...o });

describe('reports: exports, schedules, dashboards', () => {
  let c: Ctx;
  let f: ReportsFixture;
  let r: ReturnType<typeof reportsApi>;

  const fileOf = async (tenantId: string, jobId: string) => {
    const job = await c.db.selectFrom('app.export_job').select(['file_id', 'status', 'row_count', 'error']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(job.status, job.error ?? '').toBe('ready');
    const files = c.app.get(FilesService);
    const row = await c.db.selectFrom('app.file_object').select(['storage_key', 'mime', 'filename', 'attached_to']).where('id', '=', job.file_id!).where('tenant_id', '=', tenantId).executeTakeFirstOrThrow();
    return { job, row, body: await files.storage.get(row.storage_key) };
  };
  const waitExport = async (id: string) => {
    await drainQueues(c, ['exports'], 60000);
    return mustOk(r.get(`/exports/${id}`));
  };

  beforeAll(async () => {
    c = await bootApp();
    await startWorkers(c);
    f = await reportsTenant(c);
    r = reportsApi(c, f.token);
    await bulkCapex(c, f, 10_000, 0, 'EX');
  });
  afterAll(async () => closeApp(c));

  describe('exports', () => {
    it('10k-row report → xlsx readable by exceljs, with a signed URL and notification', async () => {
      const rep = await mustOk(r.create({ key: 'all_capex', name: 'All capex', definition: capex({ columns: [{ field: 'number' }, { field: 'location.name' }, { field: 'total_amount' }, { field: 'doc_date' }], rowLimit: 100000 }) }), 201);
      const job = await mustOk(r.post('/exports', { kind: 'report', source: { reportId: rep.id }, format: 'xlsx' }), 201);
      expect(job.status).toBe('queued');
      const done = await waitExport(job.id);
      expect(done).toMatchObject({ status: 'ready', rowCount: 10000, name: 'All capex', source: { reportId: rep.id } });
      expect(done.fileUrl).toMatch(/\/files\/.+\/content\?/);
      const { body, row } = await fileOf(f.tenantId, job.id);
      expect(row.mime).toMatch(/spreadsheetml/);
      expect(row.attached_to).toMatchObject({ kind: 'export_job', id: job.id });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(body as unknown as ArrayBuffer);
      const ws = wb.worksheets[0]!;
      expect(ws.rowCount).toBe(10001);
      expect(ws.getRow(1).values).toEqual([undefined, 'No.', 'Location', 'Total amount', 'Date']);
      expect(typeof ws.getRow(2).getCell(3).value).toBe('number');
      const u = new URL(done.fileUrl, 'http://localhost');
      const content = await c.http.get(u.pathname + u.search);
      expect(content.status).toBe(200);
      const notes = await mustOk(r.get('/notifications'));
      expect(notes.data.some((n: { title: string; link: string }) => n.title === 'Your export is ready' && n.link === `/exports/${job.id}`)).toBe(true);
      const list = await mustOk(r.get('/exports'));
      expect(list[0].id).toBe(job.id);
    });

    it('csv export of a grouped report', async () => {
      const rep = await mustOk(r.create({ key: 'by_loc', name: 'By location', definition: capex({ columns: [{ field: 'location.name' }, { field: 'number', aggregate: 'count' }, { field: 'total_amount', aggregate: 'sum' }], groupBy: ['location.name'] }) }), 201);
      const job = await mustOk(r.post('/exports', { kind: 'report', source: { reportId: rep.id }, format: 'csv' }), 201);
      expect((await waitExport(job.id)).rowCount).toBe(3);
      const { body } = await fileOf(f.tenantId, job.id);
      const text = body.toString('utf8');
      expect(text.charCodeAt(0)).toBe(0xfeff);
      const lines = text.slice(1).trim().split('\r\n');
      expect(lines[0]).toBe('Location,No.,Total amount');
      expect(lines.slice(1).map(l => Number(l.split(',')[1])).reduce((a, b) => a + b, 0)).toBe(10000);
    });

    it('document list exports (both views) and master exports', async () => {
      await capexDoc(c, f, { location: f.pune, submit: true, lines: [{ qty: '2', est_rate: '10' }, { qty: '1', est_rate: '5', item: f.items[1] }] });
      const docJob = await mustOk(r.post('/exports', { kind: 'list', source: { scope: 'doc.capex', query: { q: 'CAPEX/' } }, format: 'csv' }), 201);
      expect((await waitExport(docJob.id)).rowCount).toBe(1);
      const docCsv = (await fileOf(f.tenantId, docJob.id)).body.toString('utf8');
      expect(docCsv).toContain('Number,Date,Status,Location,Total amount');
      const itemJob = await mustOk(r.post('/exports', { kind: 'list', source: { scope: 'doc.capex:item', query: { q: 'CAPEX/' } }, format: 'xlsx' }), 201);
      expect(await waitExport(itemJob.id)).toMatchObject({ rowCount: 2, name: 'Capex Requests — item-wise', source: { scope: 'doc.capex:item' } });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await fileOf(f.tenantId, itemJob.id)).body as unknown as ArrayBuffer);
      expect(wb.worksheets[0]!.getRow(1).getCell(5).value).toBe('Item');
      const mJob = await mustOk(r.post('/exports', { kind: 'master', source: { masterKey: 'item' }, format: 'csv' }), 201);
      expect((await waitExport(mJob.id)).rowCount).toBe(2);
      const mCsv = (await fileOf(f.tenantId, mJob.id)).body.toString('utf8');
      expect(mCsv).toContain('Category A');
      expect(mCsv.split('\r\n')[0]).toContain('Code,Name');
    });

    it('refuses unknown sources and missing permissions (PDF: reports.delivery.test.ts)', async () => {
      const rep = (await mustOk(r.get('/reports')))[0];
      expect((await r.post('/exports', { kind: 'report', source: { reportId: '00000000-0000-0000-0000-000000000001' }, format: 'csv' })).status).toBe(404);
      expect((await r.post('/exports', { kind: 'list', source: { scope: 'doc.nope' }, format: 'csv' })).status).toBe(404);
      expect((await r.post('/exports', { kind: 'list', source: { scope: 'drop table' }, format: 'csv' })).status).toBe(400);
      const viewer = await reportUser(c, f, ['reports:action.view', ...capexViewKeys]);
      const vr = reportsApi(c, viewer.token);
      expect((await vr.post('/exports', { kind: 'report', source: { reportId: rep.id }, format: 'csv' })).status).toBe(403);
      expect((await vr.post('/exports', { kind: 'master', source: { masterKey: 'item' }, format: 'csv' })).status).toBe(404);
      const job = await mustOk(vr.post('/exports', { kind: 'list', source: { scope: 'doc.capex', query: { status: 'draft' } }, format: 'csv' }), 201);
      expect((await r.get(`/exports/${job.id}`)).status).toBe(404); // only the requester sees a job
      expect((await vr.post('/exports', { kind: 'list', source: { scope: 'doc.capex', query: { 'f.x;drop': '1' } }, format: 'csv' })).status).toBe(400);
      await drainQueues(c, ['exports'], 60000);
    });

    it('expired exports are cleaned up after 7 days', async () => {
      const rep = await mustOk(r.create({ key: `small_${uid(6)}`, name: 'Small', definition: capex({ rowLimit: 5 }) }), 201);
      const job = await mustOk(r.post('/exports', { kind: 'report', source: { reportId: rep.id }, format: 'csv' }), 201);
      await waitExport(job.id);
      const { row } = await fileOf(f.tenantId, job.id);
      const svc = c.app.get(ExportsService);
      await svc.cleanup(new Date()); // not yet expired
      expect((await mustOk(r.get(`/exports/${job.id}`))).status).toBe('ready');
      await svc.cleanup(new Date(Date.now() + 8 * 86_400_000));
      const after = await mustOk(r.get(`/exports/${job.id}`));
      expect(after).toMatchObject({ status: 'expired', fileUrl: null });
      const fo = await c.db.selectFrom('app.file_object').select('is_deleted').where('storage_key', '=', row.storage_key).executeTakeFirstOrThrow();
      expect(fo.is_deleted).toBe(true);
      await expect(c.app.get(FilesService).storage.get(row.storage_key)).rejects.toThrow();
    });

    it('a failing job is marked failed and the requester told', async () => {
      const rep = await mustOk(r.create({ key: `gone_${uid(6)}`, name: 'Gone', definition: capex() }), 201);
      const job = await mustOk(r.post('/exports', { kind: 'report', source: { reportId: rep.id }, format: 'csv' }), 201);
      // the report disappears before the worker runs it
      await c.db.deleteFrom('app.report_def').where('id', '=', rep.id).execute();
      expect(await c.app.get(ExportsService).process(f.tenantId, job.id)).toBe('failed');
      expect((await mustOk(r.get(`/exports/${job.id}`))).status).toBe('failed');
      await drainQueues(c, ['exports'], 60000);
    });
  });

  describe('schedules', () => {
    it('fires on the tenant-timezone cron (fake clock) and delivers in-app', async () => {
      const rep = await mustOk(r.create({ key: `daily_${uid(6)}`, name: 'Daily capex', definition: capex({ rowLimit: 10 }) }), 201);
      const other = await reportUser(c, f, ['dashboards:action.view']);
      const sched = await mustOk(r.post(`/reports/${rep.id}/schedules`, { cron: '0 9 * * *', format: 'csv', recipients: [{ type: 'user', userId: other.userId }, { type: 'email', address: 'boss@example.test' }] }), 201);
      const next = new Date(sched.nextRunAt);
      expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(next)).toBe('09:00');
      expect((await mustOk(r.get(`/reports/${rep.id}/schedules`))).map((s: { id: string }) => s.id)).toEqual([sched.id]);
      const svc = c.app.get(SchedulesService);
      expect((await svc.scan(new Date(next.getTime() - 60_000))).fired).toBe(0);
      expect((await svc.scan(next)).fired).toBe(1);
      expect((await svc.scan(next)).fired).toBe(0); // advanced: not twice
      await drainQueues(c, ['exports'], 60000);
      const jobs = await c.db.selectFrom('app.export_job').select(['id', 'status', 'source']).where('tenant_id', '=', f.tenantId)
        .where(eb => eb(eb.ref('source'), '@>', JSON.stringify({ scheduleId: sched.id }) as never)).execute();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.status).toBe('ready');
      const theirs = await mustOk(reportsApi(c, other.token).get('/notifications'));
      expect(theirs.data.some((n: { title: string }) => n.title === 'Scheduled report "Daily capex" is ready')).toBe(true);
      const row = (await mustOk(r.get(`/reports/${rep.id}/schedules`)))[0];
      expect(new Date(row.nextRunAt).getTime() - next.getTime()).toBe(86_400_000);
      expect(row.lastRunAt).toBe(next.toISOString());
      expect((await svc.scan(new Date(next.getTime() + 86_400_000))).fired).toBe(1);
      await drainQueues(c, ['exports'], 60000);
      expect((await r.del(`/reports/${rep.id}/schedules/${sched.id}`)).status).toBe(204);
      expect((await svc.scan(new Date(next.getTime() + 3 * 86_400_000))).fired).toBe(0);
    });

    it('validates cron, format and recipients; needs the schedule key', async () => {
      const rep = (await mustOk(r.get('/reports')))[0];
      expect((await r.post(`/reports/${rep.id}/schedules`, { cron: '99 9 * * *', recipients: [{ type: 'email', address: 'a@b.test' }] })).status).toBe(400);
      expect((await r.post(`/reports/${rep.id}/schedules`, { cron: '0 9 * *', recipients: [{ type: 'email', address: 'a@b.test' }] })).status).toBe(400);
      // PDF is a valid schedule format now (templates table renderer); inactive so it never fires in this suite.
      expect((await r.post(`/reports/${rep.id}/schedules`, { cron: '0 9 * * *', format: 'pdf', isActive: false, recipients: [{ type: 'email', address: 'a@b.test' }] })).status).toBe(201);
      expect((await r.post(`/reports/${rep.id}/schedules`, { cron: '0 9 * * *', recipients: [{ type: 'user', userId: '00000000-0000-0000-0000-000000000001' }] })).status).toBe(400);
      const viewer = await reportUser(c, f, ['reports:action.view']);
      expect((await reportsApi(c, viewer.token).post(`/reports/${rep.id}/schedules`, { cron: '0 9 * * *', recipients: [{ type: 'email', address: 'a@b.test' }] })).status).toBe(403);
    });

    it('a schedule whose owner lost access notifies instead of exporting', async () => {
      const u = await reportUser(c, f, [...reportKeys, ...capexViewKeys]);
      const ur = reportsApi(c, u.token);
      const rep = await mustOk(ur.create({ key: `own_${uid(6)}`, name: 'Owned', definition: capex() }), 201);
      const sched = await mustOk(ur.post(`/reports/${rep.id}/schedules`, { cron: '*/5 * * * *', recipients: [{ type: 'user', userId: u.userId }] }), 201);
      await mustOk(r.put(`/roles/${u.roleId}/permissions/tabs/reports`, { actions: ['reports:action.view'], views: [] }));
      const fired = await c.app.get(SchedulesService).scan(new Date(new Date(sched.nextRunAt).getTime()));
      expect(fired.fired).toBe(0);
      const notes = await mustOk(ur.get('/notifications'));
      expect(notes.data.some((n: { title: string }) => n.title === 'A scheduled report could not run')).toBe(true);
    });
  });

  describe('dashboards', () => {
    it('"mine" falls back to My work; widgets return inbox and document counts with links', async () => {
      const mine = await mustOk(r.get('/dashboards/mine'));
      expect(mine).toMatchObject({ name: 'My work', builtin: 'my_work' });
      const docs = await mustOk(r.post('/dashboards/widgets/docs/data', { dashboardId: mine.id }));
      const capexCounts = docs.types.find((t: { docTypeKey: string }) => t.docTypeKey === 'capex');
      expect(capexCounts.total).toBeGreaterThanOrEqual(10_000);
      expect(capexCounts.counts.find((x: { statusKey: string }) => x.statusKey === 'approved')).toMatchObject({ link: '/docs/capex?status=approved' });
      const inbox = await mustOk(r.post('/dashboards/widgets/inbox/data', { dashboardId: mine.id }));
      expect(inbox).toMatchObject({ type: 'inbox_counts', total: 0, link: '/approvals' });
      expect((await r.put(`/dashboards/${mine.id}`, { name: 'x', widgets: [] })).status).toBe(409);
      expect((await r.post('/dashboards/widgets/nope/data', { dashboardId: mine.id })).status).toBe(404);
    });

    it('inbox counts come from the workflow inbox', async () => {
      const g = await reportsTenant(c);
      const gr = reportsApi(c, g.token);
      await publishWorkflow(c, g.token, 'capex', { granularity: 'line', stages: [{ key: 'hod', name: 'HOD approval', actors: [{ type: 'users', userIds: [g.adminId] }], allowSelfApproval: true }] });
      await capexDoc(c, g, { location: g.pune, submit: true, lines: [{ qty: '1', est_rate: '10' }] });
      const mine = await mustOk(gr.get('/dashboards/mine'));
      const inbox = await mustOk(gr.post('/dashboards/widgets/inbox/data', { dashboardId: mine.id }));
      expect(inbox.total).toBe(1);
      expect(inbox.byType[0]).toMatchObject({ docTypeKey: 'capex', stageKey: 'hod', count: 1 });
    });

    it('custom dashboards: kpi with delta, chart, table, role default, sharing and access', async () => {
      const rep = await mustOk(r.create({
        key: 'cap_month', name: 'Capex by month', definition: capex({
          columns: [{ field: 'doc_date.month' }, { field: 'total_amount', aggregate: 'sum' }], groupBy: ['doc_date.month'], datePreset: 'this_fy',
          chart: { type: 'bar', x: 'doc_date.month', series: ['total_amount'] },
        }),
      }), 201);
      const role = await mustOk(r.post('/roles', { key: `dash_${uid(6)}`, name: 'Dash role' }), 201);
      const dash = await mustOk(r.post('/dashboards', {
        name: 'Overview', sharedRoleIds: [role.id], isDefaultForRoleIds: [role.id],
        widgets: [
          { id: 'k', type: 'kpi', title: 'Capex this FY', reportId: rep.id, x: 0, y: 0, w: 4, h: 2 },
          { id: 'ch', type: 'chart', title: 'By month', reportId: rep.id, x: 4, y: 0, w: 8, h: 4 },
          { id: 't', type: 'table', title: 'Table', reportId: rep.id, params: { limit: 3 }, x: 0, y: 4, w: 12, h: 4 },
          { id: 'dc', type: 'doc_counts', title: 'Capex', docTypeKey: 'capex', x: 0, y: 8, w: 4, h: 2 },
        ],
      }), 201);
      const kpi = await mustOk(r.post('/dashboards/widgets/k/data', { dashboardId: dash.id }));
      expect(kpi.type).toBe('kpi');
      expect(kpi.value).toBeGreaterThan(0);
      expect(typeof kpi.previous).toBe('number');
      expect(kpi.delta).toBe(Math.round((kpi.value - kpi.previous) * 100) / 100);
      const chart = await mustOk(r.post('/dashboards/widgets/ch/data', { dashboardId: dash.id }));
      expect(chart.chart.series[0].name).toBe('Total amount');
      expect(chart.chart.x.length).toBe(chart.chart.series[0].values.length);
      const table = await mustOk(r.post('/dashboards/widgets/t/data', { dashboardId: dash.id }));
      expect(table.rows.length).toBeLessThanOrEqual(3);
      const dc = await mustOk(r.post('/dashboards/widgets/dc/data', { dashboardId: dash.id }));
      expect(dc.types).toHaveLength(1);

      expect((await r.post('/dashboards', { name: 'bad', widgets: [{ id: 'a', type: 'kpi', title: 'x', x: 0, y: 0, w: 1, h: 1 }] })).status).toBe(400);
      expect((await r.post('/dashboards', { name: 'dup', widgets: [{ id: 'a', type: 'inbox_counts', title: 'x', x: 0, y: 0, w: 1, h: 1 }, { id: 'a', type: 'inbox_counts', title: 'y', x: 0, y: 0, w: 1, h: 1 }] })).status).toBe(400);

      // a member of the role gets it as "mine"; report widgets need report + source access
      const member = await reportUser(c, f, ['dashboards:action.view']);
      await mustOk(r.put(`/users/${member.userId}`, { roleIds: [member.roleId, role.id], version: (await mustOk(r.get(`/users/${member.userId}`))).version }));
      const mr = reportsApi(c, member.token);
      expect((await mustOk(mr.get('/dashboards/mine'))).id).toBe(dash.id);
      expect((await mr.post('/dashboards/widgets/k/data', { dashboardId: dash.id })).status).toBe(403);
      expect((await mr.post('/dashboards/widgets/dc/data', { dashboardId: dash.id })).status).toBe(404);
      expect((await mr.put(`/dashboards/${dash.id}`, { name: 'x', widgets: [] })).status).toBe(403);
      // outsider: not visible at all
      const outsider = await reportUser(c, f, ['dashboards:action.view', 'dashboards:action.edit']);
      const or = reportsApi(c, outsider.token);
      expect((await or.get(`/dashboards/${dash.id}`)).status).toBe(404);
      expect((await or.post('/dashboards/widgets/k/data', { dashboardId: dash.id })).status).toBe(404);
      const own = await mustOk(or.post('/dashboards', { name: 'Mine', widgets: [{ id: 'i', type: 'inbox_counts', title: 'Inbox', x: 0, y: 0, w: 3, h: 2 }] }), 201);
      expect((await mustOk(or.get('/dashboards/mine'))).id).toBe(own.id);
      expect((await mustOk(or.get('/dashboards'))).map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([own.id]));
      const upd = await mustOk(or.put(`/dashboards/${own.id}`, { name: 'Mine v2', widgets: [] }));
      expect(upd).toMatchObject({ name: 'Mine v2', version: 2 });
      expect((await or.del(`/dashboards/${own.id}`)).status).toBe(204);
      expect((await r.del(`/dashboards/${dash.id}`)).status).toBe(204);
    });
  });

  it('engine sources contributed by other modules are registered (and feature-gated)', async () => {
    const keys = registeredSources().map(s => s.key);
    expect(keys).toEqual(expect.arrayContaining(['documents', 'workflow_pending', 'audit', 'users', 'vendor_quote', 'po_followup']));
    expect((await r.preview({ source: { kind: 'engine', key: 'vendor_quote' }, columns: [{ field: 'vendor.name' }] })).status).toBe(404); // no vendor_quotes feature
  });
});

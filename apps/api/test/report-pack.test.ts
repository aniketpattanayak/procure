/**
 * Standard report pack (system reports + Procurement / Store overview dashboards) on the seeded demo data: the demo
 * seed (src/seed/demo.ts) runs in-process against the test DB, then every pack report runs as the acme admin and is
 * checked against known seed values (indent IND/26-27/00001, quotes, PO/26-27/00002 with two GRNs + RTV, opening
 * balances, transfer, issue/return, re-order rules). Also: feature / permission gating, field access adaptation,
 * data scope, installer idempotency and globex isolation.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/core/entitlements.service';
import { installReportBuiltins } from '../src/modules/reports/builtins';
import { PACK_DASHBOARDS, PACK_REPORTS } from '../src/modules/reports/pack/definitions';
import { addDays, localDate } from '../src/modules/reports/presets';
import { runDemoSeed } from '../src/seed/demo';
import { api, mustOk, userWithKeys } from './forms-helpers';
import { bootApp, closeApp, Ctx, superAdmin, tenantLogin, tenantWithAdmin } from './helpers';

type Result = { columns: { field: string; label: string }[]; rows: unknown[][]; totals: unknown[] | null; groups?: { key: unknown[]; rowCount: number }[]; chart?: { x: unknown[]; series: { name: string; values: number[] }[] } };
type ReportRow = { id: string; key: string; kind: string; name: string; definition: Record<string, unknown> };

/** Platform-wide rows the demo seed may add (cleaned up after the suite). */
async function platformRows(c: Ctx) {
  return {
    creds: (await c.db.selectFrom('platform.provider_credential').select('id').where('tenant_id', 'is', null).execute()).map(r => r.id),
    templates: (await c.db.selectFrom('platform.whatsapp_template').select('id').execute()).map(r => r.id),
  };
}

describe('standard report pack', () => {
  let platformBefore: Awaited<ReturnType<typeof platformRows>>;
  let c: Ctx;
  let acme: { id: string; admin: string; token: string };
  let globexToken: string;
  let list: ReportRow[];
  const today = localDate(new Date(), 'Asia/Kolkata');
  /** The Maharashtra vendor's approved PO (its number depends on which PO the seed approved first). */
  const PO_NO = expect.stringMatching(/^PO\/\d{2}-\d{2}\/\d{5}$/);
  const PROC = PACK_REPORTS.filter(r => r.group === 'procurement').map(r => r.key);
  const STOCK = PACK_REPORTS.filter(r => r.group === 'stock').map(r => r.key);

  const run = async (key: string, params: Record<string, unknown> = {}, token = acme.token, reports = list): Promise<Result> => {
    const r = reports.find(x => x.key === key);
    if (!r) throw new Error(`report ${key} not listed`);
    return mustOk(api(c, token).post(`/reports/${r.id}/run`, { params }));
  };
  const node = async (code: string) => (await c.db.selectFrom('app.location_node').select('id').where('tenant_id', '=', acme.id).where('code', '=', code).executeTakeFirstOrThrow()).id;
  const item = async (code: string) => (await sql<{ id: string }>`select r.id from app.master_record r join app.master_def d on d.id = r.master_id
    where r.tenant_id = ${acme.id} and d.key = 'item' and r.code = ${code}::citext`.execute(c.db)).rows[0]!.id;
  const bump = () => c.app.get(EntitlementsService).bumpPermissions(acme.id);

  /** An acme user holding exactly `keys`, scoped to a node (with descendants) or all nodes. */
  const acmeUser = async (keys: string[], scopeNode?: string) => {
    const u = await userWithKeys(c, acme.token, 'acme', keys);
    await mustOk(api(c, acme.token).put(`/roles/${u.roleId}/scope`, { entries: [scopeNode ? { nodeId: scopeNode } : { allNodes: true }] }));
    await bump();
    return u;
  };
  const PO_VIEW = ['doc.po:action.view', ...['approved', 'partially_received', 'received', 'waiting_approve', 'closed'].map(v => `doc.po:view.${v}`)];
  const STOCK_VIEW = ['stock:action.view', 'stock:view.available', 'stock:view.quarantine', 'stock:view.rejected'];
  const VIEW = ['reports:action.view', 'dashboards:action.view'];

  beforeAll(async () => {
    // Seed first: the seed's own app contexts register report sources too (module-level registry); booting the test
    // app afterwards makes its instances the registered ones.
    const db = (await bootApp());
    platformBefore = await platformRows(db);
    await closeApp(db);
    await runDemoSeed();
    c = await bootApp();
    const t = await c.db.selectFrom('platform.tenant').select('id').where('code', '=', 'acme').executeTakeFirstOrThrow();
    const admin = await tenantLogin(c, 'acme', 'admin@acme.test', 'Admin@12345');
    acme = { id: t.id, admin: admin.result.principal.userId, token: admin.token };
    globexToken = (await tenantLogin(c, 'globex', 'admin@globex.test', 'Admin@12345')).token;
    list = await mustOk(api(c, acme.token).get('/reports'));
  }, 600_000);

  afterAll(async () => {
    // The demo seed also writes platform-wide rows (log providers as platform defaults, WhatsApp templates); other
    // suites share this test DB and expect none, so retire what the seed added.
    const now = await platformRows(c);
    const newCreds = now.creds.filter(id => !platformBefore.creds.includes(id));
    const newTemplates = now.templates.filter(id => !platformBefore.templates.includes(id));
    if (newCreds.length) await c.db.updateTable('platform.provider_credential').set({ is_active: false }).where('id', 'in', newCreds).execute();
    if (newTemplates.length) {
      await c.db.deleteFrom('platform.tenant_whatsapp_template').where('template_id', 'in', newTemplates).execute();
      await c.db.updateTable('platform.whatsapp_template').set({ is_active: false }).where('id', 'in', newTemplates).execute();
    }
    await closeApp(c);
  });

  describe('installer', () => {
    it('installs every pack report as a read-only, cloneable system report', async () => {
      const keys = list.filter(r => r.kind === 'builtin').map(r => r.key);
      expect(keys).toEqual(expect.arrayContaining([...PROC, ...STOCK]));
      expect(PROC).toHaveLength(8);
      expect(STOCK).toHaveLength(7);
      const a = api(c, acme.token);
      const vp = list.find(r => r.key === 'builtin_vendor_performance')!;
      expect((await a.put(`/reports/${vp.id}`, { key: vp.key, name: 'x', definition: vp.definition })).status).toBe(409);
      expect((await a.del(`/reports/${vp.id}`)).status).toBe(409);
      // copy to customise: same definition under a custom key runs the same
      const copy = await mustOk(a.post('/reports', { key: 'my_vendor_perf', name: 'My vendor performance', definition: vp.definition }), 201);
      expect(copy.kind).toBe('custom');
      expect((await mustOk(a.post(`/reports/${copy.id}/run`, {}))).rows).toEqual((await run('builtin_vendor_performance')).rows);
    });

    it('is idempotent and restores tampered definitions; dashboards keep their ids', async () => {
      const count = async () => ({
        reports: (await c.db.selectFrom('app.report_def').select(['id', 'key', 'name']).where('tenant_id', '=', acme.id).where('kind', '=', 'builtin').orderBy('key').execute()),
        dashboards: (await c.db.selectFrom('app.dashboard_def').select(['id', 'name']).where('tenant_id', '=', acme.id).where(sql<boolean>`layout ? 'builtin'`).orderBy('name').execute()),
      });
      const before = await count();
      await c.db.updateTable('app.report_def').set({ name: 'Tampered' }).where('tenant_id', '=', acme.id).where('key', '=', 'builtin_po_vs_grn').execute();
      for (let i = 0; i < 2; i++) await c.db.transaction().execute(tx => installReportBuiltins(tx, acme.id));
      const after = await count();
      expect(after).toEqual(before);
      expect(after.reports.find(r => r.key === 'builtin_po_vs_grn')!.name).toBe('PO vs GRN');
      expect(after.dashboards.map(d => d.name)).toEqual(['My work', 'Procurement overview', 'Store overview']);
    });
  });

  describe('procurement reports on the seed', () => {
    it('indent status & ageing', async () => {
      const r = await run('builtin_indent_ageing');
      expect(r.rows).toHaveLength(5);
      expect(new Set(r.rows.map(x => x[0]))).toEqual(new Set(['0–7 days']));
      expect(r.rows.every(x => x[1] === 'IND/26-27/00001' && x[4] === 'Approved')).toBe(true);
      const plate = r.rows.find(x => x[6] === 'ITM-00001')!;
      expect(plate.slice(8)).toEqual(['700', '700', '700', '280', '0']);
      expect(r.totals!.slice(8)).toEqual(['1700', '1700', '700', '280', '1000']);
      expect(r.groups).toEqual([{ key: ['0–7 days'], rowCount: 5, totals: expect.any(Array) }]);
      expect((await run('builtin_indent_ageing', { age: 'e_over_60' })).rows).toEqual([]);
    });

    it('pending approvals by stage & approver: procurement types only, stage-key holders as approvers', async () => {
      const r = await run('builtin_proc_pending_approvals');
      expect(r.rows).toEqual([['Hema HOD', 'Purchase Order', 'PO approval', 1, expect.any(String)]]);
      expect(r.chart!.x).toEqual(['Hema HOD']);
    });

    it('vendor quote comparison history', async () => {
      const r = await run('builtin_quote_comparison');
      expect(r.rows).toHaveLength(6);
      const line1 = r.rows.filter(x => x[1] === '1').map(x => [x[4], x[7], x[8], x[9], x[10]]);
      expect(line1).toEqual([
        ['Coromandel Metals', '48.50', '48.50', '0', '1'],
        ['Deccan Steel Traders', '50.00', '48.50', '3.09', '2'],
        ['Mysore Industrial Supplies', '51.00', '48.50', '5.15', '3'],
      ]);
      expect((await run('builtin_quote_comparison', { vendor: 'Coromandel Metals' })).rows.map(x => x[7])).toEqual(['48.50', '242.00']);
    });

    it('rate history by item & vendor', async () => {
      const r = await run('builtin_rate_history');
      expect(r.rows).toEqual([
        ['ITM-00001', 'MS Plate 6 mm', 'Coromandel Metals', today.slice(0, 7), '48.50', '48.50', '48.50', '400', 1],
        ['ITM-00001', 'MS Plate 6 mm', 'Deccan Steel Traders', today.slice(0, 7), '50.00', '50.00', '50.00', '300', 1],
      ]);
    });

    it('PO pending delivery (ordered − received, overdue flag)', async () => {
      const r = await run('builtin_po_pending_delivery');
      const overdue = today > '2026-11-12';
      expect(r.rows).toEqual([[
        PO_NO, today, 'Deccan Steel Traders', 'Pune Plant', 'ITM-00001', 'MS Plate 6 mm', '2026-11-12', '300', '280', '20', '1000.00', overdue, expect.any(String),
      ]]);
      expect((await run('builtin_po_pending_delivery', { overdue: !overdue })).rows).toEqual([]);
    });

    it('PO vs GRN (ordered / received / accepted / rejected / returned per line)', async () => {
      const r = await run('builtin_po_vs_grn');
      expect(r.rows).toEqual([[PO_NO, '1', today, 'Deccan Steel Traders', 'ITM-00001', 'MS Plate 6 mm', '300', '280', '230', '50', '50', '20', '2', today]]);
    });

    it('vendor performance (weighted on-time %, rejection %, lead time)', async () => {
      const r = await run('builtin_vendor_performance');
      expect(r.rows).toEqual([['Deccan Steel Traders', 1, 1, '300', '280', '50', '100', '17.8571', '0']]);
      expect(r.chart!.series.map(s => s.name)).toEqual(['On-time %', 'Rejection %']);
      // ratio measures are averaged as ratios of sums and cannot be summed
      const bad = await api(c, acme.token).post('/reports/preview', {
        definition: { source: { kind: 'engine', key: 'purchase_lines' }, columns: [{ field: 'vendor.name' }, { field: 'rejection_pct', aggregate: 'sum' }], groupBy: ['vendor.name'] },
      });
      expect(bad.status).toBe(400);
    });

    it('purchase value by vendor / item / location / month', async () => {
      const r = await run('builtin_purchase_value');
      expect(r.rows).toEqual([[today.slice(0, 7), 'Deccan Steel Traders', 'Pune Plant', 'MS Plate 6 mm', '15000.00', '14000.00', '300']]);
      expect(r.chart).toEqual({ x: [today.slice(0, 7)], series: [{ name: 'Deccan Steel Traders', values: [15000] }] });
    });
  });

  describe('stock reports on the seed', () => {
    it('stock summary by location', async () => {
      const r = await run('builtin_stock_summary');
      expect(r.rows).toEqual(expect.arrayContaining([
        ['Main Store', 'ITM-00001', 'MS Plate 6 mm', 'Available', '62500.00', '1000'],
        ['Bin A1', 'ITM-00001', 'MS Plate 6 mm', 'Available', '12500.00', '200'],
        ['Pune Plant', 'ITM-00001', 'MS Plate 6 mm', 'Available', '9000.00', '180'],
        ['Main Store', 'ITM-00005', 'Cotton Waste', 'Available', '4950.00', '90'],
      ]));
      expect(r.totals!.slice(4)).toEqual(['164060.00', '2820']);
      expect((await run('builtin_stock_summary', { location: await node('PUNE-MAIN') })).totals!.slice(4)).toEqual(['155060.00', '2640']);
    });

    it('stock ledger (item movement)', async () => {
      const all = await run('builtin_stock_ledger', { datePreset: 'this_fy' });
      expect(all.rows).toHaveLength(16);
      const plate = await run('builtin_stock_ledger', { datePreset: 'this_fy', item: await item('ITM-00001') });
      expect(plate.rows).toHaveLength(10);
      expect(plate.rows.filter(x => x[3] === 'Opening')).toHaveLength(1);
      // net of every ITM-00001 movement (all locations and statuses) = its balances: 1000 + 200 + 180 + 0
      expect(plate.rows.reduce((s, x) => s + Number(x[9]) - Number(x[10]), 0)).toBe(1380);
    });

    it('item movement summary: opening / in / out / closing for any period', async () => {
      const r = await run('builtin_item_movement_summary', { dateFrom: today, dateTo: today });
      const row = (loc: string, status = 'Available') => r.rows.find(x => x[0] === 'ITM-00001' && x[2] === loc && x[3] === status)!.slice(4, 8);
      expect(row('Main Store')).toEqual(['1200', '0', '200', '1000']);
      expect(row('Bin A1')).toEqual(['0', '200', '0', '200']);
      expect(row('Pune Plant')).toEqual(['0', '300', '120', '180']);
      expect(row('Pune Plant', 'Quarantine / blocked')).toEqual(['0', '50', '50', '0']);
      expect(r.totals!.slice(4, 8)).toEqual(['2640', '600', '420', '2820']);
      // a period ending yesterday: only the opening balances, nothing in or out
      const y = await run('builtin_item_movement_summary', { dateFrom: addDays(today, -7), dateTo: addDays(today, -1) });
      expect(y.totals!.slice(4, 8)).toEqual(['2640', '0', '0', '2640']);
      expect((await api(c, acme.token).post(`/reports/${list.find(x => x.key === 'builtin_item_movement_summary')!.id}/run`, { params: { dateFrom: today } })).status).toBe(400);
    });

    it('consumption by department & location (issues net of returns)', async () => {
      const r = await run('builtin_consumption');
      expect(r.rows).toEqual([['Maintenance', 'Pune Plant', 'ITM-00001', 'MS Plate 6 mm', '70', '20', '50', '2500.00']]);
    });

    it('re-order / below-minimum', async () => {
      const r = await run('builtin_reorder');
      expect(r.rows).toEqual([
        ['ITM-00005', 'Cotton Waste', 'Main Store', '90', '100', '150', null, '10', '150', true, true],
        ['ITM-00001', 'MS Plate 6 mm', 'Main Store', '1200', '500', '1000', '2000', '0', '0', false, false],
      ]);
      expect((await run('builtin_reorder', { below_min: true })).rows.map(x => x[0])).toEqual(['ITM-00005']);
    });

    it('expiring batches', async () => {
      expect((await run('builtin_expiring_batches')).rows).toEqual([]);
      const batch = c.db.updateTable('app.stock_batch').where('tenant_id', '=', acme.id).where('batch_no', '=', 'HT-2611-B');
      await batch.set({ expiry_date: addDays(today, 20) }).execute();
      try {
        const r = await run('builtin_expiring_batches');
        expect(r.rows).toEqual([[addDays(today, 20), '20', 'Within 30 days', 'ITM-00001', 'MS Plate 6 mm', 'HT-2611-B', 'Pune Plant', 'Available', '80', '4000.00']]);
        expect((await run('builtin_expiring_batches', { within_days: 10 })).rows).toEqual([]);
      } finally {
        await batch.set({ expiry_date: null }).execute();
      }
    });

    it('quarantine & rejected stock', async () => {
      expect((await run('builtin_quarantine_rejected')).rows).toEqual([]); // the seed returned its 50 kg to the vendor
      const q = () => c.db.updateTable('app.stock_balance').where('tenant_id', '=', acme.id).where('stock_status', '=', 'quarantine');
      await q().set({ qty: '12', value: '600' }).execute();
      try {
        const r = await run('builtin_quarantine_rejected');
        expect(r.rows.map(x => x.slice(0, 7))).toEqual([['Quarantine / blocked', 'ITM-00001', 'MS Plate 6 mm', 'HT-2611-A', 'Pune Plant', '12', '600.00']]);
      } finally {
        await q().set({ qty: '0', value: '0' }).execute();
      }
    });
  });

  describe('dashboards', () => {
    it('Procurement and Store overview widgets return data; role defaults come from the roles\' tabs', async () => {
      const a = api(c, acme.token);
      const dashes = await mustOk(a.get('/dashboards'));
      const byName = (n: string) => dashes.find((d: { name: string }) => d.name === n);
      const proc = byName('Procurement overview');
      const store = byName('Store overview');
      expect(proc).toMatchObject({ builtin: 'procurement_overview', canEdit: false });
      expect(store.widgets.map((w: { id: string }) => w.id)).toEqual(PACK_DASHBOARDS[1]!.widgets.map(w => w.id));
      const roles = await c.db.selectFrom('app.role').select(['id', 'key']).where('tenant_id', '=', acme.id).execute();
      const roleId = (k: string) => roles.find(r => r.key === k)!.id;
      expect(proc.isDefaultForRoleIds).toEqual(expect.arrayContaining([roleId('buyer'), roleId('approver')]));
      expect(store.isDefaultForRoleIds).toEqual(expect.arrayContaining([roleId('store_keeper'), roleId('approver')]));
      const data = (d: { id: string }, w: string) => mustOk(a.post(`/dashboards/widgets/${w}/data`, { dashboardId: d.id }));
      expect(await data(proc, 'po_value')).toMatchObject({ type: 'kpi', value: 15000, label: 'Ordered value' });
      expect((await data(proc, 'pending_delivery')).rows).toHaveLength(1);
      expect((await data(proc, 'vendor_perf')).chart.series[0]).toEqual({ name: 'On-time %', values: [100] });
      expect((await data(proc, 'pos')).types[0]).toMatchObject({ docTypeKey: 'po', total: 2 });
      expect(await data(store, 'stock_value')).toMatchObject({ type: 'kpi', value: 164060, label: 'Value' });
      expect((await data(store, 'below_min')).rows.map((x: unknown[]) => x[0])).toEqual(['ITM-00005']);
      expect((await data(store, 'consumption')).chart).toEqual({ x: ['Maintenance'], series: [{ name: 'Pune Plant', values: [50] }] });
      // "mine": a company-built role default (seeded "Approver overview") wins over the pack
      expect((await mustOk(a.get('/dashboards/mine'))).name).toBe('Approver overview');
      const approver = await tenantLogin(c, 'acme', 'approver@acme.test', 'Approve@12345');
      expect((await mustOk(api(c, approver.token).get('/dashboards/mine'))).name).toBe('Approver overview');
    });

    it('a stock-only viewer: Store overview by default, stock reports only, no value without view_value', async () => {
      const u = await acmeUser([...VIEW, ...STOCK_VIEW]);
      const a = api(c, u.token);
      const mine = await mustOk(a.get('/dashboards/mine'));
      expect(mine.name).toBe('Store overview');
      expect(mine.widgets.map((w: { id: string }) => w.id)).toEqual(['stock_value', 'inbox', 'below_min', 'consumption', 'expiring', 'quarantine']); // no grn / issue list access
      expect((await mustOk(a.get('/dashboards'))).map((d: { name: string }) => d.name)).not.toContain('Procurement overview');
      const theirs: ReportRow[] = await mustOk(a.get('/reports'));
      const keys = theirs.filter(r => r.kind === 'builtin').map(r => r.key);
      expect(keys).toEqual(expect.arrayContaining(STOCK));
      expect(keys.filter(k => PROC.includes(k))).toEqual([]);
      // field access: value columns drop out of the system definitions instead of failing
      const sum = await run('builtin_stock_summary', {}, u.token, theirs);
      expect(sum.columns.map(x => x.field)).toEqual(['location.name', 'item.code', 'item.name', 'status', 'qty']);
      expect(sum.totals).toEqual([null, null, null, null, '2820']);
      expect(await mustOk(a.post('/dashboards/widgets/stock_value/data', { dashboardId: mine.id }))).toMatchObject({ value: 2820, label: 'Quantity' });
      expect((await run('builtin_consumption', {}, u.token, theirs)).rows).toEqual([['Maintenance', 'Pune Plant', 'ITM-00001', 'MS Plate 6 mm', '70', '20', '50']]);
      // a procurement report id is not visible to them
      const po = list.find(r => r.key === 'builtin_po_vs_grn')!;
      expect((await a.get(`/reports/${po.id}`)).status).toBe(404);
      expect((await a.post(`/reports/${po.id}/run`, {})).status).toBe(404);
    });

    it('a PO viewer gets Procurement overview; no reports key → no reports', async () => {
      const u = await acmeUser([...VIEW, ...PO_VIEW]);
      const mine = await mustOk(api(c, u.token).get('/dashboards/mine'));
      expect(mine.name).toBe('Procurement overview');
      expect(mine.widgets.map((w: { id: string }) => w.id)).toEqual(['po_value', 'inbox', 'pos', 'value_chart', 'vendor_perf', 'pending_delivery']);
      const keys = (await mustOk(api(c, u.token).get('/reports'))).filter((r: ReportRow) => r.kind === 'builtin').map((r: ReportRow) => r.key);
      expect(keys).toEqual(expect.arrayContaining(['builtin_po_pending_delivery', 'builtin_po_vs_grn', 'builtin_vendor_performance', 'builtin_rate_history', 'builtin_purchase_value']));
      expect(keys).not.toContain('builtin_indent_ageing');
      expect(keys).not.toContain('builtin_stock_summary');
      const indenter = await tenantLogin(c, 'acme', 'indenter@acme.test', 'Indent@12345');
      expect((await api(c, indenter.token).get('/reports')).status).toBe(403);
    });
  });

  describe('gating, scope and isolation', () => {
    it('data scope applies to pack sources', async () => {
      const chennai = await acmeUser([...VIEW, ...PO_VIEW, ...STOCK_VIEW, 'stock:action.view_value'], await node('CHENNAI'));
      const pune = await acmeUser([...VIEW, ...PO_VIEW, ...STOCK_VIEW, 'stock:action.view_value'], await node('PUNE-MAIN'));
      const lists = { chennai: await mustOk(api(c, chennai.token).get('/reports')), pune: await mustOk(api(c, pune.token).get('/reports')) };
      expect((await run('builtin_po_pending_delivery', {}, chennai.token, lists.chennai)).rows).toEqual([]);
      expect((await run('builtin_stock_summary', {}, chennai.token, lists.chennai)).rows).toEqual([]);
      expect((await run('builtin_consumption', {}, chennai.token, lists.chennai)).rows).toEqual([]);
      // Main Store and its bins only: no Pune Plant receipts, POs (raised at Pune Plant) out of scope
      expect((await run('builtin_po_vs_grn', {}, pune.token, lists.pune)).rows).toEqual([]);
      const s = await run('builtin_stock_summary', {}, pune.token, lists.pune);
      expect(s.totals!.slice(4)).toEqual(['155060.00', '2640']);
      expect(new Set(s.rows.map(x => x[0]))).toEqual(new Set(['Main Store', 'Bin A1']));
      expect((await run('builtin_reorder', {}, pune.token, lists.pune)).rows).toHaveLength(2);
    });

    it('feature gating: a tenant without `store` gets no stock reports or Store overview', async () => {
      const sa = await superAdmin(c);
      const t = await tenantWithAdmin(c, sa.token, { features: ['indent', 'purchase', 'reports'], limits: { max_users: 5 } });
      const a = api(c, t.admin.token);
      const keys = (await mustOk(a.get('/reports'))).filter((r: ReportRow) => r.kind === 'builtin').map((r: ReportRow) => r.key);
      expect(keys.filter((k: string) => STOCK.includes(k))).toEqual([]);
      expect(keys).toEqual(expect.arrayContaining(['builtin_po_vs_grn', 'builtin_indent_ageing']));
      expect(keys).not.toContain('builtin_quote_comparison'); // no vendor_quotes feature
      const names = (await mustOk(a.get('/dashboards'))).map((d: { name: string }) => d.name);
      expect(names).toContain('Procurement overview');
      expect(names).not.toContain('Store overview');
    });

    it('globex sees its own (empty) pack and nothing of acme', async () => {
      const g: ReportRow[] = await mustOk(api(c, globexToken).get('/reports'));
      expect(g.filter(r => r.kind === 'builtin').map(r => r.key)).toEqual(expect.arrayContaining([...STOCK, 'builtin_po_vs_grn', 'builtin_vendor_performance']));
      for (const k of ['builtin_po_vs_grn', 'builtin_stock_summary', 'builtin_consumption', 'builtin_reorder', 'builtin_item_movement_summary', 'builtin_stock_ledger']) {
        expect((await run(k, k === 'builtin_stock_ledger' ? { datePreset: 'this_fy' } : {}, globexToken, g)).rows).toEqual([]);
      }
      const acmeReport = list.find(r => r.key === 'builtin_po_vs_grn')!;
      expect(g.map(r => r.id)).not.toContain(acmeReport.id);
      expect((await api(c, globexToken).post(`/reports/${acmeReport.id}/run`, {})).status).toBe(404);
      const gd = await mustOk(api(c, globexToken).get('/dashboards'));
      const acmeDash = (await mustOk(api(c, acme.token).get('/dashboards'))).find((d: { name: string }) => d.name === 'Store overview');
      expect(gd.map((d: { id: string }) => d.id)).not.toContain(acmeDash.id);
      expect((await api(c, globexToken).post('/dashboards/widgets/stock_value/data', { dashboardId: acmeDash.id })).status).toBe(404);
    });
  });
});

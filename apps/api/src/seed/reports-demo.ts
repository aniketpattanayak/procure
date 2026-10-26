/**
 * Demo seed — Reports part (Phase 7). Idempotent; called from demo.ts after the documents/workflow seeds.
 *   - acme + globex: built-in reports (pending approvals, documents by status/location, audit trail, users and roles)
 *     and the built-in "My work" dashboard.
 *   - acme: custom report "Capex by location and month" (sum of amounts, bar chart) shared with the Approver role,
 *     an "Approver overview" dashboard (default for Approver), and report/dashboard view grants for Approver.
 */
import { ReportDefinition } from '@procure/schema';
import { Kysely, sql } from 'kysely';
import type { DB } from '../core/db-types';
import { installReportBuiltins } from '../modules/reports/builtins';

const CAPEX_REPORT_KEY = 'capex_by_location_month';
const APPROVER_DASHBOARD = 'Approver overview';

export const CAPEX_BY_LOCATION_MONTH = ReportDefinition.parse({
  source: { kind: 'doc', key: 'capex' },
  columns: [
    { field: 'location.name', label: 'Location' },
    { field: 'doc_date.month', label: 'Month' },
    { field: 'total_amount', label: 'Amount', aggregate: 'sum', format: 'currency' },
    { field: 'number', label: 'Requests', aggregate: 'count' },
  ],
  groupBy: ['location.name', 'doc_date.month'],
  sort: [{ field: 'doc_date.month', dir: 'asc' }, { field: 'location.name', dir: 'asc' }],
  chart: { type: 'bar', x: 'doc_date.month', series: ['total_amount'] },
  datePreset: 'this_fy',
});

export async function seedReportsDemo(db: Kysely<DB>, tenantCodes: string[]): Promise<void> {
  for (const code of tenantCodes) {
    const tenant = await db.selectFrom('platform.tenant').select('id').where('code', '=', code).executeTakeFirst();
    if (!tenant) continue;
    const tenantId = tenant.id;
    await db.transaction().execute(async tx => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
      // platform_user bypasses RLS: every statement filters by tenant explicitly.
      await installReportBuiltins(tx, tenantId);
      if (code !== 'acme') return;

      const capex = await tx.selectFrom('app.doc_type').select('id').where('tenant_id', '=', tenantId).where('key', '=', 'capex').executeTakeFirst();
      const approver = await tx.selectFrom('app.role').select('id').where('tenant_id', '=', tenantId).where('key', '=', 'approver').where('is_deleted', '=', false).executeTakeFirst();
      const admin = await tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', tenantId).where('email', '=', 'admin@acme.test').executeTakeFirst();
      if (!capex || !approver || !admin) return;

      const report = await tx.insertInto('app.report_def').values({
        tenant_id: tenantId, key: CAPEX_REPORT_KEY, name: 'Capex by location and month', kind: 'custom',
        description: 'Capex request value per location and month (this financial year).',
        definition: JSON.stringify(CAPEX_BY_LOCATION_MONTH), owner_user_id: admin.id, shared_role_ids: [approver.id], created_by: admin.id, updated_by: admin.id,
      } as never).onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet({
        name: 'Capex by location and month', definition: JSON.stringify(CAPEX_BY_LOCATION_MONTH), shared_role_ids: [approver.id], is_active: true,
      })).returning('id').executeTakeFirstOrThrow();

      const widgets = [
        { id: 'inbox', type: 'inbox_counts', title: 'Waiting for my approval', params: {}, x: 0, y: 0, w: 4, h: 3 },
        { id: 'capex_total', type: 'kpi', title: 'Capex this year', reportId: report.id, params: {}, x: 4, y: 0, w: 4, h: 3 },
        { id: 'capex_status', type: 'doc_counts', title: 'Capex requests', docTypeKey: 'capex', params: {}, x: 8, y: 0, w: 4, h: 3 },
        { id: 'capex_chart', type: 'chart', title: 'Capex by month', reportId: report.id, params: {}, x: 0, y: 3, w: 12, h: 5 },
      ];
      const layout = JSON.stringify({ widgets });
      const existing = await tx.selectFrom('app.dashboard_def').select('id').where('tenant_id', '=', tenantId).where('name', '=', APPROVER_DASHBOARD).executeTakeFirst();
      if (existing) {
        await tx.updateTable('app.dashboard_def').set({ layout, shared_role_ids: [approver.id], is_default_for_role_ids: [approver.id] })
          .where('tenant_id', '=', tenantId).where('id', '=', existing.id).execute();
      } else {
        await tx.insertInto('app.dashboard_def').values({
          tenant_id: tenantId, name: APPROVER_DASHBOARD, layout, owner_user_id: admin.id, shared_role_ids: [approver.id], is_default_for_role_ids: [approver.id], created_by: admin.id,
        } as never).execute();
      }

      const keys = ['reports:action.view', 'reports:action.export', 'dashboards:action.view'];
      const have = new Set((await tx.selectFrom('app.permission_grant').select('perm_key').where('tenant_id', '=', tenantId).where('role_id', '=', approver.id)
        .where('perm_key', 'in', keys).execute()).map(g => g.perm_key));
      const add = keys.filter(k => !have.has(k));
      if (add.length) await tx.insertInto('app.permission_grant').values(add.map(perm_key => ({ tenant_id: tenantId, role_id: approver.id, perm_key, effect: 'allow' as const }))).execute();
    });
  }
}

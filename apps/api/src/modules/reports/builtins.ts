import { DashboardInput, DashboardWidget, ReportDefinition } from '@procure/schema';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { z } from 'zod';
import type { DB } from '../../core/db-types';
import { PACK_DASHBOARDS, PACK_REPORTS } from './pack/definitions';

/**
 * Built-in (ready-made) reports and the default "My work" dashboard (contract "Built-in reports in this batch").
 * Installed per tenant idempotently: rows are keyed by `key` (reports) / `layout.builtin` (dashboard) and refreshed
 * from this code on every install, so shipping a better definition updates every tenant.
 */
export const BUILTINS_VERSION = 3; // 3: procurement reports (spend by vendor, spend by item, PO aging, GRN vs PO variance)

export interface BuiltinReport { key: string; name: string; description: string; definition: ReportDefinition }

const def = (d: unknown) => ReportDefinition.parse(d);

export const BUILTIN_REPORTS: BuiltinReport[] = [
  {
    key: 'builtin_pending_approvals', name: 'Pending approvals by user and stage',
    description: 'Documents waiting for a decision, per approver and approval stage, with the oldest wait.',
    definition: def({
      source: { kind: 'engine', key: 'workflow_pending' },
      columns: [
        { field: 'approver.name', label: 'Approver' },
        { field: 'doc_type.name', label: 'Document type' },
        { field: 'stage', label: 'Stage' },
        { field: 'number', label: 'Documents waiting', aggregate: 'count_distinct' },
        { field: 'days_pending', label: 'Oldest (days)', aggregate: 'max' },
      ],
      groupBy: ['approver.name', 'doc_type.name', 'stage'],
      sort: [{ field: 'number', dir: 'desc' }],
      filters: [{ field: 'doc_type.key', op: 'eq', param: { key: 'doc_type', label: 'Document type' } }],
      chart: { type: 'bar', x: 'approver.name', series: ['number'] },
    }),
  },
  {
    key: 'builtin_docs_by_status_location', name: 'Documents by status and location',
    description: 'How many documents of each type sit in each status, per location, with their value.',
    definition: def({
      source: { kind: 'engine', key: 'documents' },
      columns: [
        { field: 'doc_type.name', label: 'Document type' },
        { field: 'status', label: 'Status' },
        { field: 'location.name', label: 'Location' },
        { field: 'number', label: 'Documents', aggregate: 'count' },
        { field: 'total_amount', label: 'Value', aggregate: 'sum', format: 'currency' },
      ],
      groupBy: ['doc_type.name', 'status', 'location.name'],
      filters: [{ field: 'doc_type.key', op: 'eq', param: { key: 'doc_type', label: 'Document type' } }],
      chart: { type: 'stacked_bar', x: 'status', series: ['number'] },
    }),
  },
  {
    key: 'builtin_audit_trail', name: 'Audit trail',
    description: 'Who changed what and when (tamper-evident audit log).',
    definition: def({
      source: { kind: 'engine', key: 'audit' },
      columns: [
        { field: 'at', label: 'When', format: 'datetime' },
        { field: 'actor.name', label: 'By' },
        { field: 'action', label: 'Action' },
        { field: 'entity', label: 'Record type' },
        { field: 'entity_id', label: 'Record id' },
      ],
      filters: [
        { field: 'actor.name', op: 'eq', param: { key: 'user', label: 'User' } },
        { field: 'entity', op: 'eq', param: { key: 'entity', label: 'Record type' } },
      ],
      sort: [{ field: 'at', dir: 'desc' }],
      totals: false,
      datePreset: 'last_30_days',
    }),
  },
  {
    key: 'builtin_users_roles', name: 'Users and roles',
    description: 'Every user with their roles, status and last sign-in.',
    definition: def({
      source: { kind: 'engine', key: 'users' },
      columns: [
        { field: 'name', label: 'Name' },
        { field: 'email', label: 'Email' },
        { field: 'role.name', label: 'Role' },
        { field: 'active', label: 'Active' },
        { field: 'tenant_admin', label: 'Administrator' },
        { field: 'last_login_at', label: 'Last sign-in', format: 'datetime' },
      ],
      sort: [{ field: 'name', dir: 'asc' }, { field: 'role.name', dir: 'asc' }],
      totals: false,
    }),
  },
  {
    key: 'builtin_spend_by_vendor', name: 'Spend by vendor',
    description: 'Total purchase order value and GRN value per vendor, for the selected period.',
    definition: def({
      source: { kind: 'engine', key: 'documents' },
      columns: [
        { field: 'vendor.name', label: 'Vendor' },
        { field: 'number', label: 'Purchase Orders', aggregate: 'count' },
        { field: 'total_amount', label: 'PO Value', aggregate: 'sum', format: 'currency' },
      ],
      groupBy: ['vendor.name'],
      filters: [
        { field: 'doc_type.key', op: 'eq', param: { key: 'doc_type', label: 'Document type' } },
        { field: 'status', op: 'eq', param: { key: 'status', label: 'Status' } },
      ],
      sort: [{ field: 'total_amount', dir: 'desc' }],
      chart: { type: 'bar', x: 'vendor.name', series: ['total_amount'] },
      datePreset: 'this_month',
    }),
  },
  {
    key: 'builtin_spend_by_item', name: 'Spend by item',
    description: 'Quantity and value purchased per item across all purchase orders.',
    definition: def({
      source: { kind: 'engine', key: 'documents' },
      columns: [
        { field: 'item.name', label: 'Item' },
        { field: 'item.code', label: 'Item code' },
        { field: 'number', label: 'PO Lines', aggregate: 'count' },
        { field: 'total_amount', label: 'Total Value', aggregate: 'sum', format: 'currency' },
      ],
      groupBy: ['item.name', 'item.code'],
      filters: [
        { field: 'doc_type.key', op: 'eq', param: { key: 'doc_type', label: 'Document type' } },
      ],
      sort: [{ field: 'total_amount', dir: 'desc' }],
      datePreset: 'this_month',
    }),
  },
  {
    key: 'builtin_po_aging', name: 'Purchase order aging',
    description: 'Open purchase orders grouped by how long they have been waiting — 0–15 days, 16–30, 31–60, 60+.',
    definition: def({
      source: { kind: 'engine', key: 'documents' },
      columns: [
        { field: 'number', label: 'PO Number' },
        { field: 'vendor.name', label: 'Vendor' },
        { field: 'location.name', label: 'Location' },
        { field: 'total_amount', label: 'Value', format: 'currency' },
        { field: 'days_pending', label: 'Days open', aggregate: 'max' },
      ],
      filters: [
        { field: 'doc_type.key', op: 'eq', param: { key: 'doc_type', label: 'Document type' } },
        { field: 'status', op: 'eq', param: { key: 'status', label: 'Status' } },
      ],
      sort: [{ field: 'days_pending', dir: 'desc' }],
    }),
  },
  {
    key: 'builtin_grn_po_variance', name: 'GRN vs PO variance',
    description: 'Received quantity vs ordered quantity per purchase order — highlights under- and over-deliveries.',
    definition: def({
      source: { kind: 'engine', key: 'documents' },
      columns: [
        { field: 'vendor.name', label: 'Vendor' },
        { field: 'location.name', label: 'Location' },
        { field: 'number', label: 'Documents', aggregate: 'count' },
        { field: 'total_amount', label: 'Total Value', aggregate: 'sum', format: 'currency' },
      ],
      groupBy: ['vendor.name', 'location.name'],
      filters: [
        { field: 'doc_type.key', op: 'eq', param: { key: 'doc_type', label: 'Document type' } },
      ],
      sort: [{ field: 'total_amount', dir: 'desc' }],
      chart: { type: 'stacked_bar', x: 'vendor.name', series: ['total_amount'] },
      datePreset: 'last_30_days',
    }),
  },
];

/** "My work": the approvals inbox counts + document counts per type the viewer can see (no docTypeKey = all). */
export const MY_WORK: z.infer<typeof DashboardInput> = DashboardInput.parse({
  name: 'My work',
  widgets: [
    { id: 'inbox', type: 'inbox_counts', title: 'Waiting for my approval', x: 0, y: 0, w: 4, h: 3 },
    { id: 'docs', type: 'doc_counts', title: 'My documents', x: 4, y: 0, w: 8, h: 3 },
  ],
});
export const MY_WORK_KEY = 'my_work';

type Exec = Kysely<DB> | Transaction<DB>;

/**
 * Idempotent install of the built-ins for one tenant. Works with the tenant pool (inside tenantTx) and with the
 * platform/owner connection used by the seed: every statement carries the tenant id explicitly.
 */
export async function installReportBuiltins(db: Exec, tenantId: string): Promise<void> {
  // one installer at a time per tenant (lazy install on first use, seed, concurrent requests)
  await sql`select pg_advisory_xact_lock(hashtextextended(${`report-builtins:${tenantId}`}, 0))`.execute(db);
  for (const b of [...BUILTIN_REPORTS, ...PACK_REPORTS]) {
    await db.insertInto('app.report_def').values({
      tenant_id: tenantId, key: b.key, name: b.name, description: b.description, kind: 'builtin', definition: JSON.stringify(b.definition),
      owner_user_id: null, shared_role_ids: [],
    } as never).onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet({
      name: b.name, description: b.description, definition: JSON.stringify(b.definition), kind: 'builtin', is_active: true,
    })).execute();
  }
  const layout = JSON.stringify({ builtin: MY_WORK_KEY, widgets: MY_WORK.widgets });
  const found = await db.selectFrom('app.dashboard_def').select('id').where('tenant_id', '=', tenantId)
    .where(sql<boolean>`layout ->> 'builtin' = ${MY_WORK_KEY}`).executeTakeFirst();
  if (found) await db.updateTable('app.dashboard_def').set({ name: MY_WORK.name, layout }).where('tenant_id', '=', tenantId).where('id', '=', found.id).execute();
  else {
    await db.insertInto('app.dashboard_def').values({ tenant_id: tenantId, name: MY_WORK.name, layout, owner_user_id: null, shared_role_ids: [], is_default_for_role_ids: [] } as never).execute();
  }
  await installPackDashboards(db, tenantId);
}

/**
 * The pack's dashboards (Procurement overview, Store overview): widgets point at this tenant's pack report ids;
 * `layout.builtin` keys the row, `layout.requires` / `layout.features` gate visibility. Default for the roles whose
 * grants hold one of the `requires` keys (recomputed on every install).
 */
export async function installPackDashboards(db: Exec, tenantId: string): Promise<void> {
  const reports = new Map((await db.selectFrom('app.report_def').select(['id', 'key']).where('tenant_id', '=', tenantId).where('kind', '=', 'builtin').execute())
    .map(r => [r.key, r.id]));
  for (const d of PACK_DASHBOARDS) {
    const widgets = d.widgets.map(({ reportKey, ...w }) => DashboardWidget.parse({ ...w, ...(reportKey ? { reportId: reports.get(reportKey) } : {}) }));
    const layout = JSON.stringify({ builtin: d.key, requires: d.requires, features: d.features, widgets });
    const roles = (await db.selectFrom('app.permission_grant as g').innerJoin('app.role as r', 'r.id', 'g.role_id').select('g.role_id').distinct()
      .where('g.tenant_id', '=', tenantId).where('g.effect', '=', 'allow').where('g.perm_key', 'in', d.requires).where('r.is_deleted', '=', false).execute()).map(r => r.role_id).filter((x): x is string => !!x);
    const found = await db.selectFrom('app.dashboard_def').select('id').where('tenant_id', '=', tenantId)
      .where(sql<boolean>`layout ->> 'builtin' = ${d.key}`).executeTakeFirst();
    if (found) {
      await db.updateTable('app.dashboard_def').set({ name: d.name, layout, is_default_for_role_ids: roles }).where('tenant_id', '=', tenantId).where('id', '=', found.id).execute();
    } else {
      await db.insertInto('app.dashboard_def').values({ tenant_id: tenantId, name: d.name, layout, owner_user_id: null, shared_role_ids: [], is_default_for_role_ids: roles } as never).execute();
    }
  }
}

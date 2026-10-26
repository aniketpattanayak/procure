/**
 * Demo seed — Documents part (Phase 3). Idempotent; called from demo.ts in two steps around the workflow seed:
 *   1. seedDocumentTypesDemo  — acme: the "Capex Request" type (`capex`), its numbering series (default
 *      CAPEX/{LOC}/{FYS}/{SEQ:4} + Pune Plant CPX-PUN/{FYS}/{SEQ:4}) and role grants on the static doc.capex keys.
 *   2. (workflow agent) seedWorkflowDemo — publishes the Capex workflow + stage keys.
 *   3. seedDocumentSamplesDemo — two sample documents raised by the indent clerk at Pune: one draft and one submitted
 *      (submitted only when a Capex workflow is published, so it runs on it; otherwise both stay drafts).
 * Everything goes through the real services (forms, numbering, ledger, workflow port, audit, outbox).
 */
import { NestFactory } from '@nestjs/core';
import { DocTypeCreate } from '@procure/schema';
import { Kysely, sql } from 'kysely';
import { AppModule } from '../app.module';
import type { DB } from '../core/db-types';
import { DbService, Tx } from '../core/db.service';
import { EntitlementsService } from '../core/entitlements.service';
import { DocTypesService, DocumentsService, NumberingService } from '../modules/documents';
import { hashPassword } from '../modules/identity/passwords';

const CAPEX = DocTypeCreate.parse({
  key: 'capex', name: 'Capex Request', pluralName: 'Capex Requests', description: 'Capital expenditure requests (demo custom document type)',
  hasLines: true, itemLines: true, numberPattern: 'CAPEX/{LOC}/{FYS}/{SEQ:4}',
  settings: { numberLabel: 'Capex No.', documentColumns: ['number', 'doc_date', 'location', 'status', 'total_amount', 'priority'], icon: 'landmark' },
  headerDefinition: {
    fields: [
      { key: 'purpose', type: 'textarea', label: 'Purpose', required: true, rows: 3 },
      { key: 'priority', type: 'select', label: 'Priority', default: 'Normal', width: 4, options: [{ value: 'Normal', label: 'Normal' }, { value: 'Urgent', label: 'Urgent', color: 'red' }] },
      { key: 'justification', type: 'textarea', label: 'Justification for urgency', visibleWhen: "priority = 'Urgent'", requiredWhen: "priority = 'Urgent'" },
    ],
  },
  lineDefinition: {
    fields: [
      { key: 'rate', type: 'currency', label: 'Rate', system: true, hidden: true },
      { key: 'est_rate', type: 'currency', label: 'Estimated rate', required: true, min: 0, width: 2 },
      { key: 'amount', type: 'formula', label: 'Amount', expr: 'qty * est_rate', precision: 2, width: 2 },
      { key: 'remarks', type: 'text', label: 'Remarks', maxLength: 200 },
    ],
  },
});

const k = (s: string) => `doc.capex:${s}`;
const OUTCOME_VIEWS = ['on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'].map(v => k(`view.${v}`));
/** Static-key grants per starter role (stage keys + waiting_* views come from the workflow seed). */
const GRANTS: Record<string, string[]> = {
  requester: [...['view', 'add', 'edit', 'delete', 'submit', 'cancel', 'copy', 'comment', 'attach'].map(a => k(`action.${a}`)), k('view.draft'), ...OUTCOME_VIEWS],
  indent_clerk: [...['view', 'add', 'edit', 'submit'].map(a => k(`action.${a}`)), k('view.draft'), k('view.rejected')],
  approver: [...['view', 'comment', 'attach'].map(a => k(`action.${a}`)), ...OUTCOME_VIEWS],
  buyer: [...['view', 'comment', 'close'].map(a => k(`action.${a}`)), k('view.partially_approved'), k('view.approved'), k('view.closed')],
  store_keeper: [k('action.view'), k('view.approved'), k('view.closed')],
};

async function grant(tx: Tx, tenantId: string, roleId: string, keys: string[]) {
  const have = new Set((await tx.selectFrom('app.permission_grant').select('perm_key').where('tenant_id', '=', tenantId).where('role_id', '=', roleId)
    .where('perm_key', 'in', keys).execute()).map(g => g.perm_key));
  const add = keys.filter(x => !have.has(x));
  if (add.length) await tx.insertInto('app.permission_grant').values(add.map(perm_key => ({ tenant_id: tenantId, role_id: roleId, perm_key, effect: 'allow' as const }))).execute();
}

/** Demo approver (frontend testing of the HOD stage): role Approver, scope Pune Plant + below. */
export const APPROVER = { email: 'approver@acme.test', name: 'Hema HOD', password: 'Approve@12345' };

async function seedApprover(tx: Tx, tenantId: string, approverRoleId: string, puneId: string) {
  const hash = await hashPassword(APPROVER.password);
  let user = await tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', tenantId).where('email', '=', APPROVER.email).executeTakeFirst();
  if (user) {
    await tx.updateTable('app.tenant_user').set({
      name: APPROVER.name, password_hash: hash, must_change_password: false, is_active: true, is_deleted: false, is_tenant_admin: false, failed_logins: 0, locked_until: null,
    }).where('id', '=', user.id).execute();
  } else {
    user = await tx.insertInto('app.tenant_user').values({
      tenant_id: tenantId, email: APPROVER.email, name: APPROVER.name, password_hash: hash, is_tenant_admin: false, must_change_password: false,
    }).returning('id').executeTakeFirstOrThrow();
  }
  await tx.insertInto('app.user_role').values({ tenant_id: tenantId, user_id: user.id, role_id: approverRoleId }).onConflict(oc => oc.doNothing()).execute();
  // Approver role scope = Pune Plant + below (exactly; the workflow seed only adds all-locations when a role has none).
  await tx.deleteFrom('app.scope_grant').where('tenant_id', '=', tenantId).where('role_id', '=', approverRoleId).execute();
  await tx.insertInto('app.scope_grant').values({ tenant_id: tenantId, role_id: approverRoleId, node_id: puneId, all_nodes: false, include_descendants: true }).execute();
}

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>) => Promise<T>): Promise<T> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

export async function seedDocumentTypesDemo(platformDb: Kysely<DB>): Promise<void> {
  const tenant = await platformDb.selectFrom('platform.tenant').select('id').where('code', '=', 'acme').executeTakeFirst();
  if (!tenant) return;
  await withApp(async app => {
    const db = app.get(DbService);
    await db.tenantTx(tenant.id, async tx => {
      const admin = await tx.selectFrom('app.tenant_user').select('id').where('email', '=', 'admin@acme.test').executeTakeFirstOrThrow();
      const actor = { tenantId: tenant.id, userId: admin.id, perms: null };
      const types = app.get(DocTypesService);
      if (!(await types.find(tx, tenant.id, 'capex'))) await types.create(tx, actor, CAPEX);
      const capex = await types.load(tx, tenant.id, 'capex');
      const pune = await tx.selectFrom('app.location_node').select('id').where('code', '=', 'PUNE').executeTakeFirst();
      if (pune) {
        const has = await tx.selectFrom('app.numbering_series').select('id').where('doc_type_id', '=', capex.id).where('location_node_id', '=', pune.id).executeTakeFirst();
        if (!has) await app.get(NumberingService).create(tx, actor, { docTypeKey: 'capex', name: 'Pune Plant', locationNodeId: pune.id, pattern: 'CPX-PUN/{FYS}/{SEQ:4}', reset: 'fy', isActive: true });
      }
      const roles = await tx.selectFrom('app.role').select(['id', 'key']).where('key', 'in', Object.keys(GRANTS)).where('is_deleted', '=', false).execute();
      for (const r of roles) await grant(tx, tenant.id, r.id, GRANTS[r.key]!);
      const approver = roles.find(r => r.key === 'approver');
      if (approver && pune) await seedApprover(tx, tenant.id, approver.id, pune.id);
    });
    await app.get(EntitlementsService).bumpPermissions(tenant.id);
  });
}

const SAMPLES = [
  {
    purpose: 'Spare aluminium sheet stock for the die-repair cell', priority: 'Normal', submit: false, location: 'PUNE-MAIN',
    lines: [{ item: 'ITM-00003', qty: '40', est_rate: '245', remarks: '2 mm, mill finish' }],
  },
  {
    purpose: 'Rewiring of Pune line 2 (copper wire and cartons for dispatch)', priority: 'Urgent', justification: 'Line 2 is down since the short circuit on Monday',
    submit: true, location: 'PUNE',
    lines: [{ item: 'ITM-00002', qty: '3000', est_rate: '38.75', remarks: '2.5 sq mm' }, { item: 'ITM-00004', qty: '200', est_rate: '18.40' }],
  },
];

export async function seedDocumentSamplesDemo(platformDb: Kysely<DB>): Promise<void> {
  const tenant = await platformDb.selectFrom('platform.tenant').select('id').where('code', '=', 'acme').executeTakeFirst();
  if (!tenant) return;
  await withApp(async app => {
    const db = app.get(DbService);
    const docs = app.get(DocumentsService);
    // Approver: waiting_hod view (+ stage_hod from the workflow seed), once the workflow has created those keys.
    await db.tenantTx(tenant.id, async tx => {
      const role = await tx.selectFrom('app.role').select('id').where('key', '=', 'approver').where('is_deleted', '=', false).executeTakeFirst();
      const keys = (await tx.selectFrom('app.permission_def').select('key').where('key', 'in', [k('view.waiting_hod'), k('action.stage_hod')]).execute()).map(r => r.key);
      if (role && keys.length) await grant(tx, tenant.id, role.id, keys);
    });
    await app.get(EntitlementsService).bumpPermissions(tenant.id);
    for (const s of SAMPLES) {
      await db.tenantTx(tenant.id, async tx => {
        const type = await tx.selectFrom('app.doc_type').select('id').where('key', '=', 'capex').executeTakeFirst();
        if (!type) return;
        const exists = await tx.selectFrom('app.document').select('id').where('doc_type_id', '=', type.id).where('is_deleted', '=', false)
          .where(sql<boolean>`custom->>'purpose' = ${s.purpose}`).executeTakeFirst();
        if (exists) return;
        const clerk = await tx.selectFrom('app.tenant_user').select('id').where('email', '=', 'indenter@acme.test').executeTakeFirst()
          ?? await tx.selectFrom('app.tenant_user').select('id').where('email', '=', 'admin@acme.test').executeTakeFirstOrThrow();
        const loc = await tx.selectFrom('app.location_node').select('id').where('code', '=', s.location).executeTakeFirst();
        if (!loc) return;
        const items = await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id').select(['r.id', 'r.code'])
          .where('d.key', '=', 'item').where('r.code', 'in', s.lines.map(l => l.item)).execute();
        const itemId = new Map(items.map(i => [String(i.code).toUpperCase(), i.id]));
        if (s.lines.some(l => !itemId.has(l.item))) return;
        const actor = { tenantId: tenant.id, userId: clerk.id, perms: null };
        const values: Record<string, unknown> = { location: loc.id, purpose: s.purpose, priority: s.priority, ...(s.justification ? { justification: s.justification } : {}) };
        const row = await docs.create(tx, actor, 'capex', { values, lines: s.lines.map(l => ({ values: { ...l, item: itemId.get(l.item) } })) });
        const published = await tx.selectFrom('app.workflow_def').select('current_version_id').where('doc_type_id', '=', type.id).executeTakeFirst();
        if (s.submit && published?.current_version_id) await docs.submit(tx, actor, 'capex', row.id, row.version);
      });
    }
  });
}

/**
 * Demo seed — Workflow part (Phase 3). Idempotent; called from demo.ts AFTER the documents agent's doc-type seed
 * (and ideally before sample documents are submitted, so they run on this workflow).
 *
 * acme: publishes the Capex workflow from the contract (v1 on a fresh database; re-runs publish nothing when the
 * current version already matches) and grants stage keys to the seeded roles:
 *   Approver → stage_hod + waiting_hod view, Buyer → stage_finance + waiting_finance view (both + approvals inbox,
 *   all-location scope when the role has none); Indent clerk → waiting_hod view. acme admin is tenant admin (all keys).
 */
import { NestFactory } from '@nestjs/core';
import { Kysely } from 'kysely';
import { AppModule } from '../app.module';
import type { DB } from '../core/db-types';
import { DbService, Tx } from '../core/db.service';
import { EntitlementsService } from '../core/entitlements.service';
import { DefinitionsService, parseDefinition } from '../modules/workflow';

export function capexWorkflow(r: { approver: string; buyer: string; adminId: string }) {
  return parseDefinition({
    granularity: 'line',
    stages: [
      {
        key: 'hod', name: 'HOD approval', actors: [{ type: 'role', roleId: r.approver }],
        sla: { hours: 24, remindEveryHours: 8, escalateTo: { type: 'users', userIds: [r.adminId] } },
      },
      {
        key: 'finance', name: 'Finance review', when: 'total_amount > 100000', actors: [{ type: 'role', roleId: r.buyer }],
        actions: ['approve', 'reject', 'send_back'],
      },
      // "Document granularity" for the director: one outcome for every line (the API's `outcome` on a decide).
      { key: 'director', name: 'Director approval', when: 'total_amount >= 500000', actors: [{ type: 'users', userIds: [r.adminId] }], actions: ['approve', 'reject', 'send_back'] },
    ],
  });
}

const comparable = (d: unknown) => JSON.stringify({ ...(d as object), version: 0 });

async function grant(tx: Tx, tenantId: string, roleId: string, keys: string[]) {
  const have = new Set((await tx.selectFrom('app.permission_grant').select('perm_key').where('tenant_id', '=', tenantId).where('role_id', '=', roleId)
    .where('perm_key', 'in', keys).execute()).map(g => g.perm_key));
  const add = keys.filter(k => !have.has(k));
  if (add.length) await tx.insertInto('app.permission_grant').values(add.map(perm_key => ({ tenant_id: tenantId, role_id: roleId, perm_key, effect: 'allow' as const }))).execute();
}

export async function seedWorkflowDemo(platformDb: Kysely<DB>): Promise<void> {
  const tenant = await platformDb.selectFrom('platform.tenant').select('id').where('code', '=', 'acme').executeTakeFirst();
  if (!tenant) return;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get(DbService);
    const defs = app.get(DefinitionsService);
    const done = await db.tenantTx(tenant.id, async tx => {
      const type = await tx.selectFrom('app.doc_type').select('id').where('key', '=', 'capex').executeTakeFirst();
      if (!type) {
        console.warn('workflow seed: acme has no "capex" document type yet; Capex workflow not seeded');
        return false;
      }
      const roles = await tx.selectFrom('app.role').select(['id', 'key']).where('key', 'in', ['approver', 'buyer', 'indent_clerk']).where('is_deleted', '=', false).execute();
      const role = (k: string) => roles.find(r => r.key === k)?.id;
      const admin = await tx.selectFrom('app.tenant_user').select('id').where('email', '=', 'admin@acme.test').executeTakeFirstOrThrow();
      if (!role('approver') || !role('buyer')) throw new Error('workflow seed: roles approver/buyer missing (standard bundle not installed?)');
      const definition = capexWorkflow({ approver: role('approver')!, buyer: role('buyer')!, adminId: admin.id });

      const dt = await defs.docType(tx, 'capex');
      const wf = await defs.ensureDef(tx, tenant.id, dt, null, true);
      const current = wf.current_version_id ? await defs.versionById(tx, wf.current_version_id) : null;
      if (!current || comparable(current.definition) !== comparable(definition)) {
        await defs.publishDefinition(tx, tenant.id, dt, wf, definition, 'Demo: HOD → Finance (> 1 lakh) → Director (≥ 5 lakh)', null);
      }

      const k = (s: string) => `doc.capex:${s}`;
      await grant(tx, tenant.id, role('approver')!, [k('action.view'), k('action.stage_hod'), k('view.waiting_hod'), 'approvals:action.view']);
      await grant(tx, tenant.id, role('buyer')!, [k('action.view'), k('action.stage_finance'), k('view.waiting_finance'), 'approvals:action.view']);
      if (role('indent_clerk')) await grant(tx, tenant.id, role('indent_clerk')!, [k('view.waiting_hod')]);
      for (const id of [role('approver')!, role('buyer')!]) {
        const scoped = await tx.selectFrom('app.scope_grant').select('id').where('tenant_id', '=', tenant.id).where('role_id', '=', id).executeTakeFirst();
        if (!scoped) await tx.insertInto('app.scope_grant').values({ tenant_id: tenant.id, role_id: id, all_nodes: true, include_descendants: true }).execute();
      }
      return true;
    });
    if (done) await app.get(EntitlementsService).bumpPermissions(tenant.id);
  } finally {
    await app.close();
  }
}

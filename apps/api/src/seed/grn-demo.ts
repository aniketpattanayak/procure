/**
 * Demo seed — GRN / issue part (Phase 5). Idempotent; called from demo.ts after the procurement seeds (and after the
 * stock seed when present). acme:
 *   - GRN / RTV / issue types via the installer (same code as provisioning), role grants (store keeper creates GRNs,
 *     issues and returns; Approver acts on every stage; buyer + approver see received POs)
 *   - item category A ("requires_qc": true) → MS Plate goes through the quality stage
 *   - two partial GRNs on the approved PO's MS Plate line: GRN 1 (200 kg, batch HT-2611-A) gate → store (stock
 *     posted) → quality rejects 50 kg (blocked) → disposition returns it (draft RTV) → RTV approved (debit note);
 *     GRN 2 (80 kg) through the chain → PO partially received
 *   - an issue request (120 kg) approved, a partial issue (70 kg) and a partial return (20 kg)
 * Everything goes through the real services (documents, hooks, workflow engine, stock effects).
 */
import { NestFactory } from '@nestjs/core';
import { sql, type Kysely } from 'kysely';
import { AppModule } from '../app.module';
import type { DB } from '../core/db-types';
import { DbService, Tx } from '../core/db.service';
import { EntitlementsService } from '../core/entitlements.service';
import { DocumentsService } from '../modules/documents';
import { GrnLinesService, IssueLinesService } from '../modules/inventory';
import { PermissionResolverService } from '../modules/permissions';
import { ProcurementInstaller } from '../modules/procurement';
import { EngineService } from '../modules/workflow';

const k = (type: string, a: string) => `doc.${type}:${a}`;
const VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'];
const GRN_WAIT = ['waiting_gate', 'waiting_store', 'waiting_quality', 'waiting_disposition'];
const views = (type: string, extra: string[]) => [...VIEWS, ...extra].map(v => k(type, `view.${v}`));
const acts = (type: string, list: string[]) => list.map(a => k(type, `action.${a}`));
const CREATE = ['view', 'add', 'edit', 'delete', 'submit', 'cancel', 'copy', 'comment', 'attach', 'print'];
const GRANTS: Record<string, string[]> = {
  store_keeper: [
    ...acts('grn', CREATE), ...views('grn', GRN_WAIT), ...acts('rtv', CREATE), ...views('rtv', ['waiting_approve']),
    ...acts('store_issue', CREATE), ...views('store_issue', ['waiting_approve']), ...acts('store_return', CREATE), ...views('store_return', ['waiting_approve']),
    ...acts('issue_request', ['view', 'comment']), ...views('issue_request', ['waiting_approve']),
    ...acts('po', ['view']), ...views('po', ['waiting_approve', 'partially_received', 'received']),
  ],
  approver: [
    ...acts('grn', ['view', 'comment', 'stage_gate', 'stage_store', 'stage_quality', 'stage_disposition']), ...views('grn', GRN_WAIT),
    ...acts('rtv', ['view', 'comment', 'print', 'stage_approve']), ...views('rtv', ['waiting_approve']),
    ...['issue_request', 'store_issue', 'store_return'].flatMap(t => [...acts(t, ['view', 'comment', 'stage_approve']), ...views(t, ['waiting_approve'])]),
    k('po', 'view.partially_received'), k('po', 'view.received'), 'approvals:action.view',
  ],
  buyer: [k('po', 'view.partially_received'), k('po', 'view.received')],
  requester: [...acts('issue_request', ['view', 'add', 'edit', 'delete', 'submit', 'cancel', 'copy', 'comment']), ...views('issue_request', ['waiting_approve'])],
};

async function grant(tx: Tx, tenantId: string, roleId: string, keys: string[]) {
  const known = new Set((await tx.selectFrom('app.permission_def').select('key').where('tenant_id', '=', tenantId).where('key', 'in', keys).execute()).map(r => r.key));
  const want = keys.filter(x => known.has(x) || x === 'approvals:action.view');
  if (!want.length) return;
  const have = new Set((await tx.selectFrom('app.permission_grant').select('perm_key').where('tenant_id', '=', tenantId).where('role_id', '=', roleId).where('perm_key', 'in', want).execute()).map(g => g.perm_key));
  const add = want.filter(x => !have.has(x));
  if (add.length) await tx.insertInto('app.permission_grant').values(add.map(perm_key => ({ tenant_id: tenantId, role_id: roleId, perm_key, effect: 'allow' as const }))).execute();
}

export async function seedGrnDemo(platformDb: Kysely<DB>): Promise<void> {
  const tenant = await platformDb.selectFrom('platform.tenant').select('id').where('code', '=', 'acme').executeTakeFirst();
  if (!tenant) return;
  const tid = tenant.id;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get(DbService);
    const ent = app.get(EntitlementsService);
    await ent.invalidate(tid);
    const user = (tx: Tx, email: string) => tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', tid).where('email', '=', email).executeTakeFirst();

    // 1. Types (idempotent installer), grants, QC flag on item category A.
    const ready = await db.tenantTx(tid, async tx => {
      const admin = await user(tx, 'admin@acme.test');
      await app.get(ProcurementInstaller).ensure(tx, tid, { actorId: admin?.id ?? null });
      if (!(await tx.selectFrom('app.doc_type').select('id').where('tenant_id', '=', tid).where('key', '=', 'grn').executeTakeFirst())) return false;
      const roles = await tx.selectFrom('app.role').select(['id', 'key']).where('tenant_id', '=', tid).where('key', 'in', Object.keys(GRANTS)).where('is_deleted', '=', false).execute();
      for (const r of roles) await grant(tx, tid, r.id, GRANTS[r.key]!);
      await sql`update app.master_record r set data = r.data || '{"requires_qc": true}'::jsonb
        from app.master_def d where d.id = r.master_id and d.key = 'item_category' and r.tenant_id = ${tid} and r.code = 'A'::citext`.execute(tx);
      return true;
    });
    if (!ready) {
      console.warn('grn seed: acme has no "grn" document type (feature or stock effects missing); GRN demo not seeded');
      return;
    }
    await ent.bumpPermissions(tid);

    await db.tenantTx(tid, async tx => {
      const has = await sql<{ n: string }>`select count(*)::text as n from app.document d join app.doc_type t on t.id = d.doc_type_id where d.tenant_id = ${tid} and t.key = 'grn'`.execute(tx);
      if (Number(has.rows[0]!.n) > 0) return;
      const admin = (await user(tx, 'admin@acme.test'))!;
      const clerk = (await user(tx, 'indenter@acme.test')) ?? admin;
      const decider = (await user(tx, 'approver@acme.test')) ?? admin;
      const perms = await app.get(PermissionResolverService).resolve(tid, decider.id, true);
      const engine = app.get(EngineService);
      const docs = app.get(DocumentsService);
      const keeper = { tenantId: tid, userId: clerk.id, perms: null };
      const decide = (type: string, id: string, stageKey: string, decisions: { lineId: string; approve: string; reject?: string; reason?: string }[], comment?: string) =>
        engine.act(tx, type, id, { action: 'decide', stageKey, comment, decisions: decisions.map(d => ({ hold: '0', reject: '0', ...d })) }, { userId: decider.id, perms }, {});

      // 2. The approved PO's MS Plate line.
      const po = await sql<{ line_id: string; doc_id: string; qty: string; loc: string }>`
        select l.id as line_id, d.id as doc_id, l.qty::text as qty, d.location_node_id as loc
        from app.document_line l join app.document d on d.id = l.document_id join app.doc_type t on t.id = d.doc_type_id
        join app.master_record i on i.id = l.item_id
        where d.tenant_id = ${tid} and t.key = 'po' and d.status_key = 'approved' and i.code = 'ITM-00001'::citext and not l.is_deleted
        order by d.created_at limit 1`.execute(tx);
      const pl = po.rows[0];
      if (!pl) return;

      // GRN 1: 200 kg → gate → store (posts) → QA rejects 50 → blocked → disposition → RTV.
      const [g1] = await app.get(GrnLinesService).fromPo(tx, keeper, {
        submit: true, values: { invoice_no: 'DST/2611/045', invoice_date: '2026-10-20', challan_no: 'CH-7781', vehicle_no: 'MH12 AB 4521', gate_entry_no: 'GE-0001' },
        lines: [{ poLineId: pl.line_id, qty: '200', batchNo: 'HT-2611-A', mfgDate: '2026-10-01', values: {} }],
      });
      const l1 = g1!.lines[0]!.id;
      await decide('grn', g1!.id, 'gate', [{ lineId: l1, approve: '200' }], 'Vehicle and documents checked');
      await decide('grn', g1!.id, 'store', [{ lineId: l1, approve: '200' }], 'Weighed and stacked in Main Store');
      await decide('grn', g1!.id, 'quality', [{ lineId: l1, approve: '150', reject: '50', reason: 'Surface rust on 50 kg' }]);
      await decide('grn', g1!.id, 'disposition', [{ lineId: l1, approve: '0', reject: '50', reason: 'Return to vendor' }]);
      const rtv = await sql<{ id: string; version: number }>`
        select d.id, d.version from app.document d join app.doc_type t on t.id = d.doc_type_id
        where d.tenant_id = ${tid} and t.key = 'rtv' and d.custom->>'grn' = ${g1!.id} limit 1`.execute(tx);
      if (rtv.rows[0]) {
        const sub = await docs.submit(tx, keeper, 'rtv', rtv.rows[0].id, rtv.rows[0].version);
        await decide('rtv', sub.id, 'approve', sub.lines.map(l => ({ lineId: l.id, approve: String(Number(l.values.qty)) })), 'Debit note raised');
      }

      // GRN 2: 80 kg through the chain (QA accepts everything).
      const [g2] = await app.get(GrnLinesService).fromPo(tx, keeper, {
        submit: true, values: { invoice_no: 'DST/2611/052', invoice_date: '2026-10-22', challan_no: 'CH-7790', gate_entry_no: 'GE-0002' },
        lines: [{ poLineId: pl.line_id, qty: '80', batchNo: 'HT-2611-B', values: {} }],
      });
      const l2 = g2!.lines[0]!.id;
      await decide('grn', g2!.id, 'gate', [{ lineId: l2, approve: '80' }]);
      await decide('grn', g2!.id, 'store', [{ lineId: l2, approve: '80' }]);
      await decide('grn', g2!.id, 'quality', [{ lineId: l2, approve: '80' }]);

      // 3. Issue request 120 kg → approved; partial issue 70 kg (batch A) → approved; partial return 20 kg.
      const item = await sql<{ id: string }>`select r.id from app.master_record r join app.master_def d on d.id = r.master_id
        where r.tenant_id = ${tid} and d.key = 'item' and r.code = 'ITM-00001'::citext`.execute(tx);
      const dept = await sql<{ id: string }>`select r.id from app.master_record r join app.master_def d on d.id = r.master_id
        where r.tenant_id = ${tid} and d.key = 'department' and not r.is_deleted order by r.code limit 1`.execute(tx);
      const reqDraft = await docs.create(tx, keeper, 'issue_request', {
        values: { location: pl.loc, ...(dept.rows[0] ? { department: dept.rows[0].id } : {}), purpose: 'Fabrication of conveyor guards' },
        lines: [{ values: { item: item.rows[0]!.id, qty: '120', purpose: 'Guards for line 3' } }],
      });
      const req = await docs.submit(tx, keeper, 'issue_request', reqDraft.id, reqDraft.version);
      await decide('issue_request', req.id, 'approve', [{ lineId: req.lines[0]!.id, approve: '120' }]);
      const issue = await app.get(IssueLinesService).fromRequests(tx, keeper, {
        submit: true, values: { issued_to: 'Fabrication shop' }, lines: [{ requestLineId: req.lines[0]!.id, qty: '70', batchNo: 'HT-2611-A', values: {} }],
      });
      await decide('store_issue', issue.id, 'approve', [{ lineId: issue.lines[0]!.id, approve: '70' }]);
      const ret = await app.get(IssueLinesService).fromIssues(tx, keeper, {
        submit: true, values: { returned_by: 'Fabrication shop' }, lines: [{ issueLineId: issue.lines[0]!.id, qty: '20', status: 'available', reason: 'Excess cut pieces', values: {} }],
      });
      await decide('store_return', ret.id, 'approve', [{ lineId: ret.lines[0]!.id, approve: '20' }]);
    });
    await ent.bumpPermissions(tid);
  } finally {
    await app.close();
  }
}

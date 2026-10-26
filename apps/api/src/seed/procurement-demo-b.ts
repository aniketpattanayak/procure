/**
 * Demo seed — Procurement part B (Phase 4, purchase orders). Idempotent; called from demo.ts right after
 * seedProcurementDemoA (which provisions the PO type through the same installer and seeds the split selection).
 * acme:
 *   - PO role grants (Buyer: create / submit / follow up / amend / short-close; Approver: PO + selection approval)
 *   - Pune Plant `state_code = 27`, item tax codes (GST18 / GST18 / GST12 / GST5 / GST28)
 *   - the vendor selection approved by the Approver, then one draft PO per vendor from its lines (submitted)
 *   - the Maharashtra vendor's PO approved (CGST + SGST); the Tamil Nadu one stays waiting (IGST)
 *   - a follow-up on the approved PO that revises its expected date
 * Everything goes through the real services (documents, PO hooks, GST engine, workflow engine, follow-ups).
 */
import { NestFactory } from '@nestjs/core';
import { sql, type Kysely } from 'kysely';
import { AppModule } from '../app.module';
import type { DB } from '../core/db-types';
import { DbService, Tx } from '../core/db.service';
import { EntitlementsService } from '../core/entitlements.service';
import { DocumentsService } from '../modules/documents';
import { MastersService, RecordsService } from '../modules/forms';
import { PermissionResolverService } from '../modules/permissions';
import { FollowupsService, PoLinesService } from '../modules/procurement';
import { EngineService } from '../modules/workflow';

const po = (a: string) => `doc.po:${a}`;
const vs = (a: string) => `doc.vendor_selection:${a}`;
const VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed', 'waiting_approve', 'amending'];
const GRANTS: Record<string, string[]> = {
  buyer: [
    ...['view', 'add', 'edit', 'delete', 'submit', 'cancel', 'close', 'copy', 'comment', 'attach', 'followup', 'amend', 'short_close'].map(a => po(`action.${a}`)),
    ...VIEWS.map(v => po(`view.${v}`)),
  ],
  approver: [
    ...['view', 'comment', 'stage_approve'].map(a => po(`action.${a}`)), ...VIEWS.map(v => po(`view.${v}`)),
    ...['view', 'comment', 'stage_approve'].map(a => vs(`action.${a}`)), ...VIEWS.filter(v => v !== 'amending').map(v => vs(`view.${v}`)), 'approvals:action.view',
  ],
};
const TERMS = [
  { code: 'TC-PAY', name: 'Payment', body: 'Payment within the agreed credit period from the date of receipt of material and a correct GST invoice.' },
  { code: 'TC-DEL', name: 'Delivery', body: 'Deliver to Pune Plant stores between 9 am and 5 pm on working days, with the PO number on the challan.' },
  { code: 'TC-QLY', name: 'Quality', body: 'Material is subject to inspection; rejected material will be returned at the vendor\'s cost.' },
];
const ITEM_TAX: Record<string, string> = { 'ITM-00001': 'GST18', 'ITM-00002': 'GST18', 'ITM-00003': 'GST12', 'ITM-00004': 'GST5', 'ITM-00005': 'GST28' };

async function grant(tx: Tx, tenantId: string, roleId: string, keys: string[]) {
  const known = new Set((await tx.selectFrom('app.permission_def').select('key').where('tenant_id', '=', tenantId).where('key', 'in', keys).execute()).map(r => r.key));
  const want = keys.filter(k => known.has(k) || k === 'approvals:action.view');
  if (!want.length) return;
  const have = new Set((await tx.selectFrom('app.permission_grant').select('perm_key').where('tenant_id', '=', tenantId).where('role_id', '=', roleId).where('perm_key', 'in', want).execute()).map(g => g.perm_key));
  const add = want.filter(k => !have.has(k));
  if (add.length) await tx.insertInto('app.permission_grant').values(add.map(perm_key => ({ tenant_id: tenantId, role_id: roleId, perm_key, effect: 'allow' as const }))).execute();
}

export async function seedProcurementDemoB(platformDb: Kysely<DB>): Promise<void> {
  const tenant = await platformDb.selectFrom('platform.tenant').select('id').where('code', '=', 'acme').executeTakeFirst();
  if (!tenant) return;
  const tid = tenant.id;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get(DbService);
    const ent = app.get(EntitlementsService);
    const user = (tx: Tx, email: string) => tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', tid).where('email', '=', email).executeTakeFirst();

    // 1. Grants, Pune state code, item tax codes.
    const ready = await db.tenantTx(tid, async tx => {
      if (!(await tx.selectFrom('app.doc_type').select('id').where('tenant_id', '=', tid).where('key', '=', 'po').executeTakeFirst())) return false;
      const roles = await tx.selectFrom('app.role').select(['id', 'key']).where('tenant_id', '=', tid).where('key', 'in', Object.keys(GRANTS)).where('is_deleted', '=', false).execute();
      for (const r of roles) await grant(tx, tid, r.id, GRANTS[r.key]!);
      await sql`update app.location_node set custom = custom || '{"state_code":"27"}'::jsonb
        where tenant_id = ${tid} and code = 'PUNE' and coalesce(custom->>'state_code', '') = ''`.execute(tx);
      const codes = await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id').select(['r.id', 'r.code'])
        .where('r.tenant_id', '=', tid).where('d.key', '=', 'tax_code').where('r.is_deleted', '=', false).execute();
      const codeId = new Map(codes.map(c => [String(c.code).toUpperCase(), c.id]));
      for (const [item, code] of Object.entries(ITEM_TAX)) {
        const id = codeId.get(code);
        if (!id) continue;
        await sql`update app.master_record r set data = r.data || jsonb_build_object('tax_code', ${id}::text)
          from app.master_def d where d.id = r.master_id and d.key = 'item' and r.tenant_id = ${tid} and r.code = ${item}::citext
          and coalesce(r.data->>'tax_code', '') = ''`.execute(tx);
      }
      const terms = await app.get(MastersService).find(tx, tid, 'terms');
      if (terms) {
        for (const t of TERMS) {
          const has = await tx.selectFrom('app.master_record').select('id').where('tenant_id', '=', tid).where('master_id', '=', terms.id).where('is_deleted', '=', false)
            .where(sql<boolean>`code = ${t.code}::citext`).executeTakeFirst();
          if (!has) await app.get(RecordsService).save(tx, { tenantId: tid, userId: null, perms: null }, terms, { code: t.code, name: t.name, data: { body: t.body, applies_to: ['po'] } }, null);
        }
      }
      return true;
    });
    if (!ready) {
      console.warn('procurement seed B: acme has no "po" document type; PO demo not seeded');
      return;
    }
    await ent.bumpPermissions(tid);

    // 2. Approve the split selection (Approver), create one PO per vendor, submit, approve the Maharashtra one.
    await db.tenantTx(tid, async tx => {
      const admin = (await user(tx, 'admin@acme.test'))!;
      const approver = await user(tx, 'approver@acme.test');
      const decider = approver ?? admin;
      const perms = await app.get(PermissionResolverService).resolve(tid, decider.id, true);
      const sel = await sql<{ id: string; status_key: string; created_by: string | null }>`
        select d.id, d.status_key, d.created_by from app.document d join app.doc_type t on t.id = d.doc_type_id
        where d.tenant_id = ${tid} and t.key = 'vendor_selection' and not d.is_deleted and d.number is not null order by d.created_at limit 1`.execute(tx);
      const selection = sel.rows[0];
      if (!selection) return;
      const docs = app.get(DocumentsService);
      const engine = app.get(EngineService);
      if (selection.status_key === 'waiting_approve') {
        const lines = await tx.selectFrom('app.document_line').select(['id', 'qty']).where('tenant_id', '=', tid).where('document_id', '=', selection.id).where('is_deleted', '=', false).execute();
        await engine.act(tx, 'vendor_selection', selection.id, {
          action: 'decide', stageKey: 'approve', comment: 'Split approved for supply security',
          decisions: lines.map(l => ({ lineId: l.id, approve: String(Number(l.qty)), hold: '0', reject: '0' })),
        }, { userId: decider.id, perms }, {});
      }
      const selLines = await tx.selectFrom('app.document_line').select('id').where('tenant_id', '=', tid).where('document_id', '=', selection.id).where('is_deleted', '=', false).orderBy('line_no').execute();
      const already = await tx.selectFrom('app.document_line').select('id').where('tenant_id', '=', tid)
        .where(sql<boolean>`custom->>'source_line' = any(${sql.val(selLines.map(l => l.id))}::text[])`).where('is_deleted', '=', false).executeTakeFirst();
      if (already) return;
      const buyer = (await user(tx, 'indenter@acme.test')) ?? admin;
      const actor = { tenantId: tid, userId: buyer.id, perms: null };
      const sums = await tx.selectFrom('app.line_qty_summary').select(['line_id', 'approved', 'ordered']).where('tenant_id', '=', tid).where('line_id', 'in', selLines.map(l => l.id)).execute();
      const picks = sums.filter(s => Number(s.approved) - Number(s.ordered) > 0).map(s => ({ sourceLineId: s.line_id, qty: String(Number(s.approved) - Number(s.ordered)) }));
      if (!picks.length) return;
      const termIds = (await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id').select('r.id')
        .where('r.tenant_id', '=', tid).where('d.key', '=', 'terms').where('r.code', 'in', TERMS.map(t => t.code)).orderBy('r.code').execute()).map(r => r.id);
      const created = await app.get(PoLinesService).fromLines(tx, actor, {
        picks, values: { freight: '1500', ...(termIds.length ? { terms: termIds } : {}) },
      });
      for (const d of created) {
        const lines = d.lines.map(l => ({ id: l.id, values: { ...l.values, schedule: [{ date: '2026-11-05', qty: l.values.qty }] } }));
        const upd = await docs.update(tx, actor, 'po', d.id, { version: d.version, values: {}, lines });
        const sub = await docs.submit(tx, actor, 'po', d.id, upd.version);
        const vendor = await tx.selectFrom('app.master_record').select('data').where('id', '=', String(sub.values.party)).executeTakeFirst();
        if ((vendor?.data as Record<string, unknown> | undefined)?.state_code === '27' && sub.statusKey === 'waiting_approve') {
          await engine.act(tx, 'po', d.id, {
            action: 'decide', stageKey: 'approve', comment: 'Rates as per selection',
            decisions: sub.lines.map(l => ({ lineId: l.id, approve: String(Number(l.values.qty)), hold: '0', reject: '0' })),
          }, { userId: decider.id, perms }, {});
          // 3. A follow-up that revises the expected date (history: 05 Nov → 12 Nov).
          await app.get(FollowupsService).log(tx, actor, d.id, {
            contactMode: 'call', contactPerson: 'Sales desk', promisedDate: '2026-11-12', revisedExpectedDate: '2026-11-12',
            reason: 'Rolling mill shutdown at the vendor', notes: 'Vendor confirmed dispatch after maintenance shutdown',
          });
        }
      }
    });
    await ent.bumpPermissions(tid);
  } finally {
    await app.close();
  }
}

/**
 * Demo seed — Procurement part A (Phase 4). Idempotent; called from demo.ts after the documents/workflow seeds.
 * acme (plan overrides indent / vendor_quotes / purchase on, see demo.ts):
 *   - procurement system types via ProcurementInstaller.ensure (same code as provisioning; also runs agent B's steps)
 *   - role grants on the indent / vendor selection keys for the starter roles
 *   - departments, 3 vendors with GSTINs in Maharashtra (27), Tamil Nadu (33), Karnataka (29)
 *   - one approved 5-line indent (raised by the indent clerk, verified by the admin through the workflow engine)
 *   - quotes from the 3 vendors, incl. the slab quote ₹50/kg up to 999 kg, 10% off from 1,000 kg
 *   - a submitted vendor selection splitting line 1 (700 kg) 300 kg Vendor A / 400 kg Vendor B
 * Everything goes through the real services (documents, workflow engine, quotes, selection, ledger, audit, outbox).
 */
import { NestFactory } from '@nestjs/core';
import { sql, type Kysely } from 'kysely';
import { AppModule } from '../app.module';
import type { DB } from '../core/db-types';
import { DbService, Tx } from '../core/db.service';
import { EntitlementsService } from '../core/entitlements.service';
import { DocumentsService } from '../modules/documents';
import { MastersService, RecordsService, validators } from '../modules/forms';
import { PermissionResolverService } from '../modules/permissions';
import { ProcurementInstaller, QuotesService, SelectionService } from '../modules/procurement';
import { EngineService } from '../modules/workflow';

const PURPOSE = 'Demo: quarterly maintenance spares (Pune Plant)';

const VENDORS = [
  { name: 'Deccan Steel Traders', state: '27', pan: 'AABCD1234E', city: 'Pune, Maharashtra' },
  { name: 'Coromandel Metals', state: '33', pan: 'AACCC5678F', city: 'Chennai, Tamil Nadu' },
  { name: 'Mysore Industrial Supplies', state: '29', pan: 'AADCM9012G', city: 'Bengaluru, Karnataka' },
];
const DEPARTMENTS = [{ code: 'MNT', name: 'Maintenance' }, { code: 'PRD', name: 'Production' }, { code: 'QA', name: 'Quality' }];
const LINES = [
  { item: 'ITM-00001', qty: '700', remarks: 'IS 2062 grade' },
  { item: 'ITM-00002', qty: '500', remarks: 'FRLS insulation' },
  { item: 'ITM-00003', qty: '120' },
  { item: 'ITM-00004', qty: '300' },
  { item: 'ITM-00005', qty: '80', remarks: 'White, washed' },
];

const ind = (a: string) => `doc.indent:${a}`;
const vs = (a: string) => `doc.vendor_selection:${a}`;
const VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'];
const GRANTS: Record<string, string[]> = {
  requester: [...['view', 'add', 'edit', 'delete', 'submit', 'cancel', 'copy', 'comment', 'attach'].map(a => ind(`action.${a}`)), ...[...VIEWS, 'waiting_verify'].map(v => ind(`view.${v}`))],
  indent_clerk: [...['view', 'add', 'edit', 'submit', 'copy', 'comment', 'attach'].map(a => ind(`action.${a}`)), ...['draft', 'waiting_verify', 'rejected', 'approved', 'partially_approved'].map(v => ind(`view.${v}`))],
  approver: [...['view', 'comment', 'stage_verify', 'approve_quote'].map(a => ind(`action.${a}`)), ...[...VIEWS, 'waiting_verify'].map(v => ind(`view.${v}`)), 'approvals:action.view'],
  buyer: [
    ...['view', 'comment', 'log_quote', 'compare', 'short_close'].map(a => ind(`action.${a}`)), ...['approved', 'partially_approved', 'closed'].map(v => ind(`view.${v}`)),
    ...['view', 'add', 'edit', 'delete', 'submit', 'cancel', 'comment', 'attach'].map(a => vs(`action.${a}`)), ...[...VIEWS, 'waiting_approve'].map(v => vs(`view.${v}`)),
  ],
  store_keeper: [ind('action.view'), ind('view.approved')],
};

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>) => Promise<T>): Promise<T> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function grant(tx: Tx, tenantId: string, roleId: string, keys: string[]) {
  const known = new Set((await tx.selectFrom('app.permission_def').select('key').where('tenant_id', '=', tenantId).where('key', 'in', keys).execute()).map(r => r.key));
  const want = keys.filter(k => known.has(k) || k === 'approvals:action.view');
  if (!want.length) return;
  const have = new Set((await tx.selectFrom('app.permission_grant').select('perm_key').where('tenant_id', '=', tenantId).where('role_id', '=', roleId).where('perm_key', 'in', want).execute()).map(g => g.perm_key));
  const add = want.filter(k => !have.has(k));
  if (add.length) await tx.insertInto('app.permission_grant').values(add.map(perm_key => ({ tenant_id: tenantId, role_id: roleId, perm_key, effect: 'allow' as const }))).execute();
}

export async function seedProcurementDemoA(platformDb: Kysely<DB>): Promise<void> {
  const tenant = await platformDb.selectFrom('platform.tenant').select('id').where('code', '=', 'acme').executeTakeFirst();
  if (!tenant) return;
  const tid = tenant.id;
  await withApp(async app => {
    const db = app.get(DbService);
    const ent = app.get(EntitlementsService);
    const user = (tx: Tx, email: string) => tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', tid).where('email', '=', email).executeTakeFirst();

    // 1. System types (all registered install steps) for every demo tenant, as provisioning does; acme role grants.
    for (const t of await platformDb.selectFrom('platform.tenant').select('id').where('status', '!=', 'archived').execute()) {
      if (t.id === tid) continue;
      await db.tenantTx(t.id, tx => app.get(ProcurementInstaller).ensure(tx, t.id));
      await ent.bumpPermissions(t.id);
    }
    await db.tenantTx(tid, async tx => {
      const admin = (await user(tx, 'admin@acme.test'))!;
      await app.get(ProcurementInstaller).ensure(tx, tid, { actorId: admin.id });
      const roles = await tx.selectFrom('app.role').select(['id', 'key']).where('tenant_id', '=', tid).where('key', 'in', Object.keys(GRANTS)).where('is_deleted', '=', false).execute();
      for (const r of roles) await grant(tx, tid, r.id, GRANTS[r.key]!);
    });
    await ent.bumpPermissions(tid);

    // 2. Departments + vendors (GSTIN with a valid check character, state code).
    const vendorIds: string[] = [];
    await db.tenantTx(tid, async tx => {
      const actor = { tenantId: tid, userId: null, perms: null };
      const masters = app.get(MastersService);
      const records = app.get(RecordsService);
      const dep = await masters.find(tx, tid, 'department');
      const ven = await masters.find(tx, tid, 'vendor');
      if (!dep || !ven) return;
      for (const d of DEPARTMENTS) {
        const has = await tx.selectFrom('app.master_record').select('id').where('tenant_id', '=', tid).where('master_id', '=', dep.id).where('is_deleted', '=', false)
          .where(sql<boolean>`code = ${d.code}::citext`).executeTakeFirst();
        if (!has) await records.save(tx, actor, dep, { code: d.code, name: d.name, data: {} }, null);
      }
      for (const v of VENDORS) {
        const gstin14 = `${v.state}${v.pan}1Z`;
        const data = { gstin: `${gstin14}${validators.gstinCheckChar(gstin14)}`, pan: v.pan, state_code: v.state, address: v.city, email: `sales@${v.name.split(' ')[0]!.toLowerCase()}.example` };
        const has = await tx.selectFrom('app.master_record').select('id').where('tenant_id', '=', tid).where('master_id', '=', ven.id).where('is_deleted', '=', false)
          .where('name', '=', v.name).executeTakeFirst();
        vendorIds.push(has ? has.id : (await records.save(tx, actor, ven, { name: v.name, data }, null)).id);
      }
    });
    if (vendorIds.length !== 3) return;

    // 3. Approved 5-line indent: raised + submitted by the indent clerk, verified by the admin.
    const indentId = await db.tenantTx(tid, async tx => {
      const type = await tx.selectFrom('app.doc_type').select('id').where('tenant_id', '=', tid).where('key', '=', 'indent').executeTakeFirst();
      if (!type) return null;
      const existing = await tx.selectFrom('app.document').select('id').where('tenant_id', '=', tid).where('doc_type_id', '=', type.id).where('is_deleted', '=', false)
        .where(sql<boolean>`custom->>'purpose' = ${PURPOSE}`).executeTakeFirst();
      if (existing) return existing.id;
      const clerk = (await user(tx, 'indenter@acme.test')) ?? (await user(tx, 'admin@acme.test'))!;
      const pune = await tx.selectFrom('app.location_node').select('id').where('tenant_id', '=', tid).where('code', '=', 'PUNE').executeTakeFirst();
      const dept = await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id').select('r.id')
        .where('r.tenant_id', '=', tid).where('d.key', '=', 'department').where(sql<boolean>`r.code = 'MNT'::citext`).executeTakeFirst();
      const items = await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id').select(['r.id', 'r.code'])
        .where('r.tenant_id', '=', tid).where('d.key', '=', 'item').where('r.code', 'in', LINES.map(l => l.item)).execute();
      const itemId = new Map(items.map(i => [String(i.code).toUpperCase(), i.id]));
      if (!pune || LINES.some(l => !itemId.has(l.item))) return null;
      const docs = app.get(DocumentsService);
      const actor = { tenantId: tid, userId: clerk.id, perms: null };
      const doc = await docs.create(tx, actor, 'indent', {
        values: { location: pune.id, department: dept?.id, priority: 'Urgent', purpose: PURPOSE },
        lines: LINES.map(l => ({ values: { item: itemId.get(l.item), qty: l.qty, ...(l.remarks ? { remarks: l.remarks } : {}) } })),
      });
      const sub = await docs.submit(tx, actor, 'indent', doc.id, doc.version);
      if (sub.statusKey === 'waiting_verify') {
        const admin = (await user(tx, 'admin@acme.test'))!;
        const perms = await app.get(PermissionResolverService).resolve(tid, admin.id, true);
        await app.get(EngineService).act(tx, 'indent', doc.id, {
          action: 'decide', stageKey: 'verify', comment: 'Verified against the maintenance plan',
          decisions: sub.lines.map(l => ({ lineId: l.id, approve: String(l.values.qty), hold: '0', reject: '0' })),
        }, { userId: admin.id, perms }, {});
      }
      return doc.id;
    });
    if (!indentId) return;

    // 4. Quotes (only once) and 5. the split selection (only once).
    await db.tenantTx(tid, async tx => {
      const admin = (await user(tx, 'admin@acme.test'))!;
      const actor = { tenantId: tid, userId: admin.id, perms: null };
      const lines = await tx.selectFrom('app.document_line').select(['id', 'line_no']).where('tenant_id', '=', tid).where('document_id', '=', indentId)
        .where('is_deleted', '=', false).orderBy('line_no').execute();
      const sums = await tx.selectFrom('app.line_qty_summary').select(['line_id', 'approved']).where('tenant_id', '=', tid).where('line_id', 'in', lines.map(l => l.id)).execute();
      if (!sums.length || sums.some(s => Number(s.approved) <= 0)) return;
      const [a, b, c] = vendorIds as [string, string, string];
      const quotes = app.get(QuotesService);
      const logged = await tx.selectFrom('app.vendor_quote').select('id').where('tenant_id', '=', tid).where('indent_line_id', '=', lines[0]!.id).executeTakeFirst();
      let quoteA: string | undefined;
      let quoteB: string | undefined;
      if (!logged) {
        const base = { currency: 'INR', freight: '0', freightBasis: 'lump_sum' as const, fileIds: [], custom: {}, alsoForLineIds: [] as string[], slabs: [] as { fromQty: string; toQty?: string; rate?: string; discountPct?: string }[] };
        quoteA = (await quotes.log(tx, actor, lines[0]!.id, {
          ...base, vendorId: a, quotedRate: '50', taxPct: '18', leadTimeDays: 7, moq: '100', freight: '2500', notes: 'Slab offer on phone',
          slabs: [{ fromQty: '0', toQty: '999', rate: '50' }, { fromQty: '1000', discountPct: '10' }],
        }))[0]!.id;
        quoteB = (await quotes.log(tx, actor, lines[0]!.id, { ...base, vendorId: b, quotedRate: '48.5', taxPct: '18', leadTimeDays: 12, freight: '6', freightBasis: 'per_unit' }))[0]!.id;
        await quotes.log(tx, actor, lines[0]!.id, { ...base, vendorId: c, quotedRate: '51', taxPct: '18', leadTimeDays: 4, validUntil: '2026-01-31' });
        await quotes.log(tx, actor, lines[1]!.id, { ...base, vendorId: a, quotedRate: '39.2', taxPct: '18', leadTimeDays: 5 });
        await quotes.log(tx, actor, lines[1]!.id, { ...base, vendorId: c, quotedRate: '38.6', taxPct: '18', leadTimeDays: 9, moq: '1000' });
        await quotes.log(tx, actor, lines[2]!.id, { ...base, vendorId: b, quotedRate: '242', taxPct: '18', leadTimeDays: 10 });
      }
      const selected = await tx.selectFrom('app.line_link').select('id').where('tenant_id', '=', tid).where('from_line_id', '=', lines[0]!.id).where('link_type', '=', 'selected').executeTakeFirst();
      if (selected) return;
      const q = async (vendor: string) => quoteA && vendor === a ? quoteA : quoteB && vendor === b ? quoteB
        : (await tx.selectFrom('app.vendor_quote').select('id').where('tenant_id', '=', tid).where('indent_line_id', '=', lines[0]!.id).where('vendor_id', '=', vendor).where('is_current', '=', true).executeTakeFirst())?.id;
      await app.get(SelectionService).create(tx, actor, {
        values: {}, submit: true,
        lines: [
          { indentLineId: lines[0]!.id, vendorId: a, quoteId: await q(a), qty: '300', rate: '50' },
          { indentLineId: lines[0]!.id, vendorId: b, quoteId: await q(b), qty: '400', rate: '48.5', reason: 'Split for supply security' },
        ],
      });
    });
    await ent.bumpPermissions(tid);
  });
}

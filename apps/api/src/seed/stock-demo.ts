/**
 * Demo seed — Stock (Phase 5, stock agent). Idempotent; called from demo.ts after the procurement seeds.
 * acme (feature overrides grn + store on, see demo.ts):
 *   - store document types (stock_transfer / stock_adjustment / stock_count) via the shared installer
 *   - stock keys for the starter roles (store keeper, approver)
 *   - opening balances for the 5 demo items at Main Store (as of the FY start, at their standard rates)
 *   - re-order rules for 2 items at Main Store
 *   - one stock transfer Main Store → Bin A1, approved through the workflow engine (post_stock)
 * Everything goes through the real services (StockLedger, documents, workflow engine, audit, outbox).
 */
import { NestFactory } from '@nestjs/core';
import type { StockPost } from '@procure/schema';
import { sql, type Kysely } from 'kysely';
import { AppModule } from '../app.module';
import type { DB } from '../core/db-types';
import { DbService, Tx } from '../core/db.service';
import { EntitlementsService } from '../core/entitlements.service';
import { DocumentsService, financialYear, TenantCalendar } from '../modules/documents';
import { tenantToday } from '../modules/forms';
import { PermissionResolverService } from '../modules/permissions';
import { ProcurementInstaller } from '../modules/procurement';
import { NO_BATCH, StockLedger } from '../modules/stock';
import { EngineService } from '../modules/workflow';

const OPENING: { item: string; qty: string; rate: string }[] = [
  { item: 'ITM-00001', qty: '1200', rate: '62.50' },
  { item: 'ITM-00002', qty: '800', rate: '38.75' },
  { item: 'ITM-00003', qty: '150', rate: '245' },
  { item: 'ITM-00004', qty: '400', rate: '18.40' },
  { item: 'ITM-00005', qty: '90', rate: '55' },
];
const RULES = [
  { item: 'ITM-00001', min: '500', reorder: '1000', max: '2000', autoIndent: false },
  { item: 'ITM-00005', min: '100', reorder: '150', max: null, autoIndent: true },
];
const TRANSFER_REMARKS = 'Demo: replenish Bin A1 from Main Store';

const STORE_VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed', 'waiting_approve'];
const storeDoc = (type: string, actions: string[]) => [...actions.map(a => `doc.${type}:action.${a}`), ...STORE_VIEWS.map(v => `doc.${type}:view.${v}`)];
const STOCK_VIEW = ['stock', 'stock:action.view', 'stock:view.available', 'stock:view.quarantine', 'stock:view.rejected'];
const GRANTS: Record<string, string[]> = {
  store_keeper: [
    ...STOCK_VIEW, 'stock:action.block', 'stock:action.reorder',
    ...['stock_transfer', 'stock_adjustment', 'stock_count'].flatMap(t => storeDoc(t, ['view', 'add', 'edit', 'delete', 'submit', 'cancel', 'comment', 'attach'])),
  ],
  approver: [
    ...STOCK_VIEW, 'stock:action.view_value',
    ...['stock_transfer', 'stock_adjustment', 'stock_count'].flatMap(t => storeDoc(t, ['view', 'comment', 'stage_approve'])),
  ],
};

async function grant(tx: Tx, tenantId: string, roleId: string, keys: string[]) {
  const known = new Set((await tx.selectFrom('app.permission_def').select('key').where('tenant_id', '=', tenantId).where('key', 'in', keys).execute()).map(r => r.key));
  // stock:* keys live in the platform registry (migration 0015); doc.* keys in the tenant's own registry rows.
  const want = keys.filter(k => known.has(k) || k === 'stock' || k.startsWith('stock:'));
  if (!want.length) return;
  const have = new Set((await tx.selectFrom('app.permission_grant').select('perm_key').where('tenant_id', '=', tenantId).where('role_id', '=', roleId).where('perm_key', 'in', want).execute()).map(g => g.perm_key));
  const add = want.filter(k => !have.has(k));
  if (add.length) await tx.insertInto('app.permission_grant').values(add.map(perm_key => ({ tenant_id: tenantId, role_id: roleId, perm_key, effect: 'allow' as const }))).execute();
}

export async function seedStockDemo(platformDb: Kysely<DB>): Promise<void> {
  const tenant = await platformDb.selectFrom('platform.tenant').select('id').where('code', '=', 'acme').executeTakeFirst();
  if (!tenant) return;
  const tid = tenant.id;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get(DbService);
    const ent = app.get(EntitlementsService);
    await ent.invalidate(tid);
    if (!(await ent.hasFeature(tid, 'store'))) return;
    const user = (tx: Tx, email: string) => tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', tid).where('email', '=', email).executeTakeFirst();
    const node = (tx: Tx, code: string) => tx.selectFrom('app.location_node').select('id').where('tenant_id', '=', tid).where('code', '=', code).executeTakeFirst();
    const items = async (tx: Tx) => new Map((await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id').select(['r.id', 'r.code'])
      .where('r.tenant_id', '=', tid).where('d.key', '=', 'item').where('r.code', 'in', OPENING.map(o => o.item)).execute()).map(i => [String(i.code).toUpperCase(), i.id]));

    // 1. Store types (shared installer, same as provisioning) + role grants.
    await db.tenantTx(tid, async tx => {
      const admin = (await user(tx, 'admin@acme.test'))!;
      await app.get(ProcurementInstaller).ensure(tx, tid, { actorId: admin.id });
      const roles = await tx.selectFrom('app.role').select(['id', 'key']).where('tenant_id', '=', tid).where('key', 'in', Object.keys(GRANTS)).where('is_deleted', '=', false).execute();
      for (const r of roles) await grant(tx, tid, r.id, GRANTS[r.key]!);
    });
    await ent.bumpPermissions(tid);

    // 2. Opening balances at Main Store (idempotency keys make a re-run a no-op) + 3. re-order rules.
    await db.tenantTx(tid, async tx => {
      const main = await node(tx, 'PUNE-MAIN');
      const ids = await items(tx);
      if (!main || OPENING.some(o => !ids.has(o.item))) return;
      const admin = (await user(tx, 'admin@acme.test'))!;
      const today = await tenantToday(tx);
      const fy = financialYear(today, await app.get(TenantCalendar).fyStartMonth(tid));
      const fyStart = `${fy.start}-${String(await app.get(TenantCalendar).fyStartMonth(tid)).padStart(2, '0')}-01`;
      const posts: StockPost[] = OPENING.map(o => ({
        itemId: ids.get(o.item)!, nodeId: main.id, status: 'available', movementType: 'opening', qtyIn: o.qty, unitCost: o.rate,
        reason: `Opening balance as of ${fyStart}`, idempotencyKey: `opening:${ids.get(o.item)}:${main.id}:${NO_BATCH}`,
      }));
      await app.get(StockLedger).post(tx, posts, admin.id, { at: new Date(`${fyStart}T00:00:00Z`), skipReorder: true });
      for (const r of RULES) {
        await tx.insertInto('app.reorder_rule').values({
          tenant_id: tid, item_id: ids.get(r.item)!, node_id: main.id, min_qty: r.min, reorder_qty: r.reorder, max_qty: r.max, auto_indent: r.autoIndent, created_by: admin.id,
        }).onConflict(oc => oc.columns(['tenant_id', 'item_id', 'node_id']).doNothing()).execute();
      }
    });

    // 4. One transfer Main Store → Bin A1, approved through the workflow (post_stock moves the stock).
    await db.tenantTx(tid, async tx => {
      const type = await tx.selectFrom('app.doc_type').select('id').where('tenant_id', '=', tid).where('key', '=', 'stock_transfer').executeTakeFirst();
      if (!type) return;
      const existing = await tx.selectFrom('app.document').select('id').where('tenant_id', '=', tid).where('doc_type_id', '=', type.id).where('is_deleted', '=', false)
        .where(sql<boolean>`custom->>'remarks' = ${TRANSFER_REMARKS}`).executeTakeFirst();
      if (existing) return;
      const main = await node(tx, 'PUNE-MAIN');
      const bin = await node(tx, 'PUNE-MAIN-A1');
      const ids = await items(tx);
      if (!main || !bin) return;
      const admin = (await user(tx, 'admin@acme.test'))!;
      const keeper = (await user(tx, 'indenter@acme.test')) ?? admin;
      const checker = keeper.id === admin.id ? ((await user(tx, 'approver@acme.test')) ?? admin) : admin;
      const docs = app.get(DocumentsService);
      const actor = { tenantId: tid, userId: keeper.id, perms: null };
      const doc = await docs.create(tx, actor, 'stock_transfer', {
        values: { location: main.id, to_location: bin.id, remarks: TRANSFER_REMARKS },
        lines: [{ values: { item: ids.get('ITM-00001'), qty: '200' } }, { values: { item: ids.get('ITM-00004'), qty: '50' } }],
      });
      const sub = await docs.submit(tx, actor, 'stock_transfer', doc.id, doc.version);
      if (sub.statusKey === 'waiting_approve') {
        const perms = await app.get(PermissionResolverService).resolve(tid, checker.id, checker.id === admin.id);
        await app.get(EngineService).act(tx, 'stock_transfer', doc.id, {
          action: 'decide', stageKey: 'approve', comment: 'Bin A1 running low',
          decisions: sub.lines.map(l => ({ lineId: l.id, approve: String(l.values.qty), hold: '0', reject: '0' })),
        }, { userId: checker.id, perms }, {});
      }
    });
    await ent.bumpPermissions(tid);
  } finally {
    await app.close();
  }
}

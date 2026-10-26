import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from '../../../core/db.service';
import { QueueService } from '../../../core/queue.service';
import { getTenantSetting } from '../../identity';
import { canon, D, dec } from '../ledger/decimal';

export const STOCK_QUEUE = 'stock';
const NIL = '00000000-0000-0000-0000-000000000000';
const SAMPLE = 500;

export interface DriftRow { kind: 'balance' | 'avg_cost' | 'fifo'; itemId: string; nodeId: string; batchKey?: string; status?: string; stored: { qty: string; value?: string }; ledger: { qty: string; value?: string } }

/**
 * Nightly drift check (ADR-0016 §7, same idea as the quantity-ledger check): for a random sample of balance rows per
 * tenant, recomputes qty/value from the movement ledger and compares; also checks item_avg_cost totals and FIFO
 * layers. Any drift is logged, emitted (`stock.drift_detected`) and sent to the tenant admins in-app. Never repairs.
 */
@Injectable()
export class StockDriftCheck implements OnModuleInit {
  private readonly log = new Logger('StockDrift');
  constructor(private readonly db: DbService, private readonly queue: QueueService) {}

  onModuleInit() {
    this.queue.registerProcessor(STOCK_QUEUE, async job => (job.name === 'stock-drift' ? this.runAll() : undefined), 1);
    this.queue.registerRepeat(STOCK_QUEUE, 'stock-drift', { pattern: '50 2 * * *' });
  }

  async runAll(): Promise<{ tenants: number; drifted: number }> {
    const tenants = await this.db.tenantTx(NIL, async tx => (await sql<{ tenant_id: string }>`select tenant_id from app.stock_tenants()`.execute(tx)).rows.map(r => r.tenant_id));
    let drifted = 0;
    for (const t of tenants) {
      try {
        if ((await this.checkTenant(t)).length) drifted++;
      } catch (e) {
        this.log.warn(`stock drift check failed for tenant ${t}: ${(e as Error).message}`);
      }
    }
    return { tenants: tenants.length, drifted };
  }

  async checkTenant(tenantId: string, sample = SAMPLE): Promise<DriftRow[]> {
    return this.db.tenantTx(tenantId, async tx => {
      const bal = await sql<{ item_id: string; node_id: string; batch_key: string; stock_status: string; qty: string; value: string; lqty: string; lvalue: string }>`
        with s as (select * from app.stock_balance where tenant_id = ${tenantId} order by random() limit ${sample})
        select s.item_id, s.node_id, s.batch_key::text as batch_key, s.stock_status, s.qty::text as qty, s.value::text as value,
               coalesce(sum(m.qty_in - m.qty_out), 0)::text as lqty, coalesce(sum(m.value), 0)::text as lvalue
          from s left join app.stock_movement m on m.tenant_id = s.tenant_id and m.item_id = s.item_id and m.node_id = s.node_id
               and coalesce(m.batch_id, '00000000-0000-0000-0000-000000000000'::uuid) = s.batch_key and m.stock_status = s.stock_status
         group by s.item_id, s.node_id, s.batch_key, s.stock_status, s.qty, s.value
        having s.qty <> coalesce(sum(m.qty_in - m.qty_out), 0) or s.value <> coalesce(sum(m.value), 0)`.execute(tx);
      const fifo = (await getTenantSetting(tx, 'stock.valuation')) === 'fifo';
      const avg = await sql<{ item_id: string; node_id: string; qty: string; value: string; lqty: string; lvalue: string; layers: string | null; legacy: string | null }>`
        with s as (select * from app.item_avg_cost where tenant_id = ${tenantId} order by random() limit ${sample})
        select s.item_id, s.node_id, s.qty::text as qty, s.value::text as value,
               coalesce((select sum(qty_in - qty_out) from app.stock_movement m where m.tenant_id = s.tenant_id and m.item_id = s.item_id and m.node_id = s.node_id), 0)::text as lqty,
               coalesce((select sum(value) from app.stock_movement m where m.tenant_id = s.tenant_id and m.item_id = s.item_id and m.node_id = s.node_id), 0)::text as lvalue,
               (select sum(qty_left)::text from app.valuation_layer v where v.tenant_id = s.tenant_id and v.item_id = s.item_id and v.node_id = s.node_id) as layers,
               -- carried-over stock still without layers, at most: stock held before FIFO started here (movements before
               -- the first layer) less the outs since then, which consume it first (rtv outs may take their own receipt's
               -- layer instead, so they are not counted)
               (select greatest(coalesce(sum(case when m.id < f.first then m.qty_in - m.qty_out else 0 end), 0)
                               - coalesce(sum(case when m.id > f.first and m.movement_type not in ('block', 'unblock', 'reject', 'rtv') then m.qty_out else 0 end), 0), 0)::text
                  from app.stock_movement m,
                       (select min(v.movement_id) as first from app.valuation_layer v where v.tenant_id = s.tenant_id and v.item_id = s.item_id and v.node_id = s.node_id) f
                 where m.tenant_id = s.tenant_id and m.item_id = s.item_id and m.node_id = s.node_id) as legacy
          from s`.execute(tx);
      const out: DriftRow[] = bal.rows.map(r => ({
        kind: 'balance', itemId: r.item_id, nodeId: r.node_id, batchKey: r.batch_key, status: r.stock_status,
        stored: { qty: canon(r.qty), value: canon(r.value) }, ledger: { qty: canon(r.lqty), value: canon(r.lvalue) },
      }));
      for (const r of avg.rows) {
        if (canon(r.qty) !== canon(r.lqty) || canon(r.value) !== canon(r.lvalue)) {
          out.push({ kind: 'avg_cost', itemId: r.item_id, nodeId: r.node_id, stored: { qty: canon(r.qty), value: canon(r.value) }, ledger: { qty: canon(r.lqty), value: canon(r.lvalue) } });
        }
        // FIFO layers — only while FIFO is the method in force (QA5-BUG-004). Stock carried over from a WAC period has
        // no layers and is consumed first, so open layers must lie in [node qty − carried-over qty, node qty]; with no
        // carried-over stock that is exact equality.
        if (fifo && r.layers !== null && Number(r.qty) >= 0 && Number(r.layers) > 0) {
          const layers = dec(r.layers);
          const qty = dec(r.qty);
          const legacy = D.max(dec(r.legacy ?? '0'), 0);
          if (layers.gt(qty) || layers.lt(qty.minus(legacy))) {
            out.push({ kind: 'fifo', itemId: r.item_id, nodeId: r.node_id, stored: { qty: canon(r.layers) }, ledger: { qty: canon(r.qty) } });
          }
        }
      }
      if (out.length) {
        this.log.error(`stock drift in tenant ${tenantId}: ${out.length} row(s), e.g. ${JSON.stringify(out[0])}`);
        await tx.insertInto('app.outbox_event').values({ event_type: 'stock.drift_detected', aggregate_kind: 'stock', aggregate_id: null, payload: JSON.stringify({ count: out.length, rows: out.slice(0, 50) }) }).execute();
        const admins = await tx.selectFrom('app.tenant_user').select('id').where('is_tenant_admin', '=', true).where('is_active', '=', true).where('is_deleted', '=', false).execute();
        if (admins.length) {
          await tx.insertInto('app.notification').values(admins.map(a => ({
            tenant_id: tenantId, user_id: a.id, kind: 'stock_drift', title: 'Stock balances differ from the stock ledger',
            body: `${out.length} balance row(s) do not match their movements. Contact support.`, link: '/stock', data: JSON.stringify({ count: out.length }),
          }))).execute();
        }
      }
      return out;
    });
  }
}

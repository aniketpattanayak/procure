import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import { DocumentsService } from '../../documents';
import { canon, dec, q4 } from './decimal';

export const REORDER_KEY = 'stock:action.reorder';
export const STOCK_TAB = 'stock';
const FAN_OUT_CAP = 200;
const INDENT = 'indent';

export interface BelowMin {
  ruleId: string; itemId: string; nodeId: string; nodePath: string; available: string; minQty: string; reorderQty: string; maxQty: string | null;
  autoIndent: boolean; suggestedQty: string; lastAlertAt: Date | null;
}

/**
 * Re-order levels (contract "Stock ledger"): after every out of available stock the ledger asks `check` for the
 * touched item × node pairs. A rule on a node covers that node's subtree (a store with bins). When available stock
 * in the subtree drops below `min_qty`: outbox `stock.below_min`, in-app alert to holders of `stock:action.reorder`
 * whose data scope covers the node, at most once per rule per day (`last_alert_at`), and with `auto_indent` a draft
 * indent line for the suggested qty (failures there never block the stock movement).
 */
@Injectable()
export class ReorderService {
  private readonly log = new Logger('StockReorder');
  constructor(private readonly docs: DocumentsService) {}

  /** Rules (active) covering any of the touched pairs whose subtree available qty is below min. */
  async belowMin(tx: Tx, tenantId: string, filter: { pairs?: { itemId: string; nodeId: string }[]; nodeId?: string; ruleIds?: string[] } = {}): Promise<BelowMin[]> {
    const pairs = filter.pairs ?? [];
    const rows = await sql<{
      id: string; item_id: string; node_id: string; path: string; min_qty: string; reorder_qty: string; max_qty: string | null; auto_indent: boolean;
      last_alert_at: Date | null; available: string;
    }>`
      select r.id, r.item_id, r.node_id, n.path::text as path, r.min_qty::text as min_qty, r.reorder_qty::text as reorder_qty, r.max_qty::text as max_qty,
             r.auto_indent, r.last_alert_at,
             coalesce((select sum(b.qty) from app.stock_balance b join app.location_node bn on bn.id = b.node_id
                        where b.tenant_id = r.tenant_id and b.item_id = r.item_id and b.stock_status = 'available' and bn.path <@ n.path), 0)::text as available
        from app.reorder_rule r join app.location_node n on n.id = r.node_id
       where r.tenant_id = ${tenantId} and r.is_active
         ${pairs.length ? sql`and exists (select 1 from unnest(${sql.val(pairs.map(p => p.itemId))}::uuid[], ${sql.val(pairs.map(p => p.nodeId))}::uuid[]) as t(i, nd)
                                 join app.location_node tn on tn.id = t.nd where t.i = r.item_id and tn.path <@ n.path)` : sql``}
         ${filter.nodeId ? sql`and n.path <@ (select path from app.location_node where id = ${filter.nodeId})` : sql``}
         ${filter.ruleIds?.length ? sql`and r.id = any(${sql.val(filter.ruleIds)}::uuid[])` : sql``}
       order by n.path, r.item_id`.execute(tx);
    return rows.rows.filter(r => dec(r.available).lt(dec(r.min_qty))).map(r => {
      const avail = dec(r.available);
      // Suggested: up to max when set, else the re-order qty; never less than what brings stock back to min.
      const toMax = r.max_qty !== null ? dec(r.max_qty).minus(avail) : null;
      const toMin = dec(r.min_qty).minus(avail);
      let s = toMax && toMax.gt(0) ? toMax : dec(r.reorder_qty);
      if (s.lt(toMin)) s = toMin;
      return {
        ruleId: r.id, itemId: r.item_id, nodeId: r.node_id, nodePath: r.path, available: canon(r.available), minQty: canon(r.min_qty), reorderQty: canon(r.reorder_qty),
        maxQty: r.max_qty === null ? null : canon(r.max_qty), autoIndent: r.auto_indent, suggestedQty: q4(s), lastAlertAt: r.last_alert_at,
      };
    });
  }

  /** Called by the ledger (same transaction) after outs of available stock. */
  async check(tx: Tx, tenantId: string, pairs: { itemId: string; nodeId: string }[], actorId: string | null): Promise<void> {
    const due = await this.belowMin(tx, tenantId, { pairs });
    for (const r of due) {
      // Throttle: claim the rule for today (row lock + conditional update; concurrent posts alert once).
      const claimed = await tx.updateTable('app.reorder_rule').set({ last_alert_at: new Date() })
        .where('id', '=', r.ruleId).where(eb => eb.or([eb('last_alert_at', 'is', null), eb(sql`last_alert_at::date`, '<', sql`current_date`)]))
        .executeTakeFirst();
      if (!Number(claimed.numUpdatedRows)) continue;
      const item = await tx.selectFrom('app.master_record').select(['code', 'name']).where('id', '=', r.itemId).executeTakeFirst();
      const node = await tx.selectFrom('app.location_node').select(['name']).where('id', '=', r.nodeId).executeTakeFirst();
      const label = `${item?.code ?? ''} ${item?.name ?? ''}`.trim();
      let indentId: string | null = null;
      if (r.autoIndent) indentId = await this.autoIndent(tx, tenantId, r);
      await tx.insertInto('app.outbox_event').values({
        event_type: 'stock.below_min', aggregate_kind: 'reorder_rule', aggregate_id: r.ruleId,
        payload: JSON.stringify({ ruleId: r.ruleId, itemId: r.itemId, nodeId: r.nodeId, available: r.available, minQty: r.minQty, suggestedQty: r.suggestedQty, indentId, actorId }),
      }).execute();
      const users = await this.recipients(tx, r.nodePath);
      if (users.length) {
        await tx.insertInto('app.notification').values(users.map(user_id => ({
          tenant_id: tenantId, user_id, kind: 'stock_below_min',
          title: `${label || 'An item'} is below its re-order level at ${node?.name ?? 'a store'}`.slice(0, 300),
          body: `Available ${r.available}, minimum ${r.minQty}. Suggested order: ${r.suggestedQty}.${indentId ? ' A draft indent was created.' : ''}`,
          link: indentId ? `/docs/indent/${indentId}` : `/stock/reorder?node=${r.nodeId}`,
          data: JSON.stringify({ ruleId: r.ruleId, itemId: r.itemId, nodeId: r.nodeId, indentId }),
        }))).execute();
      }
    }
  }

  /** Active users holding stock:action.reorder (tenant admins, role or user grants, minus denies) whose scope covers the node. */
  async recipients(tx: Tx, nodePath: string): Promise<string[]> {
    const mine = (a: string) => sql`(${sql.ref(`${a}.user_id`)} = u.id or ${sql.ref(`${a}.role_id`)} in (select ur.role_id from app.user_role ur join app.role ro on ro.id = ur.role_id and not ro.is_deleted where ur.user_id = u.id))`;
    const rows = await sql<{ id: string }>`
      select u.id from app.tenant_user u
       where u.is_active and not u.is_deleted
         and (u.is_tenant_admin or (
              exists (select 1 from app.permission_grant g where ${mine('g')} and g.perm_key = ${REORDER_KEY} and g.effect = 'allow')
          and not exists (select 1 from app.permission_grant g where ${mine('g')} and g.perm_key = ${REORDER_KEY} and g.effect = 'deny')
          and exists (select 1 from app.scope_grant sg left join app.location_node sn on sn.id = sg.node_id
                       where ${mine('sg')}
                         and sg.tab_key is not distinct from (case when exists (select 1 from app.scope_grant sg2 where ${mine('sg2')} and sg2.tab_key = ${STOCK_TAB}) then ${STOCK_TAB} else null end)
                         and (sg.all_nodes or (sg.include_descendants and ${nodePath}::ltree <@ sn.path) or (not sg.include_descendants and sn.path = ${nodePath}::ltree)))))
       order by u.id limit ${FAN_OUT_CAP}`.execute(tx);
    return rows.rows.map(r => r.id);
  }

  /** Draft indent (engine actor) with one line for the suggested qty; null when indents are not installed or it fails. */
  private async autoIndent(tx: Tx, tenantId: string, r: BelowMin): Promise<string | null> {
    const t = await this.docs.types.find(tx, tenantId, INDENT);
    if (!t || !t.is_active) return null;
    await sql`savepoint stock_auto_indent`.execute(tx);
    try {
      const row = await this.docs.create(tx, { tenantId, userId: null, perms: null }, INDENT, {
        values: { location: r.nodeId, purpose: 'Auto-raised: stock below re-order level' },
        lines: [{ values: { item: r.itemId, qty: r.suggestedQty, remarks: `Re-order rule: available ${r.available} < min ${r.minQty}` } }],
      });
      await sql`release savepoint stock_auto_indent`.execute(tx);
      return row.id;
    } catch (e) {
      await sql`rollback to savepoint stock_auto_indent`.execute(tx);
      this.log.warn(`auto indent failed for rule ${r.ruleId}: ${(e as Error).message}`);
      return null;
    }
  }
}

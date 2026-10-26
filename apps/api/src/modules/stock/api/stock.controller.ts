import { Body, Controller, Delete, Get, HttpCode, Param, PipeTransform, Post, Put, Query } from '@nestjs/common';
import {
  BlockInput, CountSnapshotInput, DocumentRow, LedgerQuery, MyPermissions, OpeningBalanceInput, Page, ReorderRuleInput, StockBalanceRow, StockLedgerRow, StockQuery,
} from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../../core/auth/permissions';
import { DbService } from '../../../core/db.service';
import { tenantPrincipal } from '../../../core/request-context';
import { Zod } from '../../../core/zod';
import { UuidParam } from '../../identity';
import { StockCommandService } from './stock-command.service';
import { StockActor, StockQueryService } from './stock-query.service';

const NodeQuery = z.object({ node: z.string().uuid().optional() });
// QA5-BUG-008: paged (offset cursor as in balances); totalValue still covers every page.
const ValuationQuery = z.object({
  node: z.string().uuid().optional(), asOf: z.string().date().optional(), cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});
const ItemId = new UuidParam('Item');
const RuleId = new UuidParam('Re-order rule');
const NO_PERMS: MyPermissions = { keys: [], scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 };

/**
 * The frozen query schemas use `z.coerce.boolean()`, which turns the string "false" into true. Query strings
 * "false" / "0" / "" are mapped to a real false before validation.
 */
class QueryBooleans implements PipeTransform<Record<string, unknown>> {
  transform(v: Record<string, unknown>) {
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = { ...v };
    for (const k of ['includeChildren', 'byBatch', 'belowMin']) if (out[k] === 'false' || out[k] === '0' || out[k] === '') out[k] = false;
    return out;
  }
}

function actor(perms: MyPermissions | undefined): StockActor {
  const p = tenantPrincipal();
  return { tenantId: p.tenantId, userId: p.userId, perms: perms ?? NO_PERMS };
}

/** Stock ledger endpoints (contract "Stock ledger"). Data scope on the node (tab `stock`); values need view_value. */
@TenantOnly()
@Controller('stock')
export class StockController {
  constructor(private readonly db: DbService, private readonly query: StockQueryService, private readonly cmd: StockCommandService) {}

  @Get('balances')
  @Requires('stock:action.view')
  balances(@Query(new QueryBooleans(), new Zod(StockQuery)) q: z.infer<typeof StockQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<Page<StockBalanceRow>> {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.query.balances(tx, a, q));
  }

  @Get('ledger')
  @Requires('stock:action.view')
  ledger(@Query(new QueryBooleans(), new Zod(LedgerQuery)) q: z.infer<typeof LedgerQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<Page<StockLedgerRow>> {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.query.ledger(tx, a, q));
  }

  @Get('items/:itemId/summary')
  @Requires('stock:action.view')
  summary(@Param('itemId', ItemId) itemId: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.query.itemSummary(tx, a, itemId));
  }

  @Post('opening')
  @HttpCode(200)
  @Requires('stock:action.opening')
  opening(@Body(new Zod(OpeningBalanceInput)) body: z.infer<typeof OpeningBalanceInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.cmd.opening(tx, a, body));
  }

  @Post('block')
  @HttpCode(200)
  @Requires('stock:action.block')
  block(@Body(new Zod(BlockInput)) body: z.infer<typeof BlockInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.cmd.block(tx, a, body));
  }

  @Get('reorder-rules')
  @Requires('stock:action.reorder')
  rules(@Query(new Zod(NodeQuery)) q: z.infer<typeof NodeQuery>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.cmd.rules(tx, a, q.node));
  }

  @Get('reorder-rules/:id')
  @Requires('stock:action.reorder')
  rule(@Param('id', RuleId) id: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.cmd.rule(tx, a, id));
  }

  @Post('reorder-rules')
  @Requires('stock:action.reorder')
  createRule(@Body(new Zod(ReorderRuleInput)) body: z.infer<typeof ReorderRuleInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.cmd.createRule(tx, a, body));
  }

  @Put('reorder-rules/:id')
  @Requires('stock:action.reorder')
  updateRule(@Param('id', RuleId) id: string, @Body(new Zod(ReorderRuleInput)) body: z.infer<typeof ReorderRuleInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.cmd.updateRule(tx, a, id, body));
  }

  @Delete('reorder-rules/:id')
  @HttpCode(204)
  @Requires('stock:action.reorder')
  async deleteRule(@Param('id', RuleId) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<void> {
    const a = actor(perms);
    await this.db.tenantTx(a.tenantId, tx => this.cmd.deleteRule(tx, a, id));
  }

  @Get('reorder')
  @Requires('stock:action.view')
  reorder(@Query(new Zod(NodeQuery)) q: z.infer<typeof NodeQuery>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.cmd.belowMin(tx, a, q.node));
  }

  @Get('valuation')
  @Requires('stock:action.view', 'stock:action.view_value')
  valuation(@Query(new Zod(ValuationQuery)) q: z.infer<typeof ValuationQuery>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.query.valuation(tx, a, q));
  }

  @Post('counts/snapshot')
  @Requires('doc.stock_count:action.add')
  snapshot(@Body(new Zod(CountSnapshotInput)) body: z.infer<typeof CountSnapshotInput>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.cmd.countSnapshot(tx, a, body));
  }
}

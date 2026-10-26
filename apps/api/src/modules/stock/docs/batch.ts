import { ErrorCode } from '@procure/schema';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Line `batch` values on store documents are batch numbers (text). Resolves to the stock_batch id of the item:
 * null when empty; with `create` a missing batch is created (receipts / adjustments in); otherwise 400.
 */
export async function resolveBatch(tx: Tx, itemId: string, value: unknown, opts: { create?: boolean; path?: string } = {}): Promise<string | null> {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (UUID_RE.test(s)) {
    const byId = await tx.selectFrom('app.stock_batch').select('id').where('id', '=', s).where('item_id', '=', itemId).executeTakeFirst();
    if (byId) return byId.id;
  }
  const row = await tx.selectFrom('app.stock_batch').select('id').where('item_id', '=', itemId).where('batch_no', '=', s).executeTakeFirst();
  if (row) return row.id;
  if (opts.create) {
    await tx.insertInto('app.stock_batch').values({ item_id: itemId, batch_no: s }).onConflict(oc => oc.columns(['tenant_id', 'item_id', 'batch_no']).doNothing()).execute();
    return (await tx.selectFrom('app.stock_batch').select('id').where('item_id', '=', itemId).where('batch_no', '=', s).executeTakeFirstOrThrow()).id;
  }
  const message = `Batch "${s}" does not exist for this item.`;
  throw new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path: opts.path ?? 'batch', message }]);
}

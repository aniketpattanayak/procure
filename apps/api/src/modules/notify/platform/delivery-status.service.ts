import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from '../../../core/db.service';

export type DeliveryEvent = 'sent' | 'delivered' | 'read' | 'failed';
const RANK: Record<string, number> = { queued: 0, sending: 1, failed: 1, sent: 2, delivered: 3, read: 4 };

/**
 * Applies provider delivery receipts (Meta statuses, SES via SNS) to app.outbound_message. Receipts arrive without
 * tenant context, so the row is found by (provider, provider_message_id) under the platform role. Status never
 * moves backwards (a late "delivered" after "read" is ignored); "failed" only applies before delivery.
 */
@Injectable()
export class DeliveryStatusService {
  private readonly log = new Logger('Notify');
  constructor(private readonly db: DbService) {}

  async apply(provider: 'meta' | 'ses' | 'bsp', providerMessageId: string, ev: DeliveryEvent, at: Date, error?: string | null): Promise<number> {
    if (!providerMessageId) return 0;
    return this.db.platformTx(async tx => {
      const row = await tx.selectFrom('app.outbound_message').select(['id', 'tenant_id', 'status', 'delivered_at', 'read_at'])
        .where('provider', '=', provider).where('provider_message_id', '=', providerMessageId).forUpdate().executeTakeFirst();
      if (!row) {
        this.log.debug(`receipt for unknown ${provider} message ${providerMessageId}`);
        return 0;
      }
      const cur = RANK[row.status] ?? 0;
      const patch: Record<string, unknown> = {};
      if (ev === 'failed') {
        if (cur >= RANK.delivered!) return 0;
        Object.assign(patch, { status: 'failed', error: (error ?? 'Delivery failed').slice(0, 1000) });
      } else {
        if (ev === 'delivered' || ev === 'read') patch.delivered_at = row.delivered_at ?? at;
        if (ev === 'read') patch.read_at = row.read_at ?? at;
        if (RANK[ev]! > cur || row.status === 'failed') patch.status = ev;
        if (patch.status) patch.error = null;
      }
      if (!Object.keys(patch).length) return 0;
      await sql`select set_config('app.tenant_id', ${row.tenant_id}, true)`.execute(tx);
      await tx.updateTable('app.outbound_message').set(patch).where('id', '=', row.id).execute();
      return 1;
    });
  }
}

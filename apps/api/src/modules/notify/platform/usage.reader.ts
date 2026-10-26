import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DbService } from '../../../core/db.service';

/**
 * Platform-role reads the notify module needs without tenant context: monthly usage (preview), queued messages and
 * pending webhook deliveries left behind by a crash between commit and enqueue (sweeper).
 */
@Injectable()
export class NotifyPlatformReader {
  constructor(private readonly db: DbService) {}

  async usage(tenantId: string, limitKey: string, period: string): Promise<{ used: number; limit: number | null }> {
    const r = await sql<{ used: string | null; lim: string | null }>`
      select (select used from platform.usage_meter where tenant_id = ${tenantId}::uuid and limit_key = ${limitKey} and period = ${period})::text as used,
             platform.effective_limit(${limitKey}, ${tenantId}::uuid)::text as lim`.execute(this.db.platform);
    const row = r.rows[0];
    return { used: Number(row?.used ?? 0), limit: row?.lim === null || row?.lim === undefined ? null : Number(row.lim) };
  }

  /** Messages still `queued` after `olderThanSec` (their send job was never enqueued, or was lost). */
  async staleQueued(olderThanSec = 60, limit = 500): Promise<{ id: string; tenant_id: string; channel: 'email' | 'whatsapp' | 'inapp' }[]> {
    return this.db.platform.selectFrom('app.outbound_message').select(['id', 'tenant_id', 'channel'])
      .where('status', '=', 'queued').where('channel', 'in', ['email', 'whatsapp'])
      .where('created_at', '<', sql<Date>`now() - make_interval(secs => ${olderThanSec})`)
      .orderBy('created_at').limit(limit).execute();
  }

  /** Pending webhook deliveries whose next attempt is overdue by more than `graceSec`. */
  async stalePending(graceSec = 120, limit = 500): Promise<{ id: string; tenant_id: string; attempts: number }[]> {
    return this.db.platform.selectFrom('app.webhook_delivery').select(['id', 'tenant_id', 'attempts'])
      .where('status', '=', 'pending')
      .where(sql<boolean>`coalesce(next_attempt_at, created_at) < now() - make_interval(secs => ${graceSec})`)
      .orderBy('created_at').limit(limit).execute();
  }
}

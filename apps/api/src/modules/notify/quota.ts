import { sql } from 'kysely';
import type { Tx } from '../../core/db.service';

export interface QuotaResult { allowed: boolean; used: number; limit: number | null; crossed: '80' | '100' | null }

/** `app.consume_quota` in the caller's tenant transaction (rolled back with it). */
export async function consumeQuota(tx: Tx, key: string, period: string, amount = 1): Promise<QuotaResult> {
  const r = await sql<{ allowed: boolean; used: string; lim: string | null; crossed: string | null }>`
    select allowed, used::text, lim::text, crossed from app.consume_quota(${key}, ${amount}::bigint, ${period})`.execute(tx);
  const row = r.rows[0]!;
  return { allowed: row.allowed, used: Number(row.used), limit: row.lim === null ? null : Number(row.lim), crossed: (row.crossed as '80' | '100' | null) ?? null };
}

const LABELS: Record<string, string> = { email_per_month: 'emails this month', whatsapp_per_month: 'WhatsApp messages this month' };

/** 80% / 100% notifications to every active tenant admin (same shape as the other limit warnings). */
export async function notifyQuotaCrossing(tx: Tx, key: string, q: QuotaResult): Promise<number> {
  if (!q.crossed || q.limit === null) return 0;
  const admins = await tx.selectFrom('app.tenant_user').select('id')
    .where('is_tenant_admin', '=', true).where('is_active', '=', true).where('is_deleted', '=', false).execute();
  if (!admins.length) return 0;
  const label = LABELS[key] ?? key;
  const level = Number(q.crossed);
  const title = level === 100
    ? (q.allowed ? `You have reached your plan limit of ${q.limit} ${label}` : `Messages are being blocked: plan limit of ${q.limit} ${label} reached`)
    : `You have used ${q.used} of ${q.limit} ${label} (${Math.floor((q.used * 100) / Math.max(1, q.limit))}%)`;
  const body = level === 100
    ? 'Further messages are not sent (they show as "Blocked: limit" in the message log) until next month or a plan upgrade.'
    : `You are close to your plan limit of ${q.limit} ${label}. Consider upgrading your plan.`;
  await tx.insertInto('app.notification').values(admins.map(a => ({
    user_id: a.id, kind: 'limit_warning', title, body, link: '/usage',
    data: JSON.stringify({ limitKey: key, threshold: level, limit: q.limit, used: q.used }),
  }))).execute();
  return admins.length;
}

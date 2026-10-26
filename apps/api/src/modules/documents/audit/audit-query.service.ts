import { Injectable } from '@nestjs/common';
import { AuditQuery, AuditRow, ErrorCode, Page } from '@procure/schema';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Tx } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import { AuditVerifier } from './audit-verifier';

/** GET /audit — the tenant's audit log, newest first, keyset on id. */
@Injectable()
export class AuditQueryService {
  constructor(private readonly verifier: AuditVerifier) {}

  async list(tx: Tx, tenantId: string, q: z.infer<typeof AuditQuery>): Promise<Page<AuditRow>> {
    let qb = tx.selectFrom('app.audit_log as a').leftJoin('app.tenant_user as u', join => join.onRef('u.id', '=', 'a.actor_id').onRef('u.tenant_id', '=', 'a.tenant_id'))
      .select(['a.id', 'a.at', 'a.actor_id', 'a.impersonated_by', 'a.action', 'a.entity', 'a.entity_id', 'a.before', 'a.after', sql<string | null>`host(a.ip)`.as('ip'), 'a.user_agent', 'u.name as actor_name'])
      .where('a.tenant_id', '=', tenantId);
    if (q.entity) qb = qb.where('a.entity', '=', q.entity);
    if (q.entityId) qb = qb.where('a.entity_id', '=', q.entityId);
    if (q.actorId) qb = qb.where('a.actor_id', '=', q.actorId);
    if (q.action) qb = qb.where('a.action', '=', q.action);
    if (q.from) qb = qb.where('a.at', '>=', new Date(q.from));
    if (q.to) qb = qb.where('a.at', '<=', new Date(q.to));
    if (q.cursor) {
      if (!/^\d{1,19}$/.test(q.cursor)) throw new AppError(400, ErrorCode.VALIDATION, 'The page cursor is invalid. Start again from the first page.');
      qb = qb.where('a.id', '<', q.cursor);
    }
    const rows = await qb.orderBy('a.id', 'desc').limit(q.limit + 1).execute();
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    const imp = await this.verifier.platformNames(page.map(r => r.impersonated_by).filter((x): x is string => !!x));
    return {
      data: page.map(r => ({
        id: String(r.id), at: new Date(r.at).toISOString(), actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? '' } : null,
        impersonatedBy: r.impersonated_by ? { id: r.impersonated_by, name: imp.get(r.impersonated_by) ?? '' } : null,
        action: r.action, entity: r.entity, entityId: r.entity_id, before: r.before ?? null, after: r.after ?? null, ip: r.ip, userAgent: r.user_agent,
      })),
      nextCursor: more ? String(page[page.length - 1]!.id) : null,
    };
  }
}

import { Injectable } from '@nestjs/common';
import type { SessionRow } from '@procure/schema';
import { randomUUID } from 'node:crypto';
import { TokenService } from '../../../core/auth/token.service';
import { config } from '../../../core/config';
import { DbService, Tx } from '../../../core/db.service';
import { RedisService } from '../../../core/redis.service';
import { ctx } from '../../../core/request-context';
import { toIso } from '../pagination';

export interface NewSession {
  subjectType: 'platform' | 'tenant';
  subjectId: string;
  tenantId: string | null;
  impersonatedBy?: string | null;
  /** Absolute lifetime of the refresh family. */
  expiresAt: Date;
}

export interface IssuedSession {
  id: string;
  familyId: string;
  refreshToken: string;
  expiresAt: Date;
}

export type RotateResult =
  | { ok: true; session: IssuedSession; subjectType: 'platform' | 'tenant'; subjectId: string; tenantId: string | null; impersonatedBy: string | null }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reused' };

type Scope = { familyId: string } | { subjectType: 'platform' | 'tenant'; subjectId: string } | { tenantId: string };

/**
 * Refresh-token sessions (platform.auth_session).
 * One sign-in = one rotation family; each refresh adds a row to the family and retires the previous one.
 * Revocation always works on whole families and also writes every recently-active session id of the
 * family to the Redis revocation list, so access tokens minted from rotated rows stop working immediately.
 */
@Injectable()
export class SessionsService {
  constructor(private readonly db: DbService, private readonly redis: RedisService, private readonly tokens: TokenService) {}

  async create(s: NewSession, tx?: Tx): Promise<IssuedSession> {
    const { token, hash } = this.tokens.newRefreshToken();
    const familyId = randomUUID();
    const c = ctx();
    const row = await (tx ?? this.db.platform)
      .insertInto('platform.auth_session')
      .values({
        subject_type: s.subjectType, subject_id: s.subjectId, tenant_id: s.tenantId, family_id: familyId,
        refresh_hash: hash, impersonated_by: s.impersonatedBy ?? null, ip: c?.ip ?? null, user_agent: c?.userAgent ?? null,
        expires_at: s.expiresAt,
      })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow();
    return { id: row.id, familyId, refreshToken: token, expiresAt: new Date(row.expires_at) };
  }

  /**
   * Rotates a refresh token. The row is locked FOR UPDATE, so two concurrent refreshes with the same
   * token serialise; the second sees it already rotated and is treated as reuse (family revoked).
   */
  async rotate(refreshToken: string): Promise<RotateResult> {
    const hash = TokenService.hash(refreshToken);
    const result = await this.db.platformTx(async tx => {
      const cur = await tx.selectFrom('platform.auth_session').selectAll().where('refresh_hash', '=', hash).forUpdate().executeTakeFirst();
      if (!cur) return { ok: false as const, reason: 'unknown' as const };
      if (cur.revoked_at) {
        if (cur.replaced_by) return { ok: false as const, reason: 'reused' as const, familyId: cur.family_id };
        return { ok: false as const, reason: 'revoked' as const };
      }
      if (new Date(cur.expires_at).getTime() <= Date.now()) return { ok: false as const, reason: 'expired' as const };
      const { token, hash: newHash } = this.tokens.newRefreshToken();
      const c = ctx();
      const next = await tx
        .insertInto('platform.auth_session')
        .values({
          subject_type: cur.subject_type, subject_id: cur.subject_id, tenant_id: cur.tenant_id, family_id: cur.family_id,
          refresh_hash: newHash, impersonated_by: cur.impersonated_by, ip: c?.ip ?? cur.ip, user_agent: c?.userAgent ?? cur.user_agent,
          expires_at: cur.expires_at, created_at: cur.created_at,
        })
        .returning(['id', 'expires_at'])
        .executeTakeFirstOrThrow();
      await tx.updateTable('platform.auth_session')
        .set({ revoked_at: new Date(), revoked_reason: 'rotated', replaced_by: next.id })
        .where('id', '=', cur.id).execute();
      return {
        ok: true as const,
        session: { id: next.id, familyId: cur.family_id, refreshToken: token, expiresAt: new Date(next.expires_at) },
        subjectType: cur.subject_type, subjectId: cur.subject_id, tenantId: cur.tenant_id, impersonatedBy: cur.impersonated_by,
      };
    });
    if (!result.ok && result.reason === 'reused') {
      await this.revoke({ familyId: result.familyId }, 'refresh_reused');
      return { ok: false, reason: 'reused' };
    }
    return result.ok ? result : { ok: false, reason: result.reason };
  }

  /** Revoke the sign-in that `sessionId` belongs to (whole family). */
  async revokeSession(sessionId: string, reason: string): Promise<void> {
    const s = await this.db.platform.selectFrom('platform.auth_session').select('family_id').where('id', '=', sessionId).executeTakeFirst();
    await this.redis.revokeSession(sessionId);
    if (s) await this.revoke({ familyId: s.family_id }, reason);
  }

  /** Revoke every sign-in of a subject, optionally keeping the family of `keepSessionId`. */
  async revokeSubject(subjectType: 'platform' | 'tenant', subjectId: string, reason: string, keepSessionId?: string): Promise<number> {
    let keepFamily: string | undefined;
    if (keepSessionId) {
      keepFamily = (await this.db.platform.selectFrom('platform.auth_session').select('family_id').where('id', '=', keepSessionId).executeTakeFirst())?.family_id;
    }
    return this.revoke({ subjectType, subjectId }, reason, keepFamily);
  }

  /** Revoke every session of a tenant (suspend / archive). */
  revokeTenant(tenantId: string, reason: string): Promise<number> {
    return this.revoke({ tenantId }, reason);
  }

  /** Live sign-ins of a subject (optionally within one tenant), newest first. */
  async list(subjectType: 'platform' | 'tenant', subjectId: string, currentSessionId: string | null, tenantId?: string): Promise<SessionRow[]> {
    let q = this.db.platform.selectFrom('platform.auth_session')
      .select(['id', 'ip', 'user_agent', 'created_at', 'last_used_at', 'impersonated_by'])
      .where('subject_type', '=', subjectType).where('subject_id', '=', subjectId)
      .where('revoked_at', 'is', null).where('expires_at', '>', new Date());
    if (tenantId) q = q.where('tenant_id', '=', tenantId);
    const rows = await q.orderBy('created_at', 'desc').execute();
    return rows.map(r => ({
      id: r.id, ip: r.ip, userAgent: r.user_agent, createdAt: toIso(r.created_at)!, lastUsedAt: toIso(r.last_used_at)!,
      current: r.id === currentSessionId, impersonatedBy: r.impersonated_by,
    }));
  }

  /** Session row if it belongs to the subject (for "revoke my own session"). */
  findOwned(sessionId: string, subjectType: 'platform' | 'tenant', subjectId: string) {
    return this.db.platform.selectFrom('platform.auth_session').select(['id', 'family_id', 'revoked_at'])
      .where('id', '=', sessionId).where('subject_type', '=', subjectType).where('subject_id', '=', subjectId)
      .executeTakeFirst();
  }

  private async revoke(scope: Scope, reason: string, keepFamily?: string): Promise<number> {
    const now = new Date();
    const recent = new Date(now.getTime() - (config.accessTtlSec + 60) * 1000);
    // Ids whose access tokens may still be valid: live rows, and rows retired within one access-token lifetime.
    let sel = this.db.platform.selectFrom('platform.auth_session').select('id')
      .where(eb => eb.or([eb('revoked_at', 'is', null), eb('revoked_at', '>', recent)]));
    let upd = this.db.platform.updateTable('platform.auth_session')
      .set({ revoked_at: now, revoked_reason: reason }).where('revoked_at', 'is', null);
    if ('familyId' in scope) {
      sel = sel.where('family_id', '=', scope.familyId);
      upd = upd.where('family_id', '=', scope.familyId);
    } else if ('tenantId' in scope) {
      sel = sel.where('tenant_id', '=', scope.tenantId);
      upd = upd.where('tenant_id', '=', scope.tenantId);
    } else {
      sel = sel.where('subject_type', '=', scope.subjectType).where('subject_id', '=', scope.subjectId);
      upd = upd.where('subject_type', '=', scope.subjectType).where('subject_id', '=', scope.subjectId);
    }
    if (keepFamily) {
      sel = sel.where('family_id', '<>', keepFamily);
      upd = upd.where('family_id', '<>', keepFamily);
    }
    const ids = await sel.execute();
    const res = await upd.executeTakeFirst();
    await Promise.all(ids.map(r => this.redis.revokeSession(r.id)));
    return Number(res.numUpdatedRows);
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AuditCheckRow } from '@procure/schema';
import { sql } from 'kysely';
import { AuditHashAlg, chainHash } from '../../../core/audit.service';
import { config } from '../../../core/config';
import { DbService, Tx } from '../../../core/db.service';
import { QueueService } from '../../../core/queue.service';

export const AUDIT_QUEUE = 'audit';
const BATCH = 2000;

export interface ChainResult { rowsChecked: number; ok: boolean; firstBadId: string | null; detail: string | null }

type AuditDbRow = Record<string, unknown> & { id: string; prev_hash: string | null; hash: string; hash_alg: AuditHashAlg };

/**
 * Hash-chain verification of the tenant audit logs and the platform audit log (contract "Audit"). A core-level job:
 * reads every tenant's chain with the platform role (explicit tenant filter), recomputes each row's hash with
 * core's `chainHash` and checks the links, and stores a platform.audit_check row per chain. Nightly at 02:30 UTC
 * (queue `audit`, job `audit-verify`); a failure notifies the tenant's admins and logs an error.
 */
@Injectable()
export class AuditVerifier implements OnModuleInit {
  private readonly log = new Logger('AuditVerify');
  constructor(private readonly db: DbService, private readonly queue: QueueService) {}

  onModuleInit() {
    this.queue.registerProcessor(AUDIT_QUEUE, async job => (job.name === 'audit-verify' ? this.verifyAll() : undefined), 1);
    this.queue.registerRepeat(AUDIT_QUEUE, 'audit-verify', { pattern: '30 2 * * *' });
  }

  /** Walks one chain in id order. `tenantId` null = the platform log. */
  async verifyChain(tx: Tx, tenantId: string | null): Promise<ChainResult> {
    let prev: string | null = null;
    let after = '0';
    let n = 0;
    // SEC8-015: once a chain has a keyed row, a plain-hash row after it is a forgery (downgrade), not legacy data.
    let keyed = false;
    const keys = [config.audit.hashKey, ...config.audit.previousHashKeys];
    for (;;) {
      const rows = tenantId
        ? (await sql<AuditDbRow>`select id, actor_id, impersonated_by, action, entity, entity_id, before, after, host(ip) as ip_host, ip::text as ip, user_agent, at, prev_hash, hash, hash_alg
              from app.audit_log where tenant_id = ${tenantId} and id > ${after}::bigint order by id limit ${BATCH}`.execute(tx)).rows
        : (await sql<AuditDbRow>`select id, actor_id, action, entity, entity_id, tenant_id, before, after, host(ip) as ip_host, ip::text as ip, user_agent, at, prev_hash, hash, hash_alg
              from platform.audit_log where id > ${after}::bigint order by id limit ${BATCH}`.execute(tx)).rows;
      for (const r of rows) {
        n++;
        if ((r.prev_hash ?? null) !== prev) return { rowsChecked: n, ok: false, firstBadId: r.id, detail: `Row ${r.id} does not link to the previous row (missing or reordered rows).` };
        const { id: _id, prev_hash: _p, hash, hash_alg: alg, ip_host, ...rest } = r;
        if (alg !== 'sha256' && alg !== 'hmac-sha256') return { rowsChecked: n, ok: false, firstBadId: r.id, detail: `Row ${r.id} names an unknown hash algorithm.` };
        if (alg === 'sha256' && keyed) return { rowsChecked: n, ok: false, firstBadId: r.id, detail: `Row ${r.id} has an unkeyed hash after keyed rows (inserted or rewritten outside the application).` };
        keyed ||= alg === 'hmac-sha256';
        const candidates = [rest, { ...rest, ip: ip_host }];
        const matches = alg === 'sha256'
          ? candidates.some(c => chainHash(prev, c, true, 'sha256') === hash)
          : keys.some(k => candidates.some(c => chainHash(prev, c, true, 'hmac-sha256', k) === hash));
        if (!matches) return { rowsChecked: n, ok: false, firstBadId: r.id, detail: `Row ${r.id} was changed after it was written (hash mismatch).` };
        prev = hash;
      }
      if (rows.length < BATCH) break;
      after = rows[rows.length - 1]!.id;
    }
    return { rowsChecked: n, ok: true, firstBadId: null, detail: null };
  }

  private async store(tx: Tx, tenantId: string | null, r: ChainResult): Promise<AuditCheckRow> {
    const row = await tx.insertInto('platform.audit_check').values({ tenant_id: tenantId, rows_checked: r.rowsChecked, ok: r.ok, first_bad_id: r.firstBadId, detail: r.detail })
      .returning(['checked_at', 'rows_checked', 'ok', 'first_bad_id', 'detail']).executeTakeFirstOrThrow();
    return toCheckRow(row);
  }

  async verifyTenant(tenantId: string): Promise<AuditCheckRow> {
    const out = await this.db.platformTx(async tx => this.store(tx, tenantId, await this.verifyChain(tx, tenantId)), tenantId);
    if (!out.ok) {
      this.log.error(`audit chain of tenant ${tenantId} failed verification: ${out.detail}`);
      await this.db.platformTx(async tx => {
        const admins = await tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', tenantId)
          .where('is_tenant_admin', '=', true).where('is_active', '=', true).where('is_deleted', '=', false).execute();
        if (admins.length) {
          await tx.insertInto('app.notification').values(admins.map(a => ({
            tenant_id: tenantId, user_id: a.id, kind: 'audit_check_failed', title: 'The audit log failed its tamper check',
            body: out.detail, link: '/admin/audit', data: JSON.stringify({ firstBadId: out.firstBadId }),
          })) as never).execute();
        }
      }, tenantId);
    }
    return out;
  }

  async verifyPlatform(): Promise<AuditCheckRow> {
    const out = await this.db.platformTx(async tx => this.store(tx, null, await this.verifyChain(tx, null)));
    if (!out.ok) this.log.error(`platform audit chain failed verification: ${out.detail}`);
    return out;
  }

  /** Every tenant + the platform log (the nightly job). */
  async verifyAll(): Promise<{ tenants: number; failed: number }> {
    const tenants = await this.db.platform.selectFrom('platform.tenant').select('id').orderBy('id').execute();
    let failed = 0;
    for (const t of tenants) if (!(await this.verifyTenant(t.id)).ok) failed++;
    if (!(await this.verifyPlatform()).ok) failed++;
    return { tenants: tenants.length, failed };
  }

  async recentChecks(tenantId: string, limit = 30): Promise<AuditCheckRow[]> {
    const rows = await this.db.platform.selectFrom('platform.audit_check').select(['checked_at', 'rows_checked', 'ok', 'first_bad_id', 'detail'])
      .where('tenant_id', '=', tenantId).orderBy('checked_at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return rows.map(toCheckRow);
  }

  /** Display names of platform users (impersonators in the tenant audit log). */
  async platformNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    const rows = await this.db.platform.selectFrom('platform.platform_user').select(['id', 'name']).where('id', 'in', uniq).execute();
    return new Map(rows.map(r => [r.id, r.name]));
  }
}

function toCheckRow(r: { checked_at: Date; rows_checked: string; ok: boolean; first_bad_id: string | null; detail: string | null }): AuditCheckRow {
  return { checkedAt: new Date(r.checked_at).toISOString(), rowsChecked: Number(r.rows_checked), ok: r.ok, firstBadId: r.first_bad_id === null ? null : String(r.first_bad_id), detail: r.detail };
}

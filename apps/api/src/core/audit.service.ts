import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { sql } from 'kysely';
import { config } from './config';
import type { Tx } from './db.service';
import { ctx } from './request-context';

export interface AuditEntry {
  action: string;          // create | update | delete | deactivate | login | login_failed | impersonate_start | ...
  entity: string;          // user | role | tenant | plan | override | ...
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Platform audit only: tenant affected by a Super Admin action. */
  tenantId?: string | null;
  actorId?: string | null;
}

const SECRET_KEYS = /password|hash|token|secret|otp/i;
function redact(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== 'object') return v ?? null;
  if (Array.isArray(v)) return v.map(redact);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : redact(x)]));
}

/**
 * Append-only, hash-chained audit. Must be called inside the same transaction as the change,
 * so an audit row exists iff the change committed. The chain is serialised per tenant with
 * an advisory lock; a nightly job verifies it (Phase 3).
 */
@Injectable()
export class AuditService {
  /** Tenant audit: tx must be a tenantTx (or platformTx with tenant context set). */
  async tenant(tx: Tx, e: AuditEntry): Promise<void> {
    const c = ctx();
    const p = c?.principal;
    await sql`select pg_advisory_xact_lock(hashtextextended('audit:' || app.current_tenant_id()::text, 0))`.execute(tx);
    // Filter explicitly: under the platform role (BYPASSRLS) RLS would not scope this lookup.
    const prev = await tx.selectFrom('app.audit_log').select('hash').where('tenant_id', '=', sql<string>`app.current_tenant_id()`).orderBy('id', 'desc').limit(1).executeTakeFirst();
    const row = {
      actor_id: e.actorId ?? (p?.kind === 'tenant' ? p.userId : null),
      impersonated_by: p?.kind === 'tenant' ? p.impersonatedBy?.userId ?? null : p?.kind === 'platform' ? p.userId : null,
      action: e.action, entity: e.entity, entity_id: e.entityId ?? null,
      before: e.before === undefined ? null : JSON.stringify(redact(e.before)),
      after: e.after === undefined ? null : JSON.stringify(redact(e.after)),
      ip: c?.ip ?? null, user_agent: c?.userAgent ?? null,
      at: new Date().toISOString(),
    };
    const hash = chainHash(prev?.hash ?? null, row);
    await tx.insertInto('app.audit_log').values({ ...row, prev_hash: prev?.hash ?? null, hash, hash_alg: AUDIT_HASH_ALG }).execute();
  }

  /** Platform audit: Super Admin actions. tx must be a platformTx. */
  async platform(tx: Tx, e: AuditEntry): Promise<void> {
    const c = ctx();
    await sql`select pg_advisory_xact_lock(hashtextextended('audit:platform', 0))`.execute(tx);
    const prev = await tx.selectFrom('platform.audit_log').select('hash').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const row = {
      actor_id: e.actorId ?? (c?.principal?.kind === 'platform' ? c.principal.userId : null),
      action: e.action, entity: e.entity, entity_id: e.entityId ?? null, tenant_id: e.tenantId ?? null,
      before: e.before === undefined ? null : JSON.stringify(redact(e.before)),
      after: e.after === undefined ? null : JSON.stringify(redact(e.after)),
      ip: c?.ip ?? null, user_agent: c?.userAgent ?? null,
      at: new Date().toISOString(),
    };
    const hash = chainHash(prev?.hash ?? null, row);
    await tx.insertInto('platform.audit_log').values({ ...row, prev_hash: prev?.hash ?? null, hash, hash_alg: AUDIT_HASH_ALG }).execute();
  }
}

/** Algorithm marker stored per row (`hash_alg`, migration 0022). */
export type AuditHashAlg = 'sha256' | 'hmac-sha256';
/** What new rows are written with (SEC8-015). */
export const AUDIT_HASH_ALG: AuditHashAlg = 'hmac-sha256';

/**
 * Hash of one audit row chained to the previous row's hash. The row is canonicalised first (Phase 3, audit
 * verification): `before`/`after` are hashed as key-sorted JSON whether given as the JSON text written on insert or
 * as the object read back from jsonb (which does not keep key order), and `at` as an ISO string. So the nightly
 * verifier can recompute every hash from the stored row and detect edited content, not only broken links.
 *
 * SEC8-015: `hmac-sha256` (the default, all new rows) keys the hash with AUDIT_HASH_KEY, which lives outside the
 * database, so a database writer cannot forge a valid chain. `sha256` is the plain hash of rows written before 0022;
 * it is kept for verifying them only. The message is prefixed with the algorithm so the two can never collide.
 */
export function chainHash(prev: string | null, row: Record<string, unknown>, jsonParsed = false, alg: AuditHashAlg = AUDIT_HASH_ALG, key: string = config.audit.hashKey): string {
  const body = `${prev ?? ''}|${canonicalJson(canonicalAuditRow(row, jsonParsed))}`;
  if (alg === 'sha256') return createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', key).update(`hmac-sha256|${body}`).digest('hex');
}

/**
 * The hashed view of an audit row (fixed key order, JSON columns parsed, timestamps as ISO strings). Writers pass
 * `before`/`after` as JSON text; the verifier passes the values read back from jsonb (`jsonParsed`).
 */
export function canonicalAuditRow(row: Record<string, unknown>, jsonParsed = false): Record<string, unknown> {
  const json = (v: unknown) => {
    if (v === null || v === undefined) return null;
    if (!jsonParsed && typeof v === 'string') {
      try {
        return JSON.parse(v) as unknown;
      } catch {
        return v;
      }
    }
    return v;
  };
  const at = row.at instanceof Date ? row.at.toISOString() : row.at === undefined || row.at === null ? null : new Date(String(row.at)).toISOString();
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) {
    if (k === 'id' || k === 'hash' || k === 'prev_hash' || k === 'hash_alg') continue;
    const v = row[k];
    out[k] = k === 'before' || k === 'after' ? json(v) : k === 'at' ? at : v === undefined ? null : v;
  }
  return out;
}

/** JSON with object keys sorted at every level (stable across jsonb round trips). */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, Transaction } from 'kysely';
import { Pool, types } from 'pg';
import { config } from './config';
import type { DB } from './db-types';

// Return bigint/numeric as strings (never lose precision); callers convert deliberately.
types.setTypeParser(20, v => v);   // int8
types.setTypeParser(1700, v => v); // numeric

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Two connection pools, two DB roles (ADR-0002):
 *  - tenant pool  : role app_user, NOBYPASSRLS. Every query runs inside tenantTx(), which sets
 *                   app.tenant_id for the transaction. No tenant context => zero rows.
 *  - platform pool: role platform_user, BYPASSRLS. Only Super Admin endpoints and the auth
 *                   service (login/refresh, before tenant context exists) may use it.
 *
 * Rule for every module: tenant-facing code receives a `Tx` from tenantTx and never touches
 * the platform pool. Lint (eslint no-restricted-imports) keeps `platformTx` inside
 * modules/platform, modules/identity/auth and core.
 */
@Injectable()
export class DbService implements OnApplicationShutdown {
  private readonly log = new Logger('Db');
  private readonly tenantDb: Db;
  private readonly platformDb: Db;
  /** Kept reachable so error listeners stay attached and pools can be inspected (QA-BUG-001). */
  readonly tenantPool: Pool;
  readonly platformPool: Pool;

  constructor() {
    this.tenantPool = this.watch(new Pool({ connectionString: config.databaseUrl, max: config.dbPoolSize }), 'tenant');
    this.platformPool = this.watch(
      new Pool({ connectionString: config.databasePlatformUrl, max: Math.max(4, Math.floor(config.dbPoolSize / 4)) }),
      'platform',
    );
    this.tenantDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: this.tenantPool }) });
    this.platformDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: this.platformPool }) });
  }

  /**
   * An idle pooled client that the server drops (failover, restart, idle kill) makes pg emit 'error' on the Pool.
   * Without a listener Node throws and the process exits. pg already discards the broken client; we just log it.
   */
  private watch(pool: Pool, name: string): Pool {
    pool.on('error', err => this.log.warn(`${name} pool: idle connection lost (${err.message}); it will be replaced on next use`));
    return pool;
  }

  /** Run fn in a transaction scoped to one tenant. RLS enforces isolation in the database. */
  async tenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) throw new Error('tenantTx requires a tenant uuid');
    return this.tenantDb.transaction().execute(async tx => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
      return fn(tx);
    });
  }

  /** Cross-tenant transaction (platform role). Optionally also sets tenant context for tenant-table writes. */
  async platformTx<T>(fn: (tx: Tx) => Promise<T>, tenantId?: string): Promise<T> {
    return this.platformDb.transaction().execute(async tx => {
      if (tenantId) {
        if (!UUID_RE.test(tenantId)) throw new Error('platformTx tenant must be a uuid');
        await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(tx);
      }
      return fn(tx);
    });
  }

  /** Non-transactional platform reads (catalogs, health). */
  get platform(): Db {
    return this.platformDb;
  }

  /** After queue workers have stopped (QueueService.beforeApplicationShutdown). */
  async onApplicationShutdown() {
    await Promise.all([this.tenantDb.destroy(), this.platformDb.destroy()]);
  }
}

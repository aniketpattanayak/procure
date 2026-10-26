import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from './config';

/** Shared Redis client: config/permission caches, revocation list, rate limits. Queues use BullMQ (Phase 3+). */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly log = new Logger('Redis');
  readonly client = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  private lastErrorLog = 0;

  constructor() {
    // ioredis emits 'error' on every failed (re)connect; with no listener Node would crash the process.
    // It reconnects by itself; log at most every 10 s to avoid flooding during an outage.
    this.client.on('error', err => {
      const now = Date.now();
      if (now - this.lastErrorLog > 10_000) {
        this.lastErrorLog = now;
        this.log.warn(`Redis error: ${err.message} (client will reconnect)`);
      }
    });
  }

  async getJson<T>(key: string): Promise<T | null> {
    const v = await this.client.get(key);
    return v ? (JSON.parse(v) as T) : null;
  }
  async setJson(key: string, value: unknown, ttlSec: number) {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSec);
  }
  async del(...keys: string[]) {
    if (keys.length) await this.client.del(...keys);
  }

  /** Revoked session ids are kept for one access-token lifetime so force-logout is immediate. */
  async revokeSession(sessionId: string) {
    await this.client.set(`revoked:sid:${sessionId}`, '1', 'EX', config.accessTtlSec + 60);
  }
  async isRevoked(sessionId: string) {
    return (await this.client.exists(`revoked:sid:${sessionId}`)) === 1;
  }

  /** Fixed-window counter used by rate limiting. Returns count after increment. */
  async hit(key: string, windowSec: number): Promise<number> {
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, windowSec);
    return n;
  }

  /** After queue workers have stopped (QueueService.beforeApplicationShutdown). */
  async onApplicationShutdown() {
    this.client.disconnect();
  }
}

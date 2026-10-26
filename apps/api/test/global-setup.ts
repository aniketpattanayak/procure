// Creates a fresh test database (TEST_DB, default procure_test) with all migrations before the suite runs.
export default async function setup() {
  process.env.DATABASE_MIGRATOR_URL = `postgres://postgres@localhost:5432/${process.env.TEST_DB ?? 'procure_test'}`;
  // @ts-expect-error plain .mjs module without types
  const { migrate } = await import('../../../db/migrate.mjs');
  await migrate({ reset: true, log: () => {} });
  const { default: Redis } = await import('ioredis');
  const r = new Redis(`redis://localhost:${process.env.TEST_REDIS_PORT ?? '6379'}/${process.env.TEST_REDIS_DB ?? '1'}`);
  await r.flushdb();
  r.disconnect();
}

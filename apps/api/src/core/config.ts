import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().url(),
  DATABASE_PLATFORM_URL: z.string().url(),
  DB_POOL_SIZE: z.coerce.number().int().min(2).default(20),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32),
  /** Previous secret accepted for verification only, so rotation causes no 401 burst (runbook). */
  JWT_SECRET_PREVIOUS: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().default(900),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  /** Rate limiting is off by default under NODE_ENV=test; set RATE_LIMIT=on to exercise it in tests. */
  RATE_LIMIT: z.enum(['on', 'off']).optional(),
  // ---- Phase 2: files (ADR-0008)
  /** `local` (dev/test, bytes under STORAGE_DIR) or `s3`. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  /** Local driver root. Default: <repo>/.data/files. */
  STORAGE_DIR: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  /** `noop` marks uploads clean immediately (dev/test); `clamav` streams them to clamd (INSTREAM). */
  SCANNER_DRIVER: z.enum(['noop', 'clamav']).default('noop'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
  /** HMAC key for signed file URLs. Required in production; dev/test derive one from JWT_SECRET. */
  FILE_URL_SECRET: z.string().min(32).optional(),
  /** Prefix for signed file URLs, e.g. https://api.example.com (default: relative `/api/v1/...`). */
  FILE_URL_BASE: z.string().default(''),
  // ---- Phase 8 (SEC8-015): keyed audit hash chain
  /** HMAC-SHA256 key for the audit hash chain (min 32 chars). Required in production; dev/test derive one from JWT_SECRET. */
  AUDIT_HASH_KEY: z.string().min(32).optional(),
  /** Earlier audit keys (comma-separated), accepted by the verifier only, for rows written before a key rotation. */
  AUDIT_HASH_KEY_PREVIOUS: z.string().optional(),
  // ---- Phase 3: background jobs (ADR-0012)
  /** `inline` runs queue processors inside the API process (default in development/test); `off` leaves them to dist/worker.js. */
  RUN_WORKERS: z.enum(['inline', 'off']).optional(),
});

const env = Env.parse(process.env);
if (env.NODE_ENV === 'production' && !env.FILE_URL_SECRET) throw new Error('FILE_URL_SECRET is required in production');
if (env.NODE_ENV === 'production' && !env.AUDIT_HASH_KEY) throw new Error('AUDIT_HASH_KEY is required in production');
if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  port: env.API_PORT,
  databaseUrl: env.DATABASE_URL,
  databasePlatformUrl: env.DATABASE_PLATFORM_URL,
  dbPoolSize: env.DB_POOL_SIZE,
  redisUrl: env.REDIS_URL,
  jwtSecret: new TextEncoder().encode(env.JWT_SECRET),
  jwtSecretPrevious: env.JWT_SECRET_PREVIOUS ? new TextEncoder().encode(env.JWT_SECRET_PREVIOUS) : null,
  accessTtlSec: env.ACCESS_TOKEN_TTL_SEC,
  webOrigin: env.WEB_ORIGIN.split(','),
  cookieSecure: env.COOKIE_SECURE === 'true' || env.NODE_ENV === 'production',
  rateLimit: {
    enabled: (env.RATE_LIMIT ?? (env.NODE_ENV === 'test' ? 'off' : 'on')) === 'on',
    /** Per IP per minute on credential endpoints (login, platform login, password change). */
    credentialPerIp: 30,
    /** Per account (tenant code + email, or platform email) per minute on login endpoints. */
    loginPerAccount: 10,
    /** Per IP per minute on everything else, including /auth/me and /auth/refresh. */
    apiPerIp: 1200,
  },
  audit: {
    /** Current HMAC key: new audit rows are hashed with it. */
    hashKey: env.AUDIT_HASH_KEY ?? createHash('sha256').update(`audit-hash:${env.JWT_SECRET}`).digest('hex'),
    /** Keys the verifier also accepts (rotation). */
    previousHashKeys: (env.AUDIT_HASH_KEY_PREVIOUS ?? '').split(',').map(k => k.trim()).filter(k => k.length >= 32),
  },
  runWorkersInline: (env.RUN_WORKERS ?? (env.NODE_ENV === 'production' ? 'off' : 'inline')) === 'inline',
  files: {
    driver: env.STORAGE_DRIVER,
    // src/core and dist/core are both four levels below the repo root.
    dir: env.STORAGE_DIR ?? resolve(__dirname, '../../../../.data/files'),
    s3: { bucket: env.S3_BUCKET ?? '', region: env.S3_REGION ?? 'ap-south-1', endpoint: env.S3_ENDPOINT },
    scanner: env.SCANNER_DRIVER,
    clamav: { host: env.CLAMAV_HOST, port: env.CLAMAV_PORT },
    urlSecret: env.FILE_URL_SECRET ?? createHash('sha256').update(`file-url:${env.JWT_SECRET}`).digest('hex'),
    urlBase: env.FILE_URL_BASE.replace(/\/+$/, ''),
    /** Signed URLs live 5 minutes (ADR-0008). */
    urlTtlSec: 300,
    maxUploadBytes: 25 * 1024 * 1024,
  },
} as const;

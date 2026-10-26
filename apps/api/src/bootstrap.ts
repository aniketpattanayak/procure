import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { ErrorCode } from '@procure/schema';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { config } from './core/config';
import { RedisService } from './core/redis.service';
import { requestStore } from './core/request-context';

/** Endpoints that accept a password; limited per IP at config.rateLimit.credentialPerIp. */
const CREDENTIAL_PATHS = new Set(['/api/v1/auth/login', '/api/v1/auth/platform/login', '/api/v1/auth/password/change']);

/** SEC8-008: a client-supplied X-Request-Id is kept only when short and plain (it reaches logs and the audit trail). */
const requestIdOf = (h: unknown): string => (typeof h === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(h) ? h : randomUUID());

/** Builds the app (used by main.ts and by integration tests). */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: config.env === 'test' ? ['error'] : ['log', 'warn', 'error'] });
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', 1);
  expressApp.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  // Templates may be up to 200 KB (Phase 6); allow 1 MB JSON bodies. Larger bodies get 413 from body-parser.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });
  app.enableCors({ origin: config.webOrigin, credentials: true });

  // Request context for audit/logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    requestStore.run(
      { requestId: requestIdOf(req.headers['x-request-id']), ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null },
      next,
    );
  });

  // Per-IP rate limits. Credential endpoints get a tight budget (brute-force protection); everything else,
  // including session upkeep (/auth/me, /auth/refresh, /auth/sessions), uses the general API budget so normal
  // browsing never signs users out (QA-BUG-006). Per-account login limits live in AuthService (needs the body).
  const redis = app.get(RedisService);
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!config.rateLimit.enabled) return next();
    const credential = req.method === 'POST' && CREDENTIAL_PATHS.has(req.path.replace(/\/+$/, ''));
    const bucket = credential ? 'cred' : 'api';
    const max = credential ? config.rateLimit.credentialPerIp : config.rateLimit.apiPerIp;
    const n = await redis.hit(`rl:ip:${bucket}:${req.ip}`, 60).catch(() => 0); // fail open if Redis is down
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - n));
    if (n > max) {
      res.setHeader('Retry-After', 60);
      res.status(429).type('application/problem+json').json({
        type: 'about:blank', title: 'Too many requests. Wait a minute and try again.', status: 429, code: ErrorCode.RATE_LIMITED,
      });
      return;
    }
    next();
  });

  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.enableShutdownHooks();
  return app;
}

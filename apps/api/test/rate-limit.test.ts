/**
 * QA-BUG-006: rate limits apply to credential endpoints only (30/min per IP) plus 10/min per account on login;
 * session upkeep (/auth/me, /auth/refresh) uses the general API budget.
 * Rate limiting is off under NODE_ENV=test by default; this file turns it on before the app (and config) load.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.RATE_LIMIT = 'on';

describe('rate limits (QA-BUG-006)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let flush: () => Promise<unknown>;

  beforeAll(async () => {
    const { createApp } = await import('../src/bootstrap');
    const { RedisService } = await import('../src/core/redis.service');
    app = await createApp();
    await app.init();
    http = request(app.getHttpServer());
    const redis = app.get(RedisService);
    flush = async () => {
      const keys = await redis.client.keys('rl:*');
      if (keys.length) await redis.client.del(...keys);
    };
  });
  afterAll(async () => {
    await flush();
    await app.close();
    delete process.env.RATE_LIMIT;
  });

  it('session endpoints are not counted against the credential budget', async () => {
    await flush();
    for (let i = 0; i < 40; i++) {
      expect((await http.post('/api/v1/auth/refresh')).status).toBe(401); // no cookie, but not 429
      expect((await http.get('/api/v1/auth/me')).status).toBe(401);
    }
  });

  it('per account: the 11th login attempt within a minute is refused with RATE_LIMITED', async () => {
    await flush();
    const body = { tenantCode: 'no-such-co', email: 'victim@example.test', password: 'Wrong-pass-1' };
    for (let i = 0; i < 10; i++) expect((await http.post('/api/v1/auth/login').send(body)).body.code).toBe('AUTH.INVALID_CREDENTIALS');
    const r = await http.post('/api/v1/auth/login').send(body);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
    // Same IP, different account still works (IP budget is 30).
    expect((await http.post('/api/v1/auth/login').send({ ...body, email: 'other@example.test' })).status).toBe(401);
    // Platform accounts are keyed separately.
    expect((await http.post('/api/v1/auth/platform/login').send({ email: 'victim@example.test', password: 'x' })).status).toBe(401);
  });

  it('per IP: the 31st credential request within a minute is refused', async () => {
    await flush();
    for (let i = 0; i < 30; i++) {
      const r = await http.post('/api/v1/auth/login').send({ tenantCode: 'no-such-co', email: `u${i}@example.test`, password: 'Wrong-pass-1' });
      expect(r.status).toBe(401);
    }
    const r = await http.post('/api/v1/auth/platform/login').send({ email: 'x@example.test', password: 'x' });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
    expect((await http.get('/api/v1/auth/me')).status).toBe(401); // general budget unaffected
  });
});

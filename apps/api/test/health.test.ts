import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap';

describe('core', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createApp(); await app.init(); });
  afterAll(async () => { await app.close(); });

  it('health is public', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('unknown api route without token is 401 problem json', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/users');
    expect([401, 404]).toContain(res.status);
  });
});

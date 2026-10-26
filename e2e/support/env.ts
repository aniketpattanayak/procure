import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const API_ORIGIN = process.env.E2E_API_ORIGIN ?? 'http://localhost:4000';
export const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3000';
/** Written by the api webServer command after `db:reset` + seed, read by global setup. */
export const RESET_MARKER = join(tmpdir(), 'procure-e2e-reset-marker');

/** Seed logins (apps/api/src/seed/demo.ts, documented in apps/web/README.md). */
export const SEED = {
  owner: { email: 'owner@procure.local', password: 'Owner@12345' },
  acme: { code: 'acme', email: 'admin@acme.test', password: 'Admin@12345', name: 'Acme Industries' },
  globex: { code: 'globex', email: 'admin@globex.test', password: 'Admin@12345', name: 'Globex Corporation' },
};

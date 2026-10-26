#!/usr/bin/env node
/**
 * Starts the web app the way it ships: the Next.js standalone server (`output: 'standalone'`), not `next start`
 * (which warns "does not work with output: standalone"). Used by the Playwright `web` webServer.
 *
 * The standalone bundle does not include `.next/static` or `public/`; Next documents copying them next to
 * server.js. This script does that copy (fresh each start, so a rebuild never serves stale chunks) and then runs
 * `apps/web/.next/standalone/apps/web/server.js` on PORT (default 3000).
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = resolve(root, 'apps/web');
const standaloneApp = resolve(web, '.next/standalone/apps/web');
const server = resolve(standaloneApp, 'server.js');

if (!existsSync(server)) {
  console.error(`[e2e] ${server} not found. Build the web app first: pnpm --filter @procure/web build (or E2E_BUILD=1).`);
  process.exit(1);
}

const staticSrc = resolve(web, '.next/static');
const staticDst = resolve(standaloneApp, '.next/static');
rmSync(staticDst, { recursive: true, force: true });
cpSync(staticSrc, staticDst, { recursive: true });
const publicSrc = resolve(web, 'public');
if (existsSync(publicSrc)) {
  const publicDst = resolve(standaloneApp, 'public');
  rmSync(publicDst, { recursive: true, force: true });
  cpSync(publicSrc, publicDst, { recursive: true });
}

process.env.PORT ??= '3000';
process.env.HOSTNAME ??= 'localhost';
process.env.NODE_ENV = 'production';
process.chdir(standaloneApp);
await import(server);

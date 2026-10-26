/**
 * Playwright E2E for Procure Phase 1.  Run: `pnpm e2e` (root).
 *
 * Stack: the config starts the API (:4000) and web (:3000) from built output (`apps/api/dist`, and the Next standalone
 * server `apps/web/.next/standalone/apps/web/server.js` via e2e/support/start-web.mjs, which copies `.next/static` and
 * `public` next to it), or reuses servers already listening there (reuseExistingServer) — CI starts both first.
 *
 * Deterministic data: when Playwright starts the API, its command runs `pnpm db:reset` + seed first (before any
 * connection exists). When servers are reused, global-setup.ts does a soft reset (truncate + seed) instead, because
 * dropping the DB under a running API crashes it (QA-BUG-001).
 *
 *   E2E_BUILD=1     build api + web before starting them (off by default; CI builds in an earlier step)
 *   E2E_NO_RESET=1  never reset/seed (e.g. against a shared environment)
 *   PW_CHROMIUM_PATH  Chromium binary to use (default: the preinstalled /opt/pw-browsers build when present)
 */
import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { API_ORIGIN, RESET_MARKER, WEB_ORIGIN } from './support/env';

const root = resolve(__dirname, '..');

// No browser downloads: use the preinstalled Chromium. @playwright/test 1.64 expects chromium-1248, the machine has
// chromium-1194 (Chromium 141); Playwright drives it fine through executablePath.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const preinstalled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath = process.env.PW_CHROMIUM_PATH ?? (existsSync(preinstalled) ? preinstalled : undefined);
const launchOptions = executablePath ? { executablePath } : {};

const build = process.env.E2E_BUILD === '1';
const reset = process.env.E2E_NO_RESET === '1'
  ? ''
  : `(cd ../.. && pnpm db:reset && pnpm db:seed) && node -e "require('fs').writeFileSync('${RESET_MARKER}', String(Date.now()))" && `;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: resolve(root, 'test-results/e2e'),
  globalSetup: './global-setup.ts',
  // Journeys share one seeded database and some mutate shared tenants; keep them serial and deterministic.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(root, 'playwright-report'), open: 'never' }],
    ['json', { outputFile: resolve(root, 'test-results/e2e-results.json') }],
  ],
  use: {
    baseURL: WEB_ORIGIN,
    headless: true,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], launchOptions }, testIgnore: /mobile[\w-]*\.spec\.ts$/ },
    { name: 'mobile-pixel7', use: { ...devices['Pixel 7'], launchOptions }, testMatch: /mobile[\w-]*\.spec\.ts$/ },
  ],
  webServer: [
    {
      name: 'api',
      command: `${build ? 'pnpm --filter @procure/schema build && pnpm --filter @procure/api build && ' : ''}${reset}node --env-file=../../.env dist/main.js`,
      cwd: resolve(root, 'apps/api'),
      url: `${API_ORIGIN}/health`,
      reuseExistingServer: true,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      name: 'web',
      // Standalone server (what Docker ships), with .next/static + public copied next to server.js.
      command: `${build ? 'pnpm --filter @procure/web build && ' : ''}node e2e/support/start-web.mjs`,
      cwd: root,
      url: WEB_ORIGIN,
      reuseExistingServer: true,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});

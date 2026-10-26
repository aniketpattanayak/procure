/**
 * QA-BUG-006: the coarse per-IP limiter (bootstrap.ts) counts every path containing "/auth/" against 30 req/min,
 * including /auth/me and /auth/refresh, which the web calls on every full page load. A signed-in user who opens
 * ~15 pages in a minute (or a whole office behind one NAT) gets 429 on refresh and is bounced to the login page.
 * Expected: brute-force limits on login endpoints only, keyed by account + IP; session endpoints on the normal budget.
 */
import { expect, test as base } from '@playwright/test';
import { resetRateLimits, Ui } from './support/fixtures';

const test = base; // deliberately without the auto rate-limit reset fixture

test('[QA-BUG-006] a signed-in Super Admin can reload 20 pages in a minute without being signed out', async ({ page }) => {
  await resetRateLimits();
  const ui = new Ui(page);
  const throttled: string[] = [];
  page.on('response', r => { if (r.status() === 429) throttled.push(new URL(r.url()).pathname); });
  await ui.platformLogin();
  for (let i = 0; i < 20; i++) {
    const target = i % 2 ? '/platform/plans' : '/platform/tenants';
    await page.goto(target);
    await page.waitForURL(u => u.pathname === target || u.pathname.endsWith('/login'), { timeout: 10_000 });
    await page.waitForLoadState('networkidle');
    expect(throttled, `reload #${i + 1}: auth calls throttled`).toEqual([]);
    await expect(page, `reload #${i + 1}`).toHaveURL(new RegExp(`${target}$`));
  }
});

test.afterAll(async () => { await resetRateLimits(); });

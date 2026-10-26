import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type Page } from '@playwright/test';
import { fetchTransport, TestKit } from '@procure/test-kit';
import { API_ORIGIN, SEED } from './env';
import { delPattern } from './redis';

export { expect };

/** API-side fixture builder (same kit the vitest suites use), pointed at the running API. */
export const kit = new TestKit(fetchTransport(API_ORIGIN));

let ownerToken: string | null = null;
export async function ownerApiToken() {
  ownerToken ??= (await kit.platformLogin(SEED.owner.email, SEED.owner.password)).token;
  return ownerToken;
}

/**
 * The API's coarse per-IP limiter allows 30 /auth/* calls a minute, and that budget includes /auth/me and
 * /auth/refresh (2 per page load). All E2E traffic comes from one IP, standing in for many users, so each test starts
 * with a fresh window. The limiter behaviour itself is filed as QA-BUG-006 and reproduced in rate-limit.spec.ts,
 * which opts out of this reset.
 */
export async function resetRateLimits() {
  try {
    await delPattern('rl:*');
  } catch (e) {
    console.warn(`[e2e] could not reset rate limits: ${(e as Error).message}`);
  }
}

export const test = base.extend<{ ui: Ui; freshRateLimit: void }>({
  freshRateLimit: [async ({}, use) => { await resetRateLimits(); await use(); }, { auto: true }], // eslint-disable-line no-empty-pattern
  ui: async ({ page }, use) => { await use(new Ui(page)); },
});

export class Ui {
  constructor(readonly page: Page) {}

  async platformLogin(email = SEED.owner.email, password = SEED.owner.password) {
    await this.page.goto('/platform/login');
    const f = this.page.getByTestId('platform-login-form');
    await f.getByTestId('login-email').fill(email);
    await f.getByTestId('login-password').fill(password);
    await f.getByTestId('login-submit').click();
    await this.page.waitForURL(/\/platform\/tenants/);
  }

  async fillTenantLogin(code: string, email: string, password: string) {
    await this.page.goto('/login');
    const f = this.page.getByTestId('login-form');
    await f.getByTestId('login-tenant').fill(code);
    await f.getByTestId('login-email').fill(email);
    await f.getByTestId('login-password').fill(password);
    await f.getByTestId('login-submit').click();
  }

  async tenantLogin(code: string, email: string, password: string) {
    await this.fillTenantLogin(code, email, password);
    await this.page.waitForURL(/\/(dashboard|change-password)/);
  }

  async changePassword(current: string, next: string) {
    const f = this.page.getByTestId('change-password-form');
    await f.getByTestId('cp-current').fill(current);
    await f.getByTestId('cp-new').fill(next);
    await f.getByTestId('cp-confirm').fill(next);
    await f.getByTestId('cp-submit').click();
  }

  /** Opens a nav entry: sidebar on desktop, drawer on narrow viewports. */
  async nav(testId: string) {
    const link = this.page.getByTestId(testId).filter({ visible: true });
    // Phase 3: some entries (Modules → document types) arrive after the shell renders; wait for the link or the
    // mobile menu button before deciding.
    await expect(link.or(this.page.getByTestId('nav-open').filter({ visible: true })).first()).toBeVisible();
    if (await link.count() === 0) await this.page.getByTestId('nav-open').click();
    await this.page.getByTestId(testId).filter({ visible: true }).first().click();
  }

  /** nav-* test ids currently rendered in the (desktop) sidebar. */
  async sidebarEntries() {
    const aside = this.page.locator('aside');
    return aside.locator('[data-testid^="nav-"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid')!));
  }

  async createUser(name: string, email: string) {
    await this.page.getByTestId('create-user-button').click();
    const d = this.page.getByTestId('create-user-dialog');
    await expect(d).toBeVisible();
    await d.getByTestId('user-name').fill(name);
    await d.getByTestId('user-email').fill(email);
    await d.getByTestId('create-user-submit').click();
    return d;
  }
}

/** Serious + critical axe violations (WCAG 2.0/2.1 A + AA rules). */
export interface A11yViolation { id: string; impact: string | null | undefined; help: string; nodes: string[] }
export async function a11yViolations(page: Page, opts: { exclude?: string[] } = {}): Promise<A11yViolation[]> {
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  for (const sel of opts.exclude ?? []) b = b.exclude(sel);
  const res = await b.analyze();
  return res.violations
    .filter(v => v.impact === 'serious' || v.impact === 'critical')
    .map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map(n => n.target.join(' ')) }));
}

export const uniq = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

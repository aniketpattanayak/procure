/**
 * Mobile (Pixel 7 viewport, project `mobile-pixel7`): login, users list and the create-user dialog are usable;
 * nothing overflows horizontally; primary controls are on screen and tappable.
 * Also runs the axe check for the users list.
 */
import type { Page } from '@playwright/test';
import { a11yViolations, expect, kit, ownerApiToken, test, uniq } from './support/fixtures';

async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, 'page must not scroll horizontally').toBeLessThanOrEqual(cw + 1);
}

async function inViewport(page: Page, testId: string) {
  const box = await page.getByTestId(testId).filter({ visible: true }).first().boundingBox();
  const vp = page.viewportSize()!;
  expect(box, `${testId} rendered`).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
  // Touch target: at least 24x24 CSS px (WCAG 2.2 target size minimum).
  expect(box!.height).toBeGreaterThanOrEqual(24);
}

test('Mobile: login → users list → create user dialog', async ({ page, ui }) => {
  const owner = await ownerApiToken();
  const { tenant, admin } = await kit.tenantWithAdmin(owner, { limits: { max_users: 20 } }, { code: uniq('mb-').slice(0, 20) });
  for (let i = 0; i < 3; i++) await kit.user(admin.token, { name: `Mobile Person ${i}` });

  await test.step('login form fits and works', async () => {
    await page.goto('/login');
    await expect(page.getByTestId('login-form')).toBeVisible();
    await noHorizontalScroll(page);
    for (const id of ['login-tenant', 'login-email', 'login-password', 'login-submit']) await inViewport(page, id);
    await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
    await page.waitForURL(/\/dashboard/);
  });

  await test.step('desktop sidebar is hidden; the drawer opens and navigates to Users', async () => {
    await expect(page.locator('aside')).toBeHidden();
    await inViewport(page, 'nav-open');
    await page.getByTestId('nav-open').tap();
    await page.getByTestId('nav-users').filter({ visible: true }).tap();
    await page.waitForURL(/\/users$/);
  });

  await test.step('users list renders the users and does not overflow', async () => {
    const table = page.getByTestId('users-table');
    await expect(table).toBeVisible();
    await expect(table).toContainText('Mobile Person 0');
    await expect(table).toContainText(tenant.adminEmail);
    await noHorizontalScroll(page);
    await inViewport(page, 'create-user-button');
    await inViewport(page, 'users-search');
    await page.getByTestId('users-search').fill('Person 2');
    await expect(table).toContainText('Mobile Person 2');
    await expect(table).not.toContainText('Mobile Person 0');
    await page.getByTestId('users-search').fill('');
    expect(await a11yViolations(page)).toEqual([]);
  });

  await test.step('create-user dialog fits the screen and creates a user', async () => {
    await page.getByTestId('create-user-button').tap();
    const d = page.getByTestId('create-user-dialog');
    await expect(d).toBeVisible();
    const box = (await d.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
    await d.getByTestId('user-name').fill('Phone Made');
    await d.getByTestId('user-email').fill(`phone-${uniq('')}@mb.test`);
    await d.getByTestId('create-user-submit').scrollIntoViewIfNeeded();
    await inViewport(page, 'create-user-submit');
    await d.getByTestId('create-user-submit').tap();
    await expect(d.getByTestId('temp-password')).toBeVisible();
    await d.getByTestId('create-user-done').tap();
    await expect(d).toBeHidden();
    await expect(page.getByTestId('users-table')).toContainText('Phone Made');
    await noHorizontalScroll(page);
  });
});

test('Mobile: seed tenant users list has no horizontal scroll and no serious/critical axe violations', async ({ page, ui }) => {
  // Seed tenant acme (plan + overrides) — a realistic list with the seed admin.
  await ui.tenantLogin('acme', 'admin@acme.test', 'Admin@12345');
  await page.goto('/users');
  await expect(page.getByTestId('users-table')).toBeVisible();
  await noHorizontalScroll(page);
  expect(await a11yViolations(page)).toEqual([]);
});

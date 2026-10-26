/**
 * Lockout: 5 wrong passwords → the 5th shows the lockout message with the unlock time (from meta.lockedUntil).
 * Also: login page a11y (axe: zero serious/critical).
 */
import { a11yViolations, expect, kit, ownerApiToken, test, uniq } from './support/fixtures';

test('login page has no serious/critical axe violations', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByTestId('login-form')).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.goto('/platform/login');
  await expect(page.getByTestId('platform-login-form')).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
});

test('Lockout: 4 wrong passwords say "incorrect", the 5th locks with the unlock time; right password still refused', async ({ page, ui }) => {
  const owner = await ownerApiToken();
  const { tenant } = await kit.tenantWithAdmin(owner, {}, { code: uniq('lk-').slice(0, 20) });

  for (let i = 1; i <= 4; i++) {
    await ui.fillTenantLogin(tenant.code, tenant.adminEmail, `Wrong-pass-${i}`);
    await expect(page.getByTestId('login-error')).toHaveText('The company code, email or password is incorrect.');
  }

  await ui.fillTenantLogin(tenant.code, tenant.adminEmail, 'Wrong-pass-5');
  const err = page.getByTestId('login-error');
  await expect(err).toContainText('Too many failed attempts');
  // "locked until {time} (about {minutes} min)": a clock time and ~15 minutes (default security.lockout_minutes).
  await expect(err).toContainText(/locked until \d{1,2}:\d{2}/i);
  const minutes = Number(/about (\d+) min/.exec((await err.textContent()) ?? '')?.[1]);
  expect(minutes).toBeGreaterThanOrEqual(14);
  expect(minutes).toBeLessThanOrEqual(15);

  // The time shown matches the server's lockedUntil.
  const probe = await kit.t('POST', '/auth/login', { body: { tenantCode: tenant.code, email: tenant.adminEmail, password: 'NewAdmin@12345' } });
  expect(probe.status).toBe(423);
  expect(probe.body.code).toBe('AUTH.ACCOUNT_LOCKED');
  const until = new Date(probe.body.meta.lockedUntil);
  // The web formats with en-IN ("02:37 am"); compare hour:minute in the browser's timezone, locale-independent.
  const hm = await page.evaluate(iso => {
    const d = new Date(iso);
    return { h: d.getHours() % 12 || 12, m: d.getMinutes() };
  }, until.toISOString());
  const shownTime = /locked until (\d{1,2}):(\d{2})/i.exec((await err.textContent()) ?? '')!;
  expect({ h: Number(shownTime[1]) % 12 || 12, m: Number(shownTime[2]) }).toEqual(hm);

  // Right password while locked: still the lockout message, not a sign-in.
  await ui.fillTenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
  await expect(page.getByTestId('login-error')).toContainText('Too many failed attempts');
  await expect(page).toHaveURL(/\/login/);
});

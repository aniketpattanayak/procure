/**
 * J9a — User limit: on a tenant whose effective max_users leaves exactly 1 slot, the admin creates one user, the
 * next create shows the server's limit message (`user-limit-error`), Usage shows the bar at 100%, and a
 * limit_warning notification is in the bell.
 *
 * Setup through the API (test-kit): plan max_users 10, override → 3, admin + 1 user = 2 active → 1 slot left.
 */
import { a11yViolations, expect, kit, ownerApiToken, test, uniq } from './support/fixtures';

test('J9a: last slot succeeds, next create shows the server limit message, usage 100%, bell warning', async ({ page, ui }) => {
  const owner = await ownerApiToken();
  const { tenant, admin } = await kit.tenantWithAdmin(owner, { limits: { max_users: 10 }, features: ['indent'] }, { code: uniq('j9-').slice(0, 20) });
  await kit.setOverride(owner, tenant.tenantId, { kind: 'limit', key: 'max_users', value: 3, reason: 'J9a: leave one slot' });
  await kit.user(admin.token); // 2 / 3

  await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
  await page.waitForURL(/\/dashboard/);
  await ui.nav('nav-users');
  await expect(page.getByTestId('users-table')).toBeVisible();
  await expect(page.getByTestId('users-table')).toContainText(tenant.adminEmail);
  expect(await a11yViolations(page), 'users list a11y').toEqual([]);

  await test.step('creating the 3rd user (last slot) succeeds and reveals the temp password', async () => {
    const d = await ui.createUser('Last Slot', `last-${uniq('')}@j9.test`);
    await expect(d.getByTestId('temp-password')).toBeVisible();
    await expect(d.getByTestId('temp-password')).toHaveText(/^\S{16}$/);
    await d.getByTestId('create-user-done').click();
    await expect(d).toBeHidden();
  });

  await test.step('the next create shows user-limit-error with the server message', async () => {
    const d = await ui.createUser('One Too Many', `over-${uniq('')}@j9.test`);
    const err = d.getByTestId('user-limit-error');
    await expect(err).toBeVisible();
    // The server's message, verbatim (errors.ts AppError.limitExceeded).
    const probe = await kit.createUserRaw(admin.token);
    expect(probe.status).toBe(403);
    expect(probe.body.code).toBe('LIMIT_EXCEEDED.max_users');
    await expect(err).toHaveText(probe.body.title);
    await expect(err).toContainText('3 active users');
    await expect(d.getByTestId('temp-password')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  await test.step('Usage page shows max_users at 100% (full)', async () => {
    await ui.nav('nav-usage');
    const row = page.getByTestId('limit-max_users');
    await expect(row).toHaveAttribute('data-level', 'full');
    await expect(row).toContainText('3');
    const meter = row.getByRole('meter');
    await expect(meter).toHaveAttribute('aria-valuenow', '3');
    await expect(meter).toHaveAttribute('aria-valuemax', '3');
    await expect(meter).toHaveAttribute('data-level', 'full');
  });

  await test.step('a limit_warning notification is in the bell', async () => {
    // The badge count is cached from page load (QA-BUG-005), so reload before checking it.
    await page.reload();
    const bell = page.getByTestId('notifications-bell');
    await expect(bell).toHaveAccessibleName(/1 unread/i);
    await bell.click();
    const panel = page.getByTestId('notifications-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('You have reached your plan limit of 3 active users');
    // And the API agrees: an unread limit_warning at threshold 100 for this admin.
    const n = await kit.notifications(admin.token, { unread: 'true' });
    expect(n.data.some(x => x.kind === 'limit_warning' && x.data.threshold === 100)).toBe(true);
  });
});

// QA-BUG-005 (fixed): creating/activating a user invalidates the notifications query, so a limit_warning for the
// signed-in admin shows on the bell right away (also refetched on window focus and after mark-as-read).
test('[QA-BUG-005] bell badge updates right after an action that notifies the current admin', async ({ page, ui }) => {
  const owner = await ownerApiToken();
  const { tenant } = await kit.tenantWithAdmin(owner, { limits: { max_users: 2 } }, { code: uniq('j9c-').slice(0, 20) });
  await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
  await ui.nav('nav-users');
  await expect(page.getByTestId('notifications-bell')).toHaveAccessibleName('Notifications');
  const d = await ui.createUser('Fills Plan', `fill-${uniq('')}@j9.test`);
  await expect(d.getByTestId('temp-password')).toBeVisible();
  await d.getByTestId('create-user-done').click();
  await expect(page.getByTestId('notifications-bell')).toHaveAccessibleName(/1 unread/i, { timeout: 5_000 });
});

// QA-BUG-004: the limit_warning notification links to /settings/usage (users.service.ts) but the web route is /usage,
// so clicking the notification lands on "Page not found".
test('[QA-BUG-004] clicking a limit_warning notification opens the Usage page', async ({ page, ui }) => {
  const owner = await ownerApiToken();
  const { tenant, admin } = await kit.tenantWithAdmin(owner, { limits: { max_users: 2 } }, { code: uniq('j9b-').slice(0, 20) });
  await kit.user(admin.token); // 2/2 → 100% notification
  await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
  await page.getByTestId('notifications-bell').click();
  await page.getByTestId('notifications-panel').getByText('You have reached your plan limit').click();
  await expect(page).toHaveURL(/\/usage$/);
  await expect(page.getByTestId('limit-max_users')).toBeVisible();
});

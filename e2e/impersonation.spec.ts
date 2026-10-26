/**
 * Impersonation: Super Admin "Login as tenant" → banner with tenant + admin names → an action taken while
 * impersonating is audited with impersonated_by → Exit returns to the platform console (tenant detail).
 *
 * Phase 1 has no API that reads the *tenant* audit log (contract lists only GET /platform/audit), so the tenant-side
 * row is checked in the DB as the owner role; the platform-side row is checked through GET /platform/audit.
 */
import { Client } from 'pg';
import { SEED } from './support/env';
import { a11yViolations, expect, kit, ownerApiToken, test, uniq } from './support/fixtures';

const MIGRATOR = process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure';

test('Impersonation: banner, audited action with impersonated_by, Exit back to console', async ({ page, ui }) => {
  const owner = await ownerApiToken();
  const tenants = await kit.t('GET', '/platform/tenants', { token: owner, query: { q: SEED.globex.code, limit: 50 } });
  const globex = tenants.body.data.find((t: { code: string }) => t.code === SEED.globex.code);
  expect(globex, 'seed tenant globex').toBeTruthy();
  const me = await kit.t('GET', '/auth/me', { token: owner });
  const ownerId: string = me.body.principal.userId;
  const ownerName: string = me.body.principal.name;

  await ui.platformLogin();
  await page.goto(`/platform/tenants/${globex.id}`);
  await expect(page.getByTestId('entitlements')).toBeVisible();

  await test.step('Login as tenant (reason required)', async () => {
    await page.getByTestId('impersonate-button').click();
    const dlg = page.getByTestId('impersonate-dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('impersonate-dialog-confirm').click();
    await expect(dlg).toContainText(/at least|3/i); // reason is mandatory
    await dlg.getByTestId('impersonate-dialog-reason').fill('E2E: support ticket QA-1');
    await dlg.getByTestId('impersonate-dialog-confirm').click();
    await page.waitForURL(/\/dashboard/);
  });

  await test.step('banner shows tenant and Super Admin names; it survives a reload in this tab', async () => {
    const banner = page.getByTestId('impersonation-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(SEED.globex.name);
    await expect(banner).toContainText(ownerName);
    await page.reload();
    await expect(page.getByTestId('impersonation-banner')).toContainText(SEED.globex.name);
  });

  const email = `imp-${uniq('')}@globex.test`;
  await test.step('performs an action (create user) while impersonating', async () => {
    await ui.nav('nav-users');
    const d = await ui.createUser('Created By Support', email);
    await expect(d.getByTestId('temp-password')).toBeVisible();
    await d.getByTestId('create-user-done').click();
    await expect(page.getByTestId('users-table')).toContainText(email);
    await expect(page.getByTestId('impersonation-banner')).toBeVisible();
  });

  await test.step('the action is in the tenant audit with impersonated_by; start is in the platform audit', async () => {
    const c = new Client({ connectionString: MIGRATOR });
    await c.connect();
    try {
      const { rows } = await c.query(
        `select a.action, a.impersonated_by::text as imp, a.actor_id::text as actor
         from app.audit_log a join app.tenant_user u on u.id::text = a.entity_id
         where a.tenant_id = $1 and u.email = $2 and a.entity = 'user'`, [globex.id, email]);
      expect(rows).toEqual([expect.objectContaining({ action: 'create', imp: ownerId })]);
      expect(rows[0].actor).not.toBe(ownerId); // actor is the tenant admin being impersonated
      const start = await c.query(`select impersonated_by::text as imp from app.audit_log where tenant_id = $1 and action = 'impersonate_start' order by id desc limit 1`, [globex.id]);
      expect(start.rows[0]?.imp).toBe(ownerId);
    } finally {
      await c.end();
    }
    const pa = await kit.t('GET', '/platform/audit', { token: owner, query: { tenantId: globex.id, limit: 20 } });
    const startRow = pa.body.data.find((r: { action: string }) => r.action === 'impersonate_start');
    expect(startRow).toMatchObject({ action: 'impersonate_start', tenantId: globex.id });
    expect(JSON.stringify(startRow)).toContain('E2E: support ticket QA-1');
  });

  await test.step('Exit returns to the platform console', async () => {
    await page.getByTestId('impersonation-exit').click();
    await page.waitForURL(/\/platform\/tenants/);
    await expect(page.getByTestId('impersonation-banner')).toHaveCount(0);
    await expect(page.locator('aside')).toContainText('Platform console');
    // Platform session is intact (the Super Admin's own refresh cookie was never replaced).
    await ui.nav('nav-platform-audit');
    await expect(page.getByTestId('audit-table')).toBeVisible();
    expect(await a11yViolations(page)).toEqual([]);
  });
});

// QA-BUG-007 (fixed): Exit returns to the impersonated tenant's detail page. The session records the post-switch
// target before `me` flips, and AreaGuard redirects there (not to the platform home) while it is still mounted.
test('[QA-BUG-007] Exit lands on the impersonated tenant\'s detail page', async ({ page, ui }) => {
  const owner = await ownerApiToken();
  const tenants = await kit.t('GET', '/platform/tenants', { token: owner, query: { limit: 50 } });
  const globex = tenants.body.data.find((t: { code: string }) => t.code === SEED.globex.code);
  await ui.platformLogin();
  await page.goto(`/platform/tenants/${globex.id}`);
  await page.getByTestId('impersonate-button').click();
  await page.getByTestId('impersonate-dialog-reason').fill('E2E exit target');
  await page.getByTestId('impersonate-dialog-confirm').click();
  await expect(page.getByTestId('impersonation-banner')).toBeVisible();
  await page.getByTestId('impersonation-exit').click();
  await page.waitForURL(/\/platform\/tenants/);
  await page.waitForTimeout(1_500); // let any competing redirect settle
  await expect(page).toHaveURL(new RegExp(`/platform/tenants/${globex.id}$`), { timeout: 3_000 });
});

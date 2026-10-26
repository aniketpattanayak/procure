/**
 * Phase 2 plan limits surface a clear server message in the UI:
 *  - custom_forms reached → "New master" shows master-limit-error with the server's title;
 *  - max_locations reached → adding a location shows location-limit-error;
 *  - storage_gb exceeded (Super Admin sets override 0 on seed tenant globex in the console) → an image upload on an
 *    item shows the limit message and nothing is stored.
 */
import { expect, kit, ownerApiToken, test, uniq } from './support/fixtures';
import { png } from './support/phase2';
import { SEED } from './support/env';

test('custom_forms reached → clear message on "New master"', async ({ page, ui }) => {
  const owner = await ownerApiToken();
  const { tenant, admin } = await kit.builderTenant(owner, { custom_forms: 1 }, { code: uniq('cf-').slice(0, 20) });
  await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');

  await test.step('limit reached while the wizard is open → the server message shows in the wizard', async () => {
    await page.goto('/config/masters');
    await page.getByTestId('new-master-button').click();
    const w = page.getByTestId('new-master-wizard');
    await w.getByTestId('master-name').fill('Second Master');
    await w.getByTestId('master-wizard-next').click();
    await w.getByTestId('master-wizard-next').click();
    await kit.createMaster(admin.token, 'first_master'); // another admin takes the last slot meanwhile
    await w.getByTestId('master-wizard-submit').click();
    const err = w.getByTestId('master-limit-error');
    await expect(err).toBeVisible();
    const probe = await kit.call('POST', '/config/masters', admin.token, { key: 'probe_master', name: 'Probe', pluralName: 'Probes' });
    expect(probe.status).toBe(403);
    expect(probe.body.code).toBe('LIMIT_EXCEEDED.custom_forms');
    await expect(err).toContainText(probe.body.title);
    await page.keyboard.press('Escape');
    expect((await kit.ok('GET', '/masters', admin.token)).some((m: { key: string }) => m.key === 'second_master')).toBe(false);
  });

  await test.step('at the limit, "New master" is disabled and the page says why', async () => {
    await page.reload();
    await expect(page.getByTestId('new-master-button')).toBeDisabled();
    await expect(page.getByTestId('custom-forms-usage')).toBeVisible();
    await expect(page.getByTestId('custom-forms-usage')).toContainText(/1 custom master/);
    await expect(page.getByTestId('custom-forms-usage')).toContainText(/all in use/);
  });
});

test('max_locations reached → clear message when adding a location', async ({ page, ui }) => {
  const owner = await ownerApiToken();
  const { tenant, admin } = await kit.builderTenant(owner, { max_locations: 2 }, { code: uniq('ml-').slice(0, 20) });
  const p = await kit.location(admin.token, 'P1', 'Plant 1');
  await kit.location(admin.token, 'P1-S', 'Store', p.id);
  const probe = await kit.call('POST', '/locations', admin.token, { code: 'PROBE', name: 'Probe' });
  expect(probe.status).toBe(403);
  expect(probe.body.code).toBe('LIMIT_EXCEEDED.max_locations');

  await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
  await page.goto('/locations');
  await expect(page.getByTestId('locations-limit')).toHaveAttribute('data-level', 'full');
  await page.getByTestId('location-add-root').click();
  const d = page.getByTestId('location-add-dialog');
  await d.getByTestId('location-name').fill('Plant 2');
  await d.getByTestId('location-code').fill('P2');
  await d.getByTestId('location-submit').click();
  const err = d.getByTestId('location-limit-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText(probe.body.title);
  expect((await kit.locationTree(admin.token)).map((n: { code: string }) => n.code).sort()).toEqual(['P1', 'P1-S']);
});

test('storage_gb override 0 on globex (Super Admin console) → upload shows the limit message', async ({ page, ui, browser }) => {
  const owner = await ownerApiToken();
  const tenants = await kit.ok('GET', '/platform/tenants', owner);
  const globex = (tenants.data ?? tenants).find((t: { code: string }) => t.code === 'globex');

  await test.step('Super Admin sets storage_gb override = 0 with a reason', async () => {
    await ui.platformLogin();
    await page.goto(`/platform/tenants/${globex.id}`);
    await page.getByTestId('override-edit-storage_gb').click();
    const ed = page.getByTestId('override-editor');
    await ed.getByTestId('override-value').fill('0');
    await ed.getByTestId('override-reason').fill('QA: storage limit check');
    await ed.getByTestId('override-save').click();
    await expect(ed).toBeHidden();
    await expect(page.getByTestId('limit-row-storage_gb')).toContainText('0');
  });

  const admin = await kit.tenantLogin('globex', SEED.globex.email, SEED.globex.password);
  const { multipart } = await import('./support/phase2');
  const probe = await multipart('/files', admin.token, { name: 'p.png', body: png(8, 8), type: 'image/png' });
  expect(probe.status).toBe(403);
  expect(probe.body.code).toBe('LIMIT_EXCEEDED.storage_gb');

  await test.step('globex admin: image upload on a new item shows the server message', async () => {
    const ctx = await browser.newContext();
    const tp = await ctx.newPage();
    await tp.goto('/login');
    const f = tp.getByTestId('login-form');
    await f.getByTestId('login-tenant').fill('globex');
    await f.getByTestId('login-email').fill(SEED.globex.email);
    await f.getByTestId('login-password').fill(SEED.globex.password);
    await f.getByTestId('login-submit').click();
    await tp.waitForURL(/\/dashboard/);
    await tp.goto('/masters/item');
    await tp.getByTestId('master-add').click();
    const sheet = tp.getByTestId('record-sheet');
    await sheet.getByTestId('upload-input-image').setInputFiles({ name: 'item.png', mimeType: 'image/png', buffer: png(40, 40) });
    const msg = sheet.getByTestId('upload-image').getByRole('alert');
    await expect(msg).toBeVisible();
    await expect(msg).toContainText(probe.body.title);
    await expect(sheet.getByTestId('upload-image').getByTestId('upload-item')).toHaveCount(0);
    await ctx.close();
  });

  // Leave globex as seeded for other specs.
  await kit.setOverride(owner, globex.id, { kind: 'limit', key: 'storage_gb', remove: true, reason: 'QA cleanup' });
});

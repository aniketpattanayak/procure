/**
 * axe-core (WCAG 2.0/2.1 A + AA, serious + critical only) on the Phase 2 admin screens, as the acme admin:
 * permission screen (role + user access), location tree, form builder (with a lookup selected), master record form.
 */
import { a11yViolations, expect, test } from './support/fixtures';

test.beforeEach(async ({ ui }) => {
  await ui.tenantLogin('acme', 'admin@acme.test', 'Admin@12345');
});

test('a11y: permission screen (role) with the Items tab open', async ({ page }) => {
  await page.goto('/roles');
  await page.getByTestId('role-open-indent_clerk').click();
  await page.getByTestId('role-tab-permissions').click();
  await page.getByTestId('perm-tab-master.item').click();
  await expect(page.getByTestId('perm-form-item')).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.getByTestId('role-tab-scope').click();
  await expect(page.getByTestId('scope-editor')).toBeVisible();
  expect(await a11yViolations(page), 'scope editor').toEqual([]);
});

test('a11y: location tree with a node selected', async ({ page }) => {
  await page.goto('/locations');
  await page.getByTestId('locations-expand-all').click();
  await page.getByTestId('location-row-PUNE-MAIN').click();
  await expect(page.getByTestId('location-detail')).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
});

test('[QA2-BUG-007] a11y: form builder canvas (Item form, a lookup selected)', async ({ page }) => {
  await page.goto('/config/forms/item');
  await page.getByTestId('canvas-field-sub_category').click();
  await expect(page.getByTestId('prop-group-lookup')).toBeVisible();
  const v = await a11yViolations(page);
  expect(v).toEqual([]);
});

test('a11y: master record form (new Item, cascade fields)', async ({ page }) => {
  await page.goto('/masters/item');
  await page.getByTestId('master-add').click();
  await expect(page.getByTestId('record-sheet').getByTestId('form-item')).toBeVisible();
  expect(await a11yViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByTestId('master-records-table').getByRole('row').filter({ hasText: 'MS Plate 6 mm' }).click();
  await expect(page.getByTestId('record-sheet').getByTestId('record-name-value')).toBeVisible();
  expect(await a11yViolations(page), 'record view mode').toEqual([]);
});

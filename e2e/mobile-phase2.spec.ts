/**
 * Phase 2 on a phone (project mobile-pixel7): master record form with the cascade + live formula + image upload,
 * the location tree, and the permission screen (tab list becomes a select). No horizontal scroll anywhere.
 * Runs on a fresh form-builder tenant so it does not depend on the desktop journeys.
 */
import type { Page } from '@playwright/test';
import { a11yViolations, expect, kit, ownerApiToken, test, uniq } from './support/fixtures';
import { lookupEmptyText, lookupOptions, pickLookup, png } from './support/phase2';

async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, 'page must not scroll horizontally').toBeLessThanOrEqual(cw + 1);
}

test('Mobile: cascade + formula + image on a master record, location tree, permission screen', async ({ page, ui }) => {
  test.setTimeout(150_000);
  const owner = await ownerApiToken();
  const { tenant, admin } = await kit.builderTenant(owner, {}, { code: uniq('mp-').slice(0, 20) });
  const t = admin.token;
  await kit.createMaster(t, 'family');
  await kit.createMaster(t, 'subfamily', [{ key: 'family', label: 'Family', type: 'lookup', source: { kind: 'master', masterKey: 'family' }, required: true }]);
  const fa = await kit.record(t, 'family', { code: 'A', name: 'Alpha' });
  const fb = await kit.record(t, 'family', { code: 'B', name: 'Beta' });
  await kit.record(t, 'family', { code: 'C', name: 'Gamma' });
  await kit.record(t, 'subfamily', { code: 'A1', name: 'Alpha one', data: { family: fa.id } });
  await kit.record(t, 'subfamily', { code: 'A2', name: 'Alpha two', data: { family: fa.id } });
  await kit.record(t, 'subfamily', { code: 'B1', name: 'Beta one', data: { family: fb.id } });
  await kit.createMaster(t, 'tool', [
    { key: 'family', label: 'Family', type: 'lookup', source: { kind: 'master', masterKey: 'family' } },
    { key: 'subfamily', label: 'Sub-family', type: 'lookup', source: { kind: 'master', masterKey: 'subfamily' }, filterBy: [{ field: 'family', targetField: 'family' }] },
    { key: 'rate', label: 'Rate', type: 'currency' },
    { key: 'with_tax', label: 'With tax', type: 'formula', expr: 'rate * 1.18', precision: 2 },
    { key: 'photo', label: 'Photo', type: 'image' },
  ]);
  const plant = await kit.location(t, 'PL', 'Plant');
  const store = await kit.location(t, 'PL-ST', 'Store', plant.id);
  await kit.location(t, 'PL-ST-B1', 'Bin 1', store.id);

  await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');

  await test.step('record form on a phone: cascade, empty state, formula, upload, save', async () => {
    await page.goto('/masters/tool');
    await noHorizontalScroll(page);
    await page.getByTestId('master-add').tap();
    const sheet = page.getByTestId('record-sheet');
    await expect(sheet.getByTestId('form-tool')).toBeVisible();
    // The sheet slides in; once settled it must fit the screen.
    await expect.poll(async () => { const b = (await sheet.boundingBox())!; return Math.round(b.x + b.width); }).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect((await sheet.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await sheet.getByTestId('record-code').fill('T1');
    await sheet.getByTestId('record-name').fill('Phone tool');
    await pickLookup(page, 'family', /Alpha/);
    expect((await lookupOptions(page, 'subfamily')).map(s => s.split(' ')[0]).sort()).toEqual(['A1', 'A2']);
    await pickLookup(page, 'family', /Gamma/);
    expect(await lookupEmptyText(page, 'subfamily')).toMatch(/Family/i);
    await pickLookup(page, 'family', /Beta/);
    expect((await lookupOptions(page, 'subfamily')).map(s => s.split(' ')[0])).toEqual(['B1']);
    await pickLookup(page, 'subfamily', /Beta one/);
    await sheet.getByTestId('field-rate-input').fill('100');
    await expect(sheet.getByTestId('field-with_tax')).toContainText('118');
    await sheet.getByTestId('upload-input-photo').setInputFiles({ name: 'tool.png', mimeType: 'image/png', buffer: png(60, 60, [200, 60, 30]) });
    await expect(sheet.getByTestId('upload-photo').getByTestId('upload-item').locator('img')).toBeVisible();
    await sheet.getByTestId('record-save').tap();
    await expect(sheet.getByTestId('record-code-value')).toHaveText('T1');
    expect(await a11yViolations(page), 'record form (mobile)').toEqual([]);
    await page.keyboard.press('Escape');
    const rec = (await kit.records(t, 'tool')).data[0];
    expect(rec.data.with_tax).toBe('118.00');
  });

  await test.step('location tree on a phone', async () => {
    await page.getByTestId('nav-open').tap();
    await page.getByTestId('nav-locations').filter({ visible: true }).tap();
    await page.waitForURL(/\/locations$/);
    await page.getByTestId('locations-expand-all').tap();
    await expect(page.getByTestId('location-row-PL-ST-B1')).toBeVisible();
    await noHorizontalScroll(page);
    await page.getByTestId('location-row-PL-ST').tap();
    await expect(page.getByText('Plant').first()).toBeVisible();
  });

  await test.step('permission screen on a phone: tabs become a select', async () => {
    const role = await kit.role(t, `ph_${uniq('').slice(0, 6)}`, 'Phone role');
    await page.goto(`/roles/${role.id}`);
    await page.getByTestId('role-tab-permissions').tap();
    const sel = page.getByTestId('perm-tab-select');
    await expect(sel).toBeVisible();
    await expect(page.getByTestId('perm-tab-list')).toBeHidden();
    await sel.selectOption('master.tool');
    await page.getByTestId('perm-master.tool:action.view').tap();
    await page.getByTestId('perm-save').tap();
    await expect(page.getByTestId('perm-save')).toBeDisabled();
    await noHorizontalScroll(page);
    const v = await kit.ok('GET', `/roles/${role.id}/permissions`, t);
    expect(v.grants.map((g: { key: string }) => g.key)).toEqual(['master.tool:action.view']);
  });
});

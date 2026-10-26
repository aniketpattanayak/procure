/**
 * Locations: renamed level labels (Settings › Labels), Plant → Store → Bin built in the tree UI, move a Store with
 * children to another Plant (bins follow), deactivate cascades, delete blocked while referenced (a role's data scope).
 * Fresh tenant per run (test-kit), so the seed tree is untouched.
 */
import { a11yViolations, expect, kit, ownerApiToken, test, uniq } from './support/fixtures';
import type { Page } from '@playwright/test';

async function addNode(page: Page, how: { root: true } | { parentCode: string }, name: string, code: string, expectLevel: string) {
  if ('root' in how) {
    await page.getByTestId('location-add-root').click();
  } else {
    await page.getByTestId(`location-row-${how.parentCode}`).click();
    await page.getByTestId('location-detail').getByTestId('location-add-child').click();
  }
  const d = page.getByTestId('location-add-dialog');
  await expect(d).toBeVisible();
  await expect(d.getByTestId('location-submit')).toContainText(expectLevel);
  await d.getByTestId('location-name').fill(name);
  await d.getByTestId('location-code').fill(code);
  await d.getByTestId('location-submit').click();
  await expect(d).toBeHidden();
  await expect(page.getByTestId(`location-row-${code}`)).toBeVisible();
}

test('Locations: renamed levels, build Plant/Store/Bin, move subtree, cascade deactivate, delete blocked when referenced', async ({ page, ui }) => {
  test.setTimeout(180_000);
  const owner = await ownerApiToken();
  const { tenant, admin } = await kit.builderTenant(owner, { max_locations: 50 }, { code: uniq('loc-').slice(0, 20) });

  await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');

  await test.step('rename the level labels in Settings › Labels', async () => {
    await page.goto('/settings');
    await page.getByTestId('settings-tab-labels').click();
    const ed = page.getByTestId('levels-editor');
    await expect(ed).toBeVisible();
    const want = ['Site', 'Warehouse', 'Rack'];
    for (let i = 0; i < want.length; i++) {
      if (await ed.getByTestId(`level-${i}`).count() === 0) await ed.getByTestId('level-add').click();
      await ed.getByTestId(`level-${i}`).fill(want[i]!);
    }
    while (await ed.getByTestId('level-3').count()) await ed.getByTestId('level-3-remove').click();
    await expect(ed.getByTestId('levels-preview')).toContainText('Site');
    await page.getByTestId('settings-save').click();
    await expect(page.getByTestId('settings-savebar')).toBeHidden();
    const s = await kit.ok('GET', '/config/settings', admin.token);
    expect(s.find((r: { key: string }) => r.key === 'labels.location_levels').value).toEqual(want);
  });

  await test.step('build two sites, a warehouse with two racks', async () => {
    await page.goto('/locations');
    await addNode(page, { root: true }, 'North Site', 'N', 'Site');
    await addNode(page, { root: true }, 'South Site', 'S', 'Site');
    await addNode(page, { parentCode: 'N' }, 'North Warehouse', 'N-W', 'Warehouse');
    await addNode(page, { parentCode: 'N-W' }, 'Rack 1', 'N-W-1', 'Rack');
    await addNode(page, { parentCode: 'N-W' }, 'Rack 2', 'N-W-2', 'Rack');
    await expect(page.getByTestId('location-row-N-W-1')).toContainText('Rack');
    expect(await a11yViolations(page), 'location tree a11y').toEqual([]);
  });

  await test.step('move the warehouse (with racks) to the South site; racks follow', async () => {
    await page.getByTestId('location-row-N-W').click();
    await page.getByTestId('location-detail').getByTestId('location-move').click();
    const d = page.getByTestId('location-move-dialog');
    await expect(d).toBeVisible();
    // Its own branch is not a valid target.
    await expect(d.getByTestId('location-move-node-N-W-1')).toHaveCount(0).catch(async () => {
      await expect(d.getByTestId('location-move-node-N-W-1')).toBeDisabled();
    });
    await d.getByTestId('location-move-node-S').click();
    await d.getByTestId('location-move-submit').click();
    await expect(d).toBeHidden();
    const tree = await kit.locationTree(admin.token, { view: 'all' });
    const by: Record<string, { pathNames: string[]; levelLabel: string }> = Object.fromEntries(tree.map((n: { code: string; pathNames: string[]; levelLabel: string }) => [n.code, n]));
    expect(by['N-W'].pathNames).toEqual(['South Site']);
    expect(by['N-W-1'].pathNames).toEqual(['South Site', 'North Warehouse']);
    expect(by['N-W-2'].pathNames).toEqual(['South Site', 'North Warehouse']);
    expect(by['N-W-1'].levelLabel).toBe('Rack');
    await page.getByTestId('locations-expand-all').click();
    await page.getByTestId('location-row-N-W-1').click();
    await expect(page.getByTestId('location-detail')).toContainText('South Site');
  });

  await test.step('deactivating the South site cascades to warehouse and racks', async () => {
    await page.getByTestId('location-row-S').click();
    await page.getByTestId('location-detail').getByTestId('location-deactivate').click();
    const c = page.getByTestId('confirm-location-deactivate');
    await expect(c).toContainText('3'); // warns how many sub-locations go with it
    await c.getByTestId('confirm-location-deactivate-confirm').click();
    await expect(c).toBeHidden();
    const tree = await kit.locationTree(admin.token, { view: 'all' });
    const inactive = tree.filter((n: { isActive: boolean }) => !n.isActive).map((n: { code: string }) => n.code).sort();
    expect(inactive).toEqual(['N-W', 'N-W-1', 'N-W-2', 'S']);
    // Activating a rack under an inactive warehouse is refused.
    const rack = tree.find((n: { code: string }) => n.code === 'N-W-1');
    expect((await kit.call('POST', `/locations/${rack.id}/activate`, admin.token)).status).toBe(409);
  });

  await test.step('delete is blocked while a role scope references the node; allowed once unreferenced', async () => {
    const tree = await kit.locationTree(admin.token, { view: 'all' });
    const n = tree.find((x: { code: string }) => x.code === 'N');
    const role = await kit.role(admin.token);
    await kit.ok('PUT', `/roles/${role.id}/scope`, admin.token, { entries: [{ nodeId: n.id }] });
    await page.reload();
    await page.getByTestId('locations-view-all').click().catch(() => undefined);
    await page.getByTestId('location-row-N').click();
    await page.getByTestId('location-detail').getByTestId('location-delete').click();
    const c = page.getByTestId('confirm-location-delete');
    await c.getByTestId('confirm-location-delete-confirm').click();
    await expect(c.getByTestId('location-used-by')).toBeVisible();
    await expect(c.getByTestId('location-used-by')).toContainText(/scope|role|access/i);
    await page.keyboard.press('Escape');
    expect((await kit.call('GET', `/locations/${n.id}`, admin.token)).status).toBe(200);
    // A node with children cannot be deleted either.
    const s = tree.find((x: { code: string }) => x.code === 'S');
    expect((await kit.call('DELETE', `/locations/${s.id}`, admin.token)).status).toBe(409);
    await kit.ok('PUT', `/roles/${role.id}/scope`, admin.token, { entries: [] });
    expect((await kit.call('DELETE', `/locations/${n.id}`, admin.token)).status).toBe(204);
  });
});

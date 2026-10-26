/**
 * J3 — A restricted user sees exactly what is granted (Phase 2 adaptation of the brief's indent journey, on the Item
 * master): the acme admin edits role "Indent clerk" on the permission screen (master.item: view + add + edit,
 * view `inactive` only, `std_rate` hidden, `hsn_code` read-only; scope stays Pune Plant). The indenter then sees only
 * that, in the UI and at the API; finally a per-user Deny on `add` removes the Add button on the next page load.
 */
import { expect, kit, test } from './support/fixtures';
import { acmeAdmin, INDENTER } from './support/phase2';

const TAB = 'master.item';
const K = (s: string) => `${TAB}:${s}`;

test('J3: restricted user (Indent clerk) sees exactly what the role grants, UI and API', async ({ page, ui, browser }) => {
  test.setTimeout(180_000);
  const admin = await acmeAdmin();
  // One inactive item so the "inactive" view has content.
  const items = await kit.recordIds(admin.token, 'item');
  await kit.ok('POST', `/masters/item/records/${items['ITM-00005']}/deactivate`, admin.token);

  await test.step('admin: permission screen → role Indent clerk → Items tab', async () => {
    await ui.tenantLogin('acme', 'admin@acme.test', 'Admin@12345');
    await page.goto('/roles');
    await page.getByTestId('role-open-indent_clerk').click();
    await page.waitForURL(/\/roles\/[0-9a-f-]{36}/);
    await page.getByTestId('role-tab-permissions').click();
    const wb = page.getByTestId('perm-workbench');
    await expect(wb).toBeVisible();
    await wb.getByTestId('perm-tab-search').fill('Items');
    await wb.getByTestId(`perm-tab-${TAB}`).click();

    for (const k of ['action.view', 'action.add', 'action.edit']) await wb.getByTestId(`perm-${K(k)}`).click();
    await wb.getByTestId(`perm-${K('view.inactive')}`).click();
    for (const k of ['action.view', 'action.add', 'action.edit', 'view.inactive']) await expect(wb.getByTestId(`perm-${K(k)}`)).toBeChecked();
    for (const k of ['action.deactivate', 'action.delete', 'action.import', 'action.export', 'view.active']) await expect(wb.getByTestId(`perm-${K(k)}`)).not.toBeChecked();

    // Segmented radios are visually hidden inputs inside their <label>: click the label like a user does.
    await wb.getByTestId('field-item-std_rate-hidden').locator('xpath=..').click();
    await wb.getByTestId('field-item-hsn_code-readonly').locator('xpath=..').click();
    await expect(wb.getByTestId('field-item-std_rate-hidden')).toBeChecked();
    await expect(wb.getByTestId('field-item-hsn_code-readonly')).toBeChecked();
    await wb.getByTestId('perm-save').click();
    await expect(wb.getByTestId('perm-save')).toBeDisabled();
    await expect(wb.getByTestId(`perm-tab-${TAB}`)).toHaveAttribute('data-granted', /4/);
  });

  // The API agrees with what the screen saved, and the scope is untouched.
  const roles = await kit.ok('GET', '/roles', admin.token);
  const clerk = (roles.data ?? roles).find((r: { key: string }) => r.key === 'indent_clerk');
  const view = await kit.ok('GET', `/roles/${clerk.id}/permissions`, admin.token);
  expect(view.grants.filter((g: { key: string }) => g.key.startsWith(TAB)).map((g: { key: string }) => g.key).sort())
    .toEqual([K('action.add'), K('action.edit'), K('action.view'), K('view.inactive')]);
  expect(view.fieldAccess.filter((f: { formKey: string }) => f.formKey === 'item').map((f: { fieldKey: string; mode: string }) => `${f.fieldKey}:${f.mode}`).sort())
    .toEqual(['hsn_code:readonly', 'std_rate:hidden']);
  expect(view.scope.map((s: { nodeName?: string; includeDescendants: boolean }) => [s.nodeName, s.includeDescendants])).toEqual([['Pune Plant', true]]);

  const ctx = await browser.newContext();
  const ip = await ctx.newPage();
  const ind = await kit.tenantLogin('acme', INDENTER.email, INDENTER.password);

  await test.step('indenter: sidebar shows Items and Locations, not Users/Roles/Settings/Forms', async () => {
    await ip.goto('/login');
    const f = ip.getByTestId('login-form');
    await f.getByTestId('login-tenant').fill('acme');
    await f.getByTestId('login-email').fill(INDENTER.email);
    await f.getByTestId('login-password').fill(INDENTER.password);
    await f.getByTestId('login-submit').click();
    await ip.waitForURL(/\/dashboard/);
    const aside = ip.locator('aside');
    await expect(aside.getByTestId('nav-masters-item')).toBeVisible();
    await expect(aside.getByTestId('nav-locations')).toBeVisible();
    for (const id of ['nav-users', 'nav-roles', 'nav-settings', 'nav-config-forms', 'nav-config-masters', 'nav-usage', 'nav-masters-vendor', 'nav-masters-item_category']) {
      await expect(aside.getByTestId(id), id).toHaveCount(0);
    }
  });

  await test.step('indenter: Items list = inactive items only, no forbidden buttons, std_rate absent', async () => {
    await ip.getByTestId('nav-masters-item').click();
    await ip.waitForURL(/\/masters\/item$/);
    const table = ip.getByTestId('master-records-table');
    await expect(table.getByRole('row').filter({ hasText: 'Cotton Waste' })).toBeVisible();
    await expect(table).not.toContainText('MS Plate 6 mm');
    await expect(ip.getByTestId('master-view-active')).toHaveCount(0);
    await expect(ip.getByTestId('master-view-all')).toHaveCount(0);
    for (const id of ['master-import', 'master-export', 'master-edit-form']) await expect(ip.getByTestId(id), id).toHaveCount(0);
    await expect(ip.getByTestId('master-add')).toBeVisible();
    // std_rate is not a column, not even in the column chooser.
    await ip.getByTestId('datatable-columns').click();
    await expect(ip.getByRole('menuitemcheckbox', { name: /Standard rate/ })).toHaveCount(0);
    await expect(ip.getByRole('menuitemcheckbox', { name: /HSN/ })).toHaveCount(1);
    await ip.keyboard.press('Escape');

    await table.getByRole('row').filter({ hasText: 'Cotton Waste' }).click();
    const sheet = ip.getByTestId('record-sheet');
    await expect(sheet.getByTestId('record-name-value')).toHaveText('Cotton Waste');
    for (const id of ['record-deactivate', 'record-activate', 'record-delete']) await expect(sheet.getByTestId(id), id).toHaveCount(0);
    await expect(sheet.getByTestId('field-std_rate')).toHaveCount(0);
    await expect(sheet.getByTestId('field-hsn_code-value')).toHaveText('5202');
    await sheet.getByTestId('record-edit').click();
    await expect(sheet.getByTestId('field-std_rate')).toHaveCount(0);
    const hsn = sheet.getByTestId('field-hsn_code-input');
    await expect(hsn.or(sheet.getByTestId('field-hsn_code-value')).first()).toBeVisible();
    if (await hsn.count()) await expect(hsn).not.toBeEditable();
    await ip.keyboard.press('Escape');
  });

  await test.step('indenter: the API enforces the same (403s, hidden field omitted, FIELD_READ_ONLY)', async () => {
    const t = ind.token;
    expect((await kit.call('GET', '/masters/item/records', t, undefined, { view: 'active' })).status).toBe(403);
    expect((await kit.call('GET', '/masters/item/records', t, undefined, { view: 'all' })).status).toBe(403);
    const list = await kit.records(t, 'item'); // default view = first permitted = inactive
    expect(list.data.map(r => r.code)).toEqual(['ITM-00005']);
    expect(list.data[0].data).not.toHaveProperty('std_rate');
    const rec = list.data[0];
    expect((await kit.call('POST', `/masters/item/records/${rec.id}/deactivate`, t)).status).toBe(403);
    expect((await kit.call('POST', `/masters/item/records/${rec.id}/activate`, t)).status).toBe(403);
    expect((await kit.call('DELETE', `/masters/item/records/${rec.id}`, t, { reason: 'x' })).status).toBe(403);
    expect((await kit.call('GET', '/masters/item/export', t)).status).toBe(403);
    expect((await kit.call('GET', '/masters/item/template.xlsx', t)).status).toBe(403);
    expect((await kit.call('GET', '/masters/vendor/records', t)).status).toBe(403);
    expect((await kit.call('GET', '/users', t)).status).toBe(403);
    expect((await kit.call('GET', '/config/forms', t)).status).toBe(403);

    const edit = await kit.call('PUT', `/masters/item/records/${rec.id}`, t, { name: rec.name, data: { ...rec.data, hsn_code: '9999' }, version: rec.version });
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe('FIELD_READ_ONLY');
    expect(edit.body.meta?.field).toBe('hsn_code');
    const hidden = await kit.call('PUT', `/masters/item/records/${rec.id}`, t, { name: rec.name, data: { ...rec.data, std_rate: '1' }, version: rec.version });
    expect(hidden.status).toBe(403);
    expect(hidden.body.code).toBe('FIELD_READ_ONLY');
    // Unchanged read-only value + a permitted change is fine, and the hidden value survives.
    const ok = await kit.call('PUT', `/masters/item/records/${rec.id}`, t, { name: 'Cotton Waste (bales)', data: rec.data, version: rec.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const asAdmin = (await kit.records(admin.token, 'item', { view: 'inactive' })).data[0];
    expect(asAdmin.data.std_rate).toBe('55.00'); // numeric values are normalised to field precision (Phase 2 decision)
    expect(asAdmin.data.hsn_code).toBe('5202');
  });

  await test.step('indenter: /locations?scope=mine is only the Pune subtree', async () => {
    const mine = await kit.locationTree(ind.token, { scope: 'mine' });
    expect(mine.map((n: { code: string }) => n.code).sort()).toEqual(['PUNE', 'PUNE-MAIN', 'PUNE-MAIN-A1', 'PUNE-MAIN-A2']);
    // pathNames = ancestors (root has none): every node is Pune Plant or below it.
    expect(mine.every((n: { name: string; pathNames: string[] }) => (n.pathNames[0] ?? n.name) === 'Pune Plant')).toBe(true);
    // admin.locations is a scoped tab: scope=all is limited to the indenter's own scope too.
    const allRes = await kit.call('GET', '/locations/tree', ind.token, undefined, { scope: 'all' });
    expect(allRes.status).toBe(200);
    expect(allRes.body.map((n: { code: string }) => n.code).sort()).toEqual(['PUNE', 'PUNE-MAIN', 'PUNE-MAIN-A1', 'PUNE-MAIN-A2']);
  });

  await test.step('per-user Deny on add → the Add button is gone on the next page load', async () => {
    await kit.ok('PUT', `/users/${ind.userId}/permissions/tabs/${TAB}`, admin.token, { allow: [], deny: [K('action.add')], fieldAccess: [] });
    expect((await kit.call('POST', '/masters/item/records', ind.token, { name: 'Should fail', data: {} })).status).toBe(403);
    await ip.reload();
    await expect(ip.getByTestId('master-records-table')).toBeVisible();
    await expect(ip.getByTestId('master-add')).toHaveCount(0);
  });

  await ctx.close();
});

test('[QA2-BUG-008] a user with only the "inactive" view sees that single view chip', async ({ page, ui }) => {
  const { ownerApiToken, uniq } = await import('./support/fixtures');
  const owner = await ownerApiToken();
  const { tenant, admin } = await kit.builderTenant(owner, {}, { code: uniq('vc-').slice(0, 20) });
  const uom = await kit.record(admin.token, 'uom', { code: 'NOS', name: 'Numbers', data: { decimals: '0' } });
  const it = await kit.record(admin.token, 'item', { name: 'Old item', data: { uom: uom.id } });
  await kit.record(admin.token, 'item', { name: 'Current item', data: { uom: uom.id } });
  await kit.ok('POST', `/masters/item/records/${it.id}/deactivate`, admin.token);
  const role = await kit.roleWithKeys(admin.token, [K('action.view'), K('view.inactive')]);
  const u = await kit.signedInUser(tenant.code, admin.token, [role.id]);
  await ui.tenantLogin(tenant.code, u.email, u.password);
  await page.goto('/masters/item');
  await expect(page.getByTestId('master-records-table')).toContainText('Old item');
  await expect(page.getByTestId('master-records-table')).not.toContainText('Current item');
  await expect(page.getByTestId('master-view-active')).toHaveCount(0);
  await expect(page.getByTestId('master-view-inactive')).toBeVisible();
  await expect(page.getByTestId('master-view-inactive')).toHaveAttribute('aria-checked', 'true');
});

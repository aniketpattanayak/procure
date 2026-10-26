/**
 * J2 — Admin builds a cascade and a form (product brief), on seed tenant acme:
 *   master "Item Group" (lookup → Item Sub-category) built in the UI and published;
 *   Item form gets `group` (lookup → item_group, filterBy sub_category), `landed_rate = std_rate * 1.05` and an image
 *   field `photo`; an item is created through the UI and the 3-level cascade, live formula, upload and list are
 *   checked; finally the API rejects a sub-category that does not belong to the category (400 on that field).
 */
import { expect, kit, test } from './support/fixtures';
import {
  acmeAdmin, builderPublish, lookupEmptyText, lookupOptions, pickLookup, png, typeFormula,
} from './support/phase2';

test.describe.configure({ mode: 'serial' });

test('J2: Item Group master + Item form (cascade, formula, image) → create item through the UI', async ({ page, ui }) => {
  test.setTimeout(240_000);
  const admin = await acmeAdmin();

  await ui.tenantLogin('acme', 'admin@acme.test', 'Admin@12345');

  await test.step('create master "Item Group" with the wizard', async () => {
    await page.goto('/config/masters');
    await page.getByTestId('new-master-button').click();
    const w = page.getByTestId('new-master-wizard');
    await w.getByTestId('master-name').fill('Item Group');
    await expect(w.getByTestId('master-key')).toHaveValue('item_group');
    await expect(w.getByTestId('master-plural')).toHaveValue('Item Groups');
    await w.getByTestId('master-wizard-next').click();
    await w.getByTestId('master-wizard-next').click();
    await w.getByTestId('master-wizard-submit').click();
    await page.waitForURL(/\/config\/forms\/item_group$/);
    await expect(page.getByTestId('form-builder')).toBeVisible();
  });

  await test.step('Item Group form: lookup "Sub-category" → item_subcategory; publish', async () => {
    await page.getByTestId('palette-lookup').click();
    const props = page.getByTestId('builder-properties');
    await props.getByTestId('prop-label').fill('Sub-category');
    await expect(props.getByTestId('prop-key')).toHaveValue('sub_category');
    await props.getByTestId('prop-source-master').selectOption('item_subcategory');
    await props.getByTestId('prop-required').click();
    await builderPublish(page, 'Item Group: sub-category');
    const f = await kit.formFields(admin.token, 'item_group');
    expect(f.find(x => x.key === 'sub_category')).toMatchObject({ type: 'lookup', source: { kind: 'master', masterKey: 'item_subcategory' } });
  });

  // Group records (data entry is not what this journey is about): D → G-D1, G-D2; E → G-E1; H → G-H1.
  const sub = await kit.recordIds(admin.token, 'item_subcategory');
  const cat = await kit.recordIds(admin.token, 'item_category');
  for (const [code, name, s] of [['G-D1', 'Steel plates', 'D'], ['G-D2', 'Steel bars', 'D'], ['G-E1', 'Copper wire', 'E'], ['G-H1', 'Boxes', 'H']] as const) {
    await kit.record(admin.token, 'item_group', { code, name, data: { sub_category: sub[s] } });
  }

  await test.step('Item form: add group (cascade), landed_rate formula and photo image; publish', async () => {
    await page.goto('/config/forms/item');
    await expect(page.getByTestId('form-builder')).toBeVisible();
    const props = page.getByTestId('builder-properties');

    // group: lookup → item_group filtered by this form's sub_category
    await page.getByTestId('canvas-field-std_pack_value').click();
    await page.getByTestId('palette-lookup').click();
    await props.getByTestId('prop-label').fill('Group');
    await expect(props.getByTestId('prop-key')).toHaveValue('group');
    await props.getByTestId('prop-source-master').selectOption('item_group');
    await props.getByTestId('prop-filterBy-add').click();
    await props.getByTestId('prop-filterBy-field-0').selectOption('sub_category');
    await props.getByTestId('prop-filterBy-target-0').selectOption('sub_category');

    // landed_rate = std_rate * 1.05 (a typo first: squiggle + suggestion)
    await page.getByTestId('palette-formula').click();
    await props.getByTestId('prop-label').fill('Landed rate');
    await expect(props.getByTestId('prop-key')).toHaveValue('landed_rate');
    await typeFormula(page, 'prop-expr', 'std_rat * 1.05');
    await expect(props.locator('.cm-lintRange-error').first()).toBeVisible();
    await expect(props.getByTestId('prop-expr-status')).toContainText(/std_rate/);
    await typeFormula(page, 'prop-expr', 'std_rate * 1.05');
    await expect(props.locator('.cm-lintRange-error')).toHaveCount(0);
    await props.getByTestId('prop-expr-test-toggle').click();
    const panel = props.getByTestId('formula-test-panel');
    await panel.getByLabel('std_rate').fill('200');
    await expect(panel.getByTestId('formula-test-result')).toContainText('210');

    // photo: image
    await page.getByTestId('palette-image').click();
    await props.getByTestId('prop-label').fill('Photo');
    await expect(props.getByTestId('prop-key')).toHaveValue('photo');

    await builderPublish(page, 'J2: group, landed rate, photo');
    const f = await kit.formFields(admin.token, 'item');
    expect(f.find(x => x.key === 'group')).toMatchObject({ type: 'lookup', filterBy: [{ field: 'sub_category', targetField: 'sub_category' }] });
    expect(f.find(x => x.key === 'landed_rate')).toMatchObject({ type: 'formula', expr: 'std_rate * 1.05' });
    expect(f.find(x => x.key === 'photo')).toMatchObject({ type: 'image' });
  });

  // List columns so the list shows lookups and the thumbnail (Masters › Item settings; API for brevity).
  const item = (await kit.ok('GET', '/masters', admin.token)).find((m: { key: string }) => m.key === 'item');
  await kit.ok('PUT', '/config/masters/item', admin.token, { settings: { ...item.settings, listColumns: ['uom', 'category', 'sub_category', 'group', 'photo', 'landed_rate'] }, version: item.version });

  await test.step('create an item: 3-level cascade, live formula, image upload', async () => {
    await page.goto('/masters/item');
    await page.getByTestId('master-add').click();
    const sheet = page.getByTestId('record-sheet');
    await expect(sheet.getByTestId('form-item')).toBeVisible();
    await sheet.getByTestId('record-name').fill('J2 Steel plate 8 mm');
    await pickLookup(page, 'uom', /KG/);

    // Before a category: sub-category and group wait for their parent.
    await expect(page.getByTestId('field-sub_category-input-hint')).toContainText(/Category/);
    await expect(page.getByTestId('field-group-input-hint')).toContainText(/Sub-category/);

    await pickLookup(page, 'category', /Raw Materials/);
    expect((await lookupOptions(page, 'sub_category')).map(s => s.split(' ')[0]).sort()).toEqual(['D', 'E', 'F']);
    await pickLookup(page, 'sub_category', /Steel/);
    const groups = await lookupOptions(page, 'group');
    expect(groups.map(s => s.split(' ')[0]).sort()).toEqual(['G-D1', 'G-D2']);
    await pickLookup(page, 'group', /Steel bars/);
    const combo = (f: string) => page.getByTestId(`field-${f}-input`).getByRole('combobox');
    await expect(combo('sub_category')).toHaveValue(/Steel/);
    await expect(combo('group')).toHaveValue(/Steel bars/);

    // Category B: sub-category clears, and with it the group; only H is offered.
    await pickLookup(page, 'category', /Packaging/);
    await expect(combo('sub_category')).toHaveValue('');
    await expect(combo('group')).toHaveValue('');
    await expect(page.getByTestId('field-group-input-hint')).toBeAttached();
    expect((await lookupOptions(page, 'sub_category')).map(s => s.split(' ')[0])).toEqual(['H']);
    await pickLookup(page, 'sub_category', /Cartons/);
    expect((await lookupOptions(page, 'group')).map(s => s.split(' ')[0])).toEqual(['G-H1']);

    // Category C has no sub-categories: an empty state, not an error.
    await pickLookup(page, 'category', /Consumables/);
    const empty = await lookupEmptyText(page, 'sub_category');
    expect(empty).toMatch(/Category/i);
    expect(empty).not.toMatch(/error|failed/i);

    // Back to A → D → G-D1 for the saved record.
    await pickLookup(page, 'category', /Raw Materials/);
    await pickLookup(page, 'sub_category', /Steel/);
    await pickLookup(page, 'group', /Steel plates/);

    // Live formula.
    await page.getByTestId('field-std_rate-input').fill('200');
    await expect(page.getByTestId('field-landed_rate')).toContainText('210');
    await page.getByTestId('field-std_rate-input').fill('100');
    await expect(page.getByTestId('field-landed_rate')).toContainText('105');

    // Image upload + preview.
    await page.getByTestId('upload-input-photo').setInputFiles({ name: 'plate.png', mimeType: 'image/png', buffer: png(120, 80) });
    const preview = page.getByTestId('upload-photo').getByTestId('upload-item').locator('img');
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);

    await sheet.getByTestId('record-save').click();
    // Saved: the sheet switches to view mode with the generated code.
    await expect(sheet.getByTestId('record-code-value')).toHaveText(/^ITM-\d{5}$/, { timeout: 20_000 });
    await expect(sheet.getByTestId('field-group-value')).toContainText('Steel plates');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  await test.step('the list shows lookup labels and the thumbnail; the API agrees', async () => {
    const table = page.getByTestId('master-records-table');
    const row = table.getByRole('row').filter({ hasText: 'J2 Steel plate 8 mm' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Raw Materials');
    await expect(row).toContainText('Steel');
    await expect(row).toContainText('Steel plates');
    const thumb = row.locator('img');
    await expect(thumb).toBeVisible();
    await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);

    const rec = (await kit.records(admin.token, 'item', { q: 'J2 Steel plate' })).data[0];
    expect(rec.data).toMatchObject({ category: cat.A, sub_category: sub.D, landed_rate: '105.00' });
    expect(Number(rec.data.std_rate)).toBe(100);
    expect(rec.files[rec.data.photo]).toMatchObject({ mime: 'image/png', scanStatus: 'clean', width: 120, height: 80 });
  });

  await test.step('API: a sub-category from another category is rejected with 400 on that field', async () => {
    const uom = await kit.recordIds(admin.token, 'uom');
    const res = await kit.call('POST', '/masters/item/records', admin.token, {
      name: 'Bad cascade', data: { uom: uom.KG ?? Object.values(uom)[0], category: cat.B, sub_category: sub.D },
    });
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: { path: string }) => e.path)).toContain('sub_category');
    const res2 = await kit.call('POST', '/masters/item/records', admin.token, {
      name: 'Bad group', data: { uom: Object.values(uom)[0], category: cat.A, sub_category: sub.D, group: (await kit.recordIds(admin.token, 'item_group'))['G-H1'] },
    });
    expect(res2.status).toBe(400);
    expect(res2.body.errors.map((e: { path: string }) => e.path)).toContain('group');
  });
});

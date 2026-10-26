/**
 * Form versioning, master import and the formula editor, each on a fresh form-builder tenant (test-kit).
 *  - Versioning: a record saved on v1 still shows a field removed in v2; editing re-saves it under v2 and the removed
 *    field's data is kept (checked through the API).
 *  - Import: template download, a file with one bad row → dry-run report (row / field / message), nothing written;
 *    fixed file → commit creates the rows.
 *  - Formula editor: unknown field squiggle + suggestion, "test with sample values", and a cycle that blocks publish
 *    with the loop named.
 */
import { expect, kit, ownerApiToken, test, uniq } from './support/fixtures';
import { builderPublish, typeFormula } from './support/phase2';

async function freshTenant(prefix: string) {
  const owner = await ownerApiToken();
  return kit.builderTenant(owner, {}, { code: uniq(prefix).slice(0, 20) });
}

test('Form versioning: v1 record keeps its removed field; edit re-saves under v2 and keeps the data', async ({ page, ui }) => {
  const { tenant, admin } = await freshTenant('ver-');
  await kit.createMaster(admin.token, 'gauge', [
    { key: 'color', label: 'Colour', type: 'text' },
    { key: 'size', label: 'Size', type: 'text' },
  ]);
  const r1 = await kit.record(admin.token, 'gauge', { code: 'G1', name: 'Pressure gauge', data: { color: 'Red', size: 'L' } });
  const v1 = r1.formVersionId;

  await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');

  await test.step('remove "Size" in the builder and publish v2', async () => {
    await page.goto('/config/forms/gauge');
    await page.getByTestId('canvas-field-size').click();
    await page.getByTestId('canvas-del-size').click();
    await expect(page.getByTestId('canvas-field-size')).toHaveCount(0);
    await builderPublish(page, 'v2: drop size');
    const f = await kit.formFields(admin.token, 'gauge');
    expect(f.find(x => x.key === 'size')).toMatchObject({ removed: true });
  });

  await test.step('the v1 record still shows Size; a new record does not offer it', async () => {
    await page.goto('/masters/gauge');
    await page.getByTestId('master-records-table').getByRole('row').filter({ hasText: 'Pressure gauge' }).click();
    const sheet = page.getByTestId('record-sheet');
    await expect(sheet.getByTestId('field-size-value')).toHaveText('L');
    await expect(sheet.getByTestId('record-version-notice')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('master-add').click();
    await expect(page.getByTestId('record-sheet').getByTestId('field-color')).toBeVisible();
    await expect(page.getByTestId('record-sheet').getByTestId('field-size')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  await test.step('editing re-saves under v2; the removed field\'s data is kept', async () => {
    await page.getByTestId('master-records-table').getByRole('row').filter({ hasText: 'Pressure gauge' }).click();
    const sheet = page.getByTestId('record-sheet');
    await sheet.getByTestId('record-edit').click();
    await sheet.getByTestId('field-color-input').fill('Blue');
    await sheet.getByTestId('record-save').click();
    await expect(sheet.getByTestId('field-color-value')).toHaveText('Blue');
    const after = await kit.ok('GET', `/masters/gauge/records/${r1.id}`, admin.token);
    expect(after.formVersionId).not.toBe(v1);
    const versions = await kit.ok('GET', '/config/forms/gauge/versions', admin.token);
    const current = versions.find((v: { version: number }) => v.version === Math.max(...versions.map((x: { version: number }) => x.version)));
    expect(after.formVersionId).toBe(current.id);
    expect(after.data).toMatchObject({ color: 'Blue', size: 'L' });
  });
});

test('Import: template, dry run with one bad row writes nothing; fixed file commits', async ({ page, ui }) => {
  const { tenant, admin } = await freshTenant('imp-');
  await kit.createMaster(admin.token, 'part', [
    { key: 'qty', label: 'Quantity', type: 'number', min: 0, required: true },
    { key: 'uom', label: 'Unit', type: 'lookup', source: { kind: 'master', masterKey: 'uom' } },
  ]);
  await kit.record(admin.token, 'uom', { code: 'NOS', name: 'Numbers', data: { decimals: '0' } });

  await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
  await page.goto('/masters/part');
  await page.getByTestId('master-import').click();
  const d = page.getByTestId('import-dialog');

  await test.step('download the template', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), d.getByTestId('import-template').click()]);
    expect(dl.suggestedFilename()).toMatch(/part.*\.xlsx$/);
    const path = await dl.path();
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync(path!);
    expect(buf.subarray(0, 2).toString()).toBe('PK'); // an OOXML zip
  });

  const csv = (rows: string[]) => Buffer.from(['code,name,qty,uom', ...rows].join('\n'));

  await test.step('one bad row → report with row/field/message; nothing written', async () => {
    await d.getByTestId('import-file').setInputFiles({ name: 'parts.csv', mimeType: 'text/csv', buffer: csv(['P1,Bolt,10,NOS', 'P2,Nut,-4,NOS', 'P3,Washer,7,NOS']) });
    await d.getByTestId('import-check').click();
    const report = d.getByTestId('import-report');
    await expect(report).toBeVisible();
    const rows = report.getByTestId('import-error-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('3'); // spreadsheet row (header = 1)
    await expect(rows.first()).toContainText(/qty|Quantity/);
    await expect(d.getByTestId('import-commit')).toBeDisabled();
    expect((await kit.records(admin.token, 'part', { view: 'all' })).data).toHaveLength(0);
  });

  await test.step('fixed file → dry run clean → commit creates the rows', async () => {
    await d.getByTestId('import-back').click();
    await d.getByTestId('import-file').setInputFiles({ name: 'parts.csv', mimeType: 'text/csv', buffer: csv(['P1,Bolt,10,NOS', 'P2,Nut,4,NOS', 'P3,Washer,7,NOS']) });
    await d.getByTestId('import-check').click();
    await expect(d.getByTestId('import-report')).toBeVisible();
    await expect(d.getByTestId('import-error-row')).toHaveCount(0);
    expect((await kit.records(admin.token, 'part', { view: 'all' })).data).toHaveLength(0);
    await d.getByTestId('import-commit').click();
    await expect(d.getByTestId('import-report')).toContainText('3');
    await d.getByTestId('import-close').click();
    const rows = (await kit.records(admin.token, 'part', { view: 'all' })).data;
    expect(rows.map(r => r.code).sort()).toEqual(['P1', 'P2', 'P3']);
    const nos = (await kit.recordIds(admin.token, 'uom')).NOS;
    expect(rows.every(r => r.data.uom === nos)).toBe(true);
    await expect(page.getByTestId('master-records-table')).toContainText('Washer');
  });
});

test('Formula editor: squiggle + suggestion, sample values, and a cycle blocks publish naming the loop', async ({ page, ui }) => {
  const { tenant, admin } = await freshTenant('fx-');
  await kit.createMaster(admin.token, 'calc', [
    { key: 'qty', label: 'Qty', type: 'decimal' },
    { key: 'rate', label: 'Rate', type: 'currency' },
  ]);
  await ui.tenantLogin(tenant.code, tenant.adminEmail, 'NewAdmin@12345');
  await page.goto('/config/forms/calc');
  const props = page.getByTestId('builder-properties');

  await test.step('unknown field → squiggle and "did you mean"', async () => {
    await page.getByTestId('canvas-field-rate').click();
    await page.getByTestId('palette-formula').click();
    await props.getByTestId('prop-label').fill('Amount');
    await typeFormula(page, 'prop-expr', 'qtty * rate');
    const squiggle = props.locator('.cm-lintRange-error');
    await expect(squiggle.first()).toBeVisible();
    await expect(squiggle.first()).toHaveText('qtty');
    await expect(props.getByTestId('prop-expr-status')).toContainText(/qty/);
    await expect(page.getByTestId('builder-issues')).toContainText(/qtty/);
  });

  await test.step('fixed formula + "test with sample values"', async () => {
    await typeFormula(page, 'prop-expr', 'qty * rate');
    await expect(props.locator('.cm-lintRange-error')).toHaveCount(0);
    await props.getByTestId('prop-expr-test-toggle').click();
    const panel = props.getByTestId('formula-test-panel');
    await panel.getByLabel('qty').fill('3');
    await panel.getByLabel('rate').fill('12.5');
    await expect(panel.getByTestId('formula-test-result')).toContainText('37.5');
  });

  await test.step('a = b + 1, b = a + 1 → cycle issue naming the loop; publish is refused', async () => {
    await page.getByTestId('palette-formula').click();
    await props.getByTestId('prop-label').fill('a');
    await expect(props.getByTestId('prop-key')).toHaveValue('a');
    await typeFormula(page, 'prop-expr', 'b + 1');
    await page.getByTestId('palette-formula').click();
    await props.getByTestId('prop-label').fill('b');
    await expect(props.getByTestId('prop-key')).toHaveValue('b');
    await typeFormula(page, 'prop-expr', 'a + 1');
    const issues = page.getByTestId('builder-issues');
    await expect(issues.locator('[data-code="FORMULA_CYCLE"]').first()).toBeVisible();
    await expect(issues).toContainText(/a → b → a|b → a → b/);
    const publish = page.getByTestId('builder-publish');
    if (await publish.isEnabled()) {
      await publish.click();
      const dlg = page.getByTestId('publish-dialog');
      if (await dlg.isVisible()) {
        await dlg.getByTestId('publish-confirm').click();
        await expect(page.getByTestId('publish-error').or(dlg.getByTestId('publish-error'))).toContainText(/a → b → a|b → a → b|cycle|loop/i);
      }
    }
    const detail = await kit.ok('GET', '/config/forms/calc', admin.token);
    expect(detail.currentVersion).toBe(1);
    expect((detail.published.fields as { key: string }[]).some(f => f.key === 'a' || f.key === 'b')).toBe(false);
    // The server says the same.
    const v = await kit.ok('POST', '/config/forms/validate', admin.token, { definition: { fields: [
      { key: 'a', label: 'a', type: 'formula', expr: 'b + 1' }, { key: 'b', label: 'b', type: 'formula', expr: 'a + 1' },
    ] } });
    expect(v.issues.find((i: { code: string }) => i.code === 'FORMULA_CYCLE')?.message).toMatch(/a → b → a|b → a → b/);
  });
});

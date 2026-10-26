/**
 * J11 — audit log (desktop): filters (entity, entity id, action, dates) and the before/after diff of a document edit;
 * the tamper check runs clean on the freshly seeded database; a row tampered as the DB owner in a COPY of the
 * database is reported by the verifier (e2e/support/tamper-copy.mjs).
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, kit, test, Ui } from './support/fixtures';
import { ADMIN, apiCapex, login, seedIds } from './support/phase3';

test.describe.configure({ mode: 'serial' });

test('J11: audit filters + diff; tamper check clean; tampered row in a DB copy is reported', async ({ page }) => {
  test.setTimeout(150_000);
  const admin = await login(ADMIN);
  const i = await seedIds();
  const draft = await apiCapex(ADMIN, [{ qty: '2', est_rate: '100' }], { submit: false, purpose: 'J11 before' }) as { id: string; version: number; values: Record<string, unknown>; lines: { id: string; values: Record<string, unknown> }[] };
  await kit.ok('PUT', `/docs/capex/${draft.id}`, admin.token, {
    version: draft.version, values: { ...draft.values, purpose: 'J11 after', priority: 'Normal' },
    lines: draft.lines.map(l => ({ id: l.id, values: { ...l.values, qty: '3' } })),
  });
  void i;

  await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
  await test.step('filters narrow to the document; the diff shows the changed fields', async () => {
    await page.goto('/audit');
    await expect(page.getByTestId('audit-table')).toBeVisible();
    await page.getByTestId('audit-filter-entity').fill('document');
    await page.getByTestId('audit-filter-entity-id').fill(draft.id);
    const rows = page.getByTestId('audit-table').locator('[role="rowgroup"] [role="row"][data-index]');
    await expect(rows).toHaveCount(2); // create + update
    await page.getByTestId('audit-filter-action').fill('update');
    await expect(rows).toHaveCount(1);
    await rows.first().click();
    const detail = page.getByTestId('audit-detail');
    await expect(detail).toBeVisible();
    const diff = detail.getByTestId('audit-diff');
    await expect(diff).toBeVisible();
    await expect(diff.getByTestId('audit-diff-key-values.purpose')).toHaveAttribute('data-change', 'changed');
    await expect(diff.getByTestId('audit-diff-key-values.purpose')).toContainText('J11 after');
    await expect(diff).toContainText('J11 before');
    await page.keyboard.press('Escape');
    // a date range in the future empties the list
    await page.getByTestId('audit-filter-from').fill('2099-01-01');
    await expect(rows.filter({ hasText: 'update' })).toHaveCount(0);
    await page.getByTestId('audit-filter-clear').click();
    await expect(page.getByTestId('audit-filter-entity')).toHaveValue('');
  });

  await test.step('tamper check (run now) is clean on the seeded database', async () => {
    const panel = page.getByTestId('audit-tamper');
    await panel.getByTestId('audit-run-check').click();
    await expect(panel.getByTestId('audit-check-result')).toHaveAttribute('data-ok', 'true', { timeout: 20_000 });
    await expect(panel.getByTestId('audit-check-row').first()).toHaveAttribute('data-ok', 'true');
    const checks = await kit.ok('GET', '/audit/checks', admin.token) as { ok: boolean; rowsChecked: number }[];
    expect(checks[0]).toMatchObject({ ok: true });
    expect(checks[0]!.rowsChecked).toBeGreaterThan(10);
  });

  await test.step('a row tampered in a copy of the database is reported by the verifier', async () => {
    const out = execFileSync('node', [resolve(__dirname, 'support/tamper-copy.mjs'), 'acme'], { env: process.env, timeout: 120_000 }).toString().trim().split('\n').pop()!;
    const r = JSON.parse(out) as { tamperedId: string; before: { ok: boolean }; after: { ok: boolean; firstBadId: string; detail: string } };
    expect(r.before.ok).toBe(true);
    expect(r.after).toMatchObject({ ok: false, firstBadId: r.tamperedId });
    expect(r.after.detail).toMatch(/changed after it was written/);
  });
});

/**
 * axe-core (WCAG 2.0/2.1 A + AA, serious + critical only) on the Phase 3 screens (desktop): workflow designer (with a
 * stage selected and the simulation drawer open), document list (document- and item-wise), approval screen, inbox,
 * document detail. The mobile approval screen is in mobile-phase3.spec.ts.
 */
import { a11yViolations, expect, test, Ui } from './support/fixtures';
import { ADMIN, APPROVER, apiCapex, INDENTER } from './support/phase3';

test('a11y: workflow designer — stage panel and simulation drawer', async ({ page }) => {
  await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
  await page.goto('/config/workflows/capex');
  await page.getByTestId('wf-stage-finance-open').click();
  await expect(page.getByTestId('wf-stage-panel')).toHaveAttribute('data-stage', 'finance');
  expect(await a11yViolations(page), 'designer + stage panel').toEqual([]);
  await page.getByTestId('wf-simulate').click();
  await expect(page.getByTestId('wf-sim-drawer')).toBeVisible();
  expect(await a11yViolations(page), 'simulation drawer').toEqual([]);
});

test('a11y: document detail', async ({ page }) => {
  const doc = await apiCapex(INDENTER, [{ qty: '2', est_rate: '100' }, { qty: '1', est_rate: '50' }], { purpose: 'a11y detail' }) as { id: string };
  await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
  await page.goto(`/docs/capex/${doc.id}`);
  await expect(page.getByTestId('doc-number')).toBeVisible();
  expect(await a11yViolations(page), 'detail').toEqual([]);
  await page.getByTestId('doc-tab-timeline').click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  expect(await a11yViolations(page), 'timeline tab').toEqual([]);
});

// QA3-BUG-016 (fixed): document list column headers were <button aria-sort=…> — aria-sort is only allowed on
// columnheader/rowheader roles (axe critical `aria-allowed-attr`). It now sits on the sorted column's header cell.
test('[QA3-BUG-016] a11y: document list (document-wise and item-wise)', async ({ page }) => {
  await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
  await page.goto('/docs/capex');
  await expect(page.getByTestId('doc-list')).toBeVisible();
  await expect(page.getByTestId('doc-status-chips')).toBeVisible();
  expect(await a11yViolations(page), 'document-wise').toEqual([]);
  await page.getByTestId('sort-doc_date').click();
  await expect(page.getByRole('columnheader', { name: /Sort by/ }).and(page.locator('[aria-sort="ascending"]'))).toHaveCount(1);
  expect(await a11yViolations(page), 'document-wise, sorted').toEqual([]);
  await page.goto('/docs/capex?view=item');
  await expect(page.getByTestId('doc-list')).toBeVisible();
  expect(await a11yViolations(page), 'item-wise').toEqual([]);
});

test('a11y: document list apart from the sort headers (QA3-BUG-016 excluded) has no other serious/critical issue', async ({ page }) => {
  await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
  for (const url of ['/docs/capex', '/docs/capex?view=item']) {
    await page.goto(url);
    await expect(page.getByTestId('doc-list')).toBeVisible();
    const v = (await a11yViolations(page)).filter(x => !(x.id === 'aria-allowed-attr' && x.nodes.every(n => /Sort by|flex-row-reverse/.test(n))));
    expect(v, url).toEqual([]);
  }
});

test('a11y: approval screen and inbox (approver)', async ({ page }) => {
  const doc = await apiCapex(INDENTER, [{ qty: '4', est_rate: '100' }, { qty: '2', est_rate: '100' }], { purpose: 'a11y approve' }) as { id: string };
  await new Ui(page).tenantLogin('acme', APPROVER.email, APPROVER.password);
  await page.goto('/approvals');
  await expect(page.getByTestId('inbox-list')).toBeVisible();
  expect(await a11yViolations(page), 'inbox').toEqual([]);
  await page.goto(`/docs/capex/${doc.id}/approve?stage=hod`);
  await expect(page.getByTestId('approve-screen')).toBeVisible();
  await page.getByTestId('decision-2-set-hold').click();
  await page.getByTestId('decision-submit').click(); // reason missing → errors shown
  await expect(page.getByTestId('decision-errors')).toBeVisible();
  expect(await a11yViolations(page), 'approval screen with errors').toEqual([]);
});

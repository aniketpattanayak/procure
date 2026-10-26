/**
 * Pixel 7: the approver decides a 3-line request on the phone (approve, hold with reason, reduce with reason),
 * releases the held line from the held panel, and the inbox + approval screen have no serious/critical axe issues and
 * no horizontal scroll.
 */
import { a11yViolations, expect, kit, test, Ui } from './support/fixtures';
import { ADMIN, APPROVER, apiCapex, INDENTER, ledger, login } from './support/phase3';

const noHScroll = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('Mobile: approval screen — approve, hold, reduce on a phone; inbox; axe', async ({ page }) => {
  const doc = await apiCapex(INDENTER, [{ qty: '10', est_rate: '100' }, { qty: '5', est_rate: '100' }, { qty: '8', est_rate: '100' }], { purpose: 'Mobile approvals' }) as { id: string; number: string };
  const ui = new Ui(page);
  await ui.tenantLogin('acme', APPROVER.email, APPROVER.password);
  await ui.nav('nav-approvals');
  await expect(page.getByTestId('inbox-list')).toBeVisible();
  expect(await noHScroll(page), 'inbox has no horizontal scroll').toBe(true);
  expect(await a11yViolations(page), 'inbox (mobile)').toEqual([]);
  await page.getByTestId(`inbox-row-${doc.number}`).click();
  await expect(page.getByTestId('approve-screen')).toHaveAttribute('data-stage', 'hod');
  expect(await noHScroll(page), 'approval screen has no horizontal scroll').toBe(true);
  expect(await a11yViolations(page), 'approval screen (mobile)').toEqual([]);
  await page.getByTestId('decision-1-set-approve').click();
  await page.getByTestId('decision-2-set-hold').click();
  await page.getByTestId('decision-2-reason').fill('Waiting for the quote');
  await page.getByTestId('decision-3-approve').fill('6');
  await page.getByTestId('decision-3-reason').fill('Two are enough for now');
  await expect(page.getByTestId('decision-row-3')).toHaveAttribute('data-outcome', /reduce|mixed/);
  await page.getByTestId('decision-submit').click();
  await expect(page.getByTestId('unhold-panel')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('unhold-2').click();
  await expect(page.getByTestId('decision-row-2')).toBeVisible();
  await page.getByTestId('decision-2-set-approve').click();
  await page.getByTestId('decision-submit').click();
  await page.waitForURL(new RegExp(`/docs/capex/${doc.id}$`));
  const L = await ledger(doc.id);
  expect(L.map(l => [Number(l.approved), Number(l.rejected), Number(l.held)])).toEqual([[10, 0, 0], [5, 0, 0], [6, 2, 0]]);
  const row = await kit.ok('GET', `/docs/capex/${doc.id}`, (await login(ADMIN)).token) as { statusKey: string };
  expect(row.statusKey).toBe('partially_approved');
});

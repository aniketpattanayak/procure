/**
 * QA Phase 5 (Pixel 7): every /stock screen and every Phase 5 document list loads on a phone without page-level
 * horizontal scroll, console errors or failing API calls; axe has no serious/critical issue on balances, ledger and
 * the count sheet. QA5-BUG-009 (fixed): the count sheet's "Counted" input sat off-screen inside the table's
 * horizontal scroller; below md the lines are now stacked cards.
 */
import { SEED } from './support/env';
import { a11yViolations, expect, kit, test, Ui } from './support/fixtures';

const noHScroll = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function countSheet(): Promise<{ id: string }> {
  const token = (await kit.tenantLogin(SEED.acme.code, SEED.acme.email, SEED.acme.password)).token;
  const bal = await kit.ok<{ data: { node: { id: string } }[] }>('GET', '/stock/balances?limit=1', token);
  return kit.ok<{ id: string }>('POST', '/stock/counts/snapshot', token, { nodeId: bal.data[0]!.node.id, includeChildren: false });
}

test('Mobile: all stock screens load cleanly on a phone', async ({ page }) => {
  const count = await countSheet();
  const ui = new Ui(page);
  await ui.tenantLogin(SEED.acme.code, SEED.acme.email, SEED.acme.password);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console ${m.text()}`); });
  page.on('response', r => { if (r.url().includes('/api/v1/') && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  const routes = ['/stock', '/stock/ledger', '/stock/receive', '/stock/issue', '/stock/return', '/stock/rtv', '/stock/reorder', '/stock/opening', `/stock/count/${count.id}`,
    '/docs/grn', '/docs/rtv', '/docs/stock_transfer', '/docs/stock_adjustment', '/docs/stock_count', '/docs/issue_request', '/docs/store_issue', '/docs/store_return'];
  for (const r of routes) {
    await page.goto(r);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });
    expect(await noHScroll(page), `${r} has no horizontal page scroll`).toBe(true);
  }
  expect(errors).toEqual([]);
  for (const r of ['/stock', '/stock/ledger', `/stock/count/${count.id}`]) {
    await page.goto(r);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 30_000 });
    expect(await a11yViolations(page), `${r} (mobile)`).toEqual([]);
  }
});

test('QA5-BUG-009 (fixed) Mobile: the count sheet shows the Counted input without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // iPhone 12–15 width; Pixel 7 (412 px) just fits
  const count = await countSheet();
  const ui = new Ui(page);
  await ui.tenantLogin(SEED.acme.code, SEED.acme.email, SEED.acme.password);
  await page.goto(`/stock/count/${count.id}`);
  const input = page.getByTestId('count-qty-1');
  await expect(input).toBeAttached({ timeout: 30_000 });
  const box = await input.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box && box.x >= 0 && box.x + box.width <= width, `counted input right edge ${box ? box.x + box.width : '?'} ≤ ${width}`).toBe(true);
  expect(await noHScroll(page)).toBe(true);
  // Typing into it works and the difference shows on the same card.
  await input.fill('1');
  await expect(page.getByTestId('count-diff-1')).toBeVisible();
});

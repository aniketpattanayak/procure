/**
 * QA47 browser smoke for Phases 4 / 6 / 7 (acme seed, desktop):
 *   J-P: create an indent in the UI → (approve) → log a vendor quote in the UI → comparison sheet → vendor selection
 *        in the UI → (approve) → create the PO from the order page → submit → (approve) → Print / PDF → email preview.
 *   J-R: build + save a report in the builder → run it → add it as a table widget to a new dashboard → view it.
 * Approvals (workflow UI is Phase 3's journey) go through the API to keep this a short smoke.
 */
import type { Page } from '@playwright/test';
import { API_ORIGIN, SEED } from './support/env';
import { expect, test } from './support/fixtures';
import { pickLookup } from './support/phase2';
import { pickItem } from './support/phase3';

const API = `${API_ORIGIN}/api/v1`;

async function token() {
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantCode: 'acme', email: SEED.acme.email, password: SEED.acme.password }) });
  return ((await r.json()) as { accessToken: string }).accessToken;
}
async function call<T = any>(tok: string, method: string, path: string, body?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j as T;
}
/** Approves every pending line at the doc's current stage. */
async function approveAll(adminTok: string, type: string, id: string, stageKey: string) {
  const tok = await approverToken(adminTok);
  const d = await call(tok, 'GET', `/docs/${type}/${id}`);
  const decisions = d.lines.filter((l: { qty: { pendingApproval: string } }) => Number(l.qty.pendingApproval) > 0)
    .map((l: { id: string; qty: { pendingApproval: string } }) => ({ lineId: l.id, approve: l.qty.pendingApproval }));
  return call(tok, 'POST', `/docs/${type}/${id}/actions`, { action: 'decide', stageKey, decisions });
}
/** A second tenant admin (approvals of documents the seeded admin raised: self-approval is refused). */
let approverTok: string | null = null;
async function approverToken(adminTok: string) {
  if (approverTok) return approverTok;
  const email = `qa47-approver-${Date.now()}@acme.test`;
  const u = await call(adminTok, 'POST', '/users', { name: 'QA47 Approver', email, isTenantAdmin: true });
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantCode: 'acme', email, password: u.temporaryPassword }) });
  const first = ((await r.json()) as { accessToken: string }).accessToken;
  const ch = await call(first, 'POST', '/auth/password/change', { currentPassword: u.temporaryPassword, newPassword: 'Qa47Appr@12345' });
  approverTok = ch.accessToken as string;
  return approverTok;
}
const docIdFromUrl = (page: Page) => /\/docs\/\w+\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

test('J-P: indent → quote → compare → select → PO → PDF + email preview', async ({ page, ui }) => {
  const tok = await token();
  await ui.tenantLogin('acme', SEED.acme.email, SEED.acme.password);

  // 1. indent in the UI
  await page.goto('/docs/indent/new');
  await expect(page.getByTestId('doc-form')).toBeVisible({ timeout: 120_000 });
  await pickLookup(page, 'location', /Pune Plant/);
  const dep = page.getByTestId('field-department-input').getByRole('combobox');
  if (await dep.count()) {
    await dep.click();
    const opts = page.getByTestId('field-department-input-options');
    if (await opts.getByRole('option').count()) await opts.getByRole('option').first().click();
    else await page.keyboard.press('Escape');
  }
  await page.getByTestId('field-purpose-input').fill('QA47 smoke');
  await pickItem(page, 0, /.+/);
  await page.getByTestId('field-lines-0-qty-input').fill('120');
  await page.getByTestId('doc-submit').click();
  await page.waitForURL(/\/docs\/indent\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const indentId = docIdFromUrl(page);
  const indent = await call(tok, 'GET', `/docs/indent/${indentId}`);
  expect(indent.number).toMatch(/^IND\//);
  await approveAll(tok, 'indent', indentId, 'verify');

  // 2. vendor quote in the UI (quotes tab of the line) + comparison sheet
  const lineId = indent.lines[0].id as string;
  await page.goto(`/docs/indent/${indentId}?tab=quotes&line=${lineId}`);
  await page.getByTestId('quote-add').click();
  const form = page.getByTestId('quote-form');
  await expect(form).toBeVisible();
  const vendor = form.getByTestId('quote-vendor').getByRole('combobox');
  await vendor.click();
  await page.getByRole('option').first().click();
  await form.getByTestId('quote-rate').fill('52.5');
  await form.getByTestId('quote-tax').fill('18');
  await form.getByTestId('quote-save').click();
  await expect(form).toBeHidden({ timeout: 30_000 });
  const quotes = await call(tok, 'GET', `/procurement/indent-lines/${lineId}/quotes`);
  expect(quotes).toHaveLength(1);
  expect(quotes[0].quotedRate).toBe('52.5');
  const sheet = await call(tok, 'GET', `/procurement/indent-lines/${lineId}/comparison`);
  expect(sheet.vendors[0].isBest).toBe(true);

  // 3. vendor selection in the UI
  await page.goto(`/procurement/select?q=${encodeURIComponent(indent.number)}`);
  const k = `${indent.number}-1`;
  await page.getByTestId('select-search').fill(indent.number);
  await page.getByTestId(`select-pick-${k}`).click();
  const vsel = page.getByTestId(`select-vendor-${k}-0`).getByRole('combobox');
  if (!(await vsel.inputValue().catch(() => ''))) { // the quoted (best) vendor is pre-filled
    await vsel.click();
    await page.getByRole('listbox').getByRole('option').first().click();
  }
  await page.getByTestId(`select-qty-${k}-0`).fill('120');
  const rate = page.getByTestId(`select-rate-${k}-0`);
  if (!(await rate.inputValue())) await rate.fill('52.5');
  await page.getByTestId('select-submit').click();
  await page.waitForURL(/\/docs\/vendor_selection\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const selId = docIdFromUrl(page);
  const approvedSel = await approveAll(tok, 'vendor_selection', selId, 'approve');
  expect(approvedSel.statusKey).toBe('approved');

  // 4. PO from the order page
  await page.goto('/procurement/order');
  await page.getByTestId('order-search').fill(approvedSel.number);
  const pick = page.locator('[data-testid^="order-pick-"]').first();
  await pick.click();
  await page.getByTestId('order-create').click();
  await expect(page.getByTestId('order-created')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('order-created-0').click();
  await page.waitForURL(/\/docs\/po\/[0-9a-f-]{36}/);
  const poId = docIdFromUrl(page);
  const po = await call(tok, 'GET', `/docs/po/${poId}`);
  expect(po.values.cgst_amount ?? po.values.igst_amount).toBeTruthy();
  await page.getByTestId('doc-submit').click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: /^Submit$/ });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect.poll(async () => (await call(tok, 'GET', `/docs/po/${poId}`)).statusKey, { timeout: 30_000 }).not.toBe('draft');
  const approvedPo = await approveAll(tok, 'po', poId, 'approve');
  expect(approvedPo.statusKey).toBe('approved');

  // 5. Print / PDF + email preview
  await page.reload();
  await page.getByTestId('print-button').click();
  await expect(page.getByTestId('print-dialog')).toBeVisible();
  const pdfResp = page.waitForResponse(r => /\/pdf-jobs\/|\/print$/.test(r.url()) && r.status() === 200, { timeout: 60_000 });
  await page.getByTestId('print-generate').click();
  await pdfResp;
  await expect(page.getByTestId('print-error')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('send-button').click();
  const email = page.getByTestId('send-menu-email');
  if (await email.count()) await email.click();
  await expect(page.getByTestId('send-dialog')).toBeVisible();
  await expect(page.getByTestId('send-preview')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('send-dialog')).toContainText(approvedPo.number);
});

test('J-R: build + run a report, then put it on a new dashboard', async ({ page, ui }) => {
  const tok = await token();
  await ui.tenantLogin('acme', SEED.acme.email, SEED.acme.password);
  await page.goto('/reports/new');
  await expect(page.getByTestId('report-builder')).toBeVisible({ timeout: 120_000 });
  const src = page.getByTestId('builder-source');
  const values = await src.locator('option').evaluateAll(os => os.map(o => (o as HTMLOptionElement).value));
  const docPo = values.find(v => /doc[:.]po$|^doc:po/.test(v)) ?? values.find(v => v.includes('po')) ?? values[1]!;
  await src.selectOption(docPo);
  const addColumn = async (id: string) => {
    await page.getByTestId(`builder-add-${id}`).click();
    await page.getByRole('menuitem', { name: /Add as column/i }).click();
  };
  await addColumn('number');
  if (await page.getByTestId('builder-add-location.name').count()) await addColumn('location.name');
  await expect(page.getByTestId('builder-preview')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('builder-save').click();
  const name = `QA47 POs ${Date.now() % 100000}`;
  await page.getByTestId('builder-save-name').fill(name);
  const key = page.getByTestId('builder-save-key');
  if (await key.count() && !(await key.inputValue())) await key.fill(`qa47_${Date.now() % 100000}`);
  await page.getByTestId('builder-save-confirm').click();
  await page.waitForURL(/\/reports\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const reportId = /\/reports\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const run = page.getByTestId('report-run');
  if (await run.count()) await run.click();
  await expect(page.getByTestId('report-row-count')).toBeVisible({ timeout: 30_000 });
  const res = await call(tok, 'POST', `/reports/${reportId}/run`, {});
  expect(res.rows.length).toBeGreaterThan(0);

  await page.goto('/dashboard/design');
  await expect(page.getByTestId('dash-designer')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('dash-name-input').or(page.getByLabel(/name/i).first()).first().fill(`QA47 dash ${Date.now() % 100000}`);
  await page.getByTestId('dash-add').click();
  await page.getByTestId('dash-add-table').click();
  await page.getByTestId('widget-report').selectOption(reportId);
  await page.getByTestId('dash-add').click();
  await page.getByTestId('dash-add-doc_counts').click();
  const dt = page.getByTestId('widget-doctype');
  if (await dt.count()) await dt.selectOption('po');
  await page.getByTestId('dash-save').click();
  await expect.poll(async () => (await call(tok, 'GET', '/dashboards')).some((d: { name: string }) => d.name.startsWith('QA47 dash')), { timeout: 30_000 }).toBe(true);
  const dash = (await call(tok, 'GET', '/dashboards')).find((d: { name: string }) => d.name.startsWith('QA47 dash'));
  await page.goto(`/dashboard?id=${dash.id}`);
  const picker = page.getByTestId('dash-picker');
  if (await picker.count()) await picker.selectOption(dash.id).catch(() => undefined);
  await expect(page.locator('[data-testid^="widget-"]').first()).toBeVisible({ timeout: 60_000 });
  const table = await call(tok, 'POST', `/dashboards/widgets/${dash.widgets.find((w: { type: string }) => w.type === 'table').id}/data`, { dashboardId: dash.id });
  expect(table.rows.length).toBeGreaterThan(0);
});

/**
 * J1 — Super Admin onboards a tenant end to end:
 * login → create plan → create tenant via wizard (capture the one-time temp password) → max_users override with
 * reason + history → tenant admin logs in with the temp password → forced password change → tenant app whose
 * sidebar is permission-driven (Phase 3) with plan-gated configuration entries.
 */
import { a11yViolations, expect, kit, ownerApiToken, test, Ui, uniq } from './support/fixtures';

const PLAN_FEATURES = ['indent', 'grn']; // deliberately not purchase/store/reports/vendor_quotes
const ALL_MODULES = ['indent', 'vendor_quotes', 'purchase', 'grn', 'store', 'reports'];
const NEW_PASSWORD = 'Onboard@12345';

test.describe.configure({ mode: 'serial' });

test('J1: plan → tenant wizard → override → first login → forced change → plan-gated sidebar', async ({ page, ui, browser }) => {
  const planName = uniq('QA Plan ');
  const planCode = uniq('qa-').toLowerCase();
  const tenantCode = uniq('j1-').toLowerCase().slice(0, 20);
  const tenantName = `J1 Co ${tenantCode}`;
  const adminEmail = `admin@${tenantCode}.test`;

  await test.step('Super Admin logs in', async () => {
    await ui.platformLogin();
    await expect(page.getByTestId('tenants-table')).toBeVisible();
  });

  await test.step('creates a plan (2 modules, max_users 5)', async () => {
    await ui.nav('nav-platform-plans');
    await page.getByTestId('create-plan-button').click();
    const f = page.getByTestId('plan-form');
    await f.getByTestId('plan-name').fill(planName);
    await f.getByTestId('plan-code').fill(planCode);
    await f.getByTestId('plan-price').fill('2500');
    for (const k of PLAN_FEATURES) await f.getByTestId(`plan-feature-${k}`).click();
    await f.getByTestId('plan-limit-max_users-value').fill('5');
    await f.getByTestId('plan-save').click();
    await page.waitForURL(/\/platform\/plans$/);
    await expect(page.getByTestId('plans-table')).toContainText(planName);
  });

  let tempPassword = '';
  let tenantId = '';
  await test.step('creates a tenant on it via the wizard and captures the temp password', async () => {
    await ui.nav('nav-platform-tenants');
    await page.getByTestId('create-tenant-button').click();
    const w = page.getByTestId('create-tenant-wizard');
    await w.getByTestId('tenant-code').fill(tenantCode);
    await w.getByTestId('tenant-name').fill(tenantName);
    await w.getByTestId('wizard-next').click();
    const opt = w.getByTestId('tenant-plan').locator('option', { hasText: planName });
    await expect(opt).toHaveCount(1);
    await w.getByTestId('tenant-plan').selectOption((await opt.getAttribute('value'))!);
    await w.getByTestId('tenant-sub-status').selectOption('active');
    await w.getByTestId('wizard-next').click();
    await w.getByTestId('tenant-admin-name').fill('J1 Admin');
    await w.getByTestId('tenant-admin-email').fill(adminEmail);
    await w.getByTestId('wizard-next').click();
    await expect(w).toContainText(tenantCode);
    await expect(w).toContainText(planName);
    await w.getByTestId('wizard-submit').click();

    const secret = page.getByTestId('temp-password');
    await expect(secret).toBeVisible();
    tempPassword = (await secret.textContent())!.trim();
    expect(tempPassword).toHaveLength(16);
    await page.getByTestId('wizard-open-tenant').click();
    await page.waitForURL(/\/platform\/tenants\/[0-9a-f-]{36}$/);
    tenantId = page.url().split('/').pop()!;
  });

  await test.step('sets a max_users override with a reason and sees it in override history', async () => {
    await expect(page.getByTestId('limit-row-max_users')).toContainText('5');
    await page.getByTestId('override-edit-max_users').click();
    const ed = page.getByTestId('override-editor');
    await expect(ed).toBeVisible();
    await ed.getByTestId('override-value').fill('8');
    await ed.getByTestId('override-reason').fill('J1 pilot uplift');
    await ed.getByTestId('override-save').click();
    await expect(ed).toBeHidden();
    await expect(page.getByTestId('limit-row-max_users')).toContainText('8');

    await page.getByRole('tab', { name: 'Override history' }).click();
    const hist = page.getByTestId('override-history');
    await expect(hist).toContainText('J1 pilot uplift');
    await expect(hist).toContainText('8');

    // a11y: tenant detail (entitlements tab) — checked on the history tab too since both are on this page.
    expect(await a11yViolations(page)).toEqual([]);
  });

  await test.step('server agrees: effective max_users is the override', async () => {
    const owner = await ownerApiToken();
    const r = await kit.t('GET', `/platform/tenants/${tenantId}`, { token: owner });
    const l = r.body.entitlements.limits.find((x: { key: string }) => x.key === 'max_users');
    expect(l).toMatchObject({ planValue: 5, override: 8, effective: 8 });
    const h = await kit.t('GET', `/platform/tenants/${tenantId}/overrides/history`, { token: owner });
    expect(h.body[0]).toMatchObject({ key: 'max_users', newValue: 8, reason: 'J1 pilot uplift' });
  });

  // The tenant admin uses a separate browser context (separate cookies), like a different person.
  const ctx = await browser.newContext();
  const tp = await ctx.newPage();
  const tui = new Ui(tp);

  await test.step('tenant admin logs in with the temp password and is forced to change it', async () => {
    await tui.fillTenantLogin(tenantCode, adminEmail, tempPassword);
    await tp.waitForURL(/\/change-password/);
    await expect(tp.getByTestId('change-password-form')).toBeVisible();
    // Going elsewhere first still lands on change-password (server says PASSWORD_CHANGE_REQUIRED).
    await tp.goto('/users');
    await tp.waitForURL(/\/change-password/);
    await tui.changePassword(tempPassword, NEW_PASSWORD);
    await tp.waitForURL(/\/dashboard/);
  });

  await test.step('lands in the tenant app; sidebar shows permission-driven modules; config entries are plan-gated', async () => {
    await expect(tp.locator('aside')).toBeVisible();
    const entries = await tui.sidebarEntries();
    // Phase 3: the Phase 1 plan-feature placeholders (`nav-m-<feature>`) are gone; the Modules group is permission
    // driven — the approvals inbox plus one `nav-docs-<key>` per document type the user can view (a new tenant has
    // none yet). Plan gating now shows on the Phase 3 configuration entries: document types need `form_builder`,
    // the workflow designer needs `workflow_designer`, and this plan has neither.
    for (const m of ALL_MODULES) expect(entries, `placeholder for ${m} must be gone`).not.toContain(`nav-m-${m}`);
    // document types: only system types of the plan's modules (Phase 4 provisions e.g. `indent`), never others
    for (const e of entries.filter(x => x.startsWith('nav-docs-'))) expect(PLAN_FEATURES, `${e} must come from a plan module`).toContain(e.slice('nav-docs-'.length));
    expect(entries).toContain('nav-approvals');
    expect(PLAN_FEATURES).not.toContain('form_builder');
    expect(entries).not.toContain('nav-config-doc-types');
    expect(entries).not.toContain('nav-config-workflows');
    expect(entries).toEqual(expect.arrayContaining(['nav-dashboard', 'nav-users', 'nav-roles', 'nav-usage', 'nav-audit']));
    // Old temp password no longer works.
    const again = await kit.t('POST', '/auth/login', { body: { tenantCode, email: adminEmail, password: tempPassword } });
    expect(again.body.code).toBe('AUTH.INVALID_CREDENTIALS');
  });

  await ctx.close();
});

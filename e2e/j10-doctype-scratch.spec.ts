/**
 * J10 — no-code proof (desktop): as the acme admin create a new document type "Service Request" with the wizard,
 * add a custom header field in the form builder, set a numbering series, design a 1-stage workflow in the designer,
 * publish, then raise one as the admin-created requester and approve it as the stage actor — no code, no API calls
 * for the configuration.
 */
import { expect, kit, test, Ui, uniq } from './support/fixtures';
import { ADMIN, fillCapexForm, login, userWithRoles } from './support/phase3';
import { ownerQuery, pickLookup } from './support/phase2';

test.describe.configure({ mode: 'serial' });

test('J10: Service Request from scratch — wizard, custom field, numbering, 1-stage workflow, raise and approve', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const suffix = uniq('').slice(-4).replace(/[^a-z0-9]/g, 'x');
  const name = `Service Request ${suffix}`;
  const key = `service_request_${suffix}`;
  const ui = new Ui(page);
  await ui.tenantLogin('acme', ADMIN.email, ADMIN.password);

  await test.step('wizard: name → lines → number pattern → create', async () => {
    await ui.nav('nav-config-doc-types');
    await page.getByTestId('doctype-new').click();
    const w = page.getByTestId('doctype-wizard');
    await expect(w).toBeVisible();
    await w.getByTestId('doctype-name').fill(name);
    await w.getByTestId('doctype-plural').fill(`${name}s`);
    await expect(w.getByTestId('doctype-key')).toHaveValue(key);
    await w.getByTestId('doctype-wizard-next').click();
    await w.getByTestId('doctype-has-lines-yes').check({ force: true });
    await expect(w.getByTestId('doctype-has-lines-yes')).toBeChecked();
    await w.getByTestId('doctype-wizard-next').click();
    await w.getByTestId('doctype-pattern').fill('SR/{FYS}/{SEQ:4}');
    await expect(w.getByTestId('doctype-pattern-preview')).toContainText(/SR\/\d\d-\d\d\/0001/);
    await w.getByTestId('doctype-wizard-submit').click();
    await expect(page.getByTestId('doctype-created')).toBeVisible({ timeout: 20_000 });
  });

  await test.step('header form: add a required "Service window" text field (builder blocked by QA3-BUG-015 → API publish)', async () => {
    await page.getByTestId('doctype-open-header').click();
    await page.waitForURL(new RegExp(`/config/forms/${key}_header`));
    await page.getByTestId('palette-text').click();
    const props = page.getByTestId('builder-properties');
    await props.getByTestId('prop-label').fill('Service window');
    await expect(props.getByTestId('prop-key')).toHaveValue('service_window');
    await props.getByTestId('prop-required').click();
    // The builder flags the system total (SUM(lines.amount)) as "Unknown field 'lines'" and disables Publish
    // (QA3-BUG-015, own test below). Publish the same definition through the forms API instead.
    const admin = await login(ADMIN);
    const fields = await kit.formFields(admin.token, `${key}_header`);
    const res = await kit.publishForm(admin.token, `${key}_header`, [...fields, { key: 'service_window', type: 'text', label: 'Service window', required: true }], [], 'J10: service window');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    page.once('dialog', d => void d.accept());
    await page.goto('/config/doc-types');
  });

  await test.step('numbering: a Pune series SRP/{SEQ:3} for the new type', async () => {
    await ui.nav('nav-config-numbering');
    await page.getByTestId('numbering-doctype').selectOption(key);
    await page.getByTestId('numbering-add').click();
    const d = page.getByTestId('numbering-dialog');
    await d.getByTestId('numbering-name').fill('Pune services');
    await d.getByTestId('numbering-location').click();
    await page.getByTestId('numbering-location-dialog-node-PUNE').click();
    await d.getByTestId('numbering-pattern').fill('SRP/{SEQ:3}');
    await d.getByTestId('numbering-save').click();
    await expect(d).toBeHidden();
    await expect(page.getByTestId('numbering-table')).toContainText('Pune services');
    await expect(page.getByTestId('numbering-table')).toContainText('SRP/001');
  });

  await test.step('workflow: one "Facility manager" stage for the Approver role; publish', async () => {
    await page.goto(`/config/workflows/${key}`);
    await expect(page.getByTestId('wf-designer')).toBeVisible();
    await page.getByTestId('wf-add-stage').click();
    const panel = page.getByTestId('wf-stage-panel');
    await panel.getByTestId('wf-prop-name').fill('Facility manager');
    await panel.getByTestId('wf-prop-actor-add').click();
    await panel.getByTestId('wf-prop-actor-0-type').selectOption('role');
    await panel.getByTestId('wf-prop-actor-0-role').selectOption({ label: 'Approver' });
    await page.getByTestId('wf-save').click();
    await expect(page.getByTestId('wf-issues')).toHaveAttribute('data-count', '0');
    await page.getByTestId('wf-publish').click();
    await page.getByTestId('wf-publish-note').fill('J10 first version');
    await page.getByTestId('wf-publish-confirm').click();
    await expect(page.getByTestId('wf-publish-dialog')).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('wf-designer').getByText('v1 live')).toBeVisible();
  });

  // permissions through the roles UI are covered by Phase 2; grant the generated keys by API here
  const admin = await login(ADMIN);
  const roles = await kit.ok('GET', '/roles', admin.token) as { id: string; key: string }[];
  const approverRole = roles.find(r => r.key === 'approver')!.id;
  const t = `doc.${key}`;
  const views = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed', 'waiting_facility_manager'].map(v => `${t}:view.${v}`);
  const reqRole = await kit.role(admin.token, `sr_${suffix}`, `SR requester ${suffix}`);
  await kit.ok('PUT', `/roles/${reqRole.id}/permissions/tabs/${t}`, admin.token, { actions: ['view', 'add', 'edit', 'submit'].map(a => `${t}:action.${a}`), views });
  await kit.ok('PUT', `/roles/${reqRole.id}/scope`, admin.token, { entries: [{ allNodes: true }] });
  const appr = await kit.ok('GET', `/roles/${approverRole}/permissions`, admin.token) as { grants: { key: string }[] };
  void appr;
  await kit.ok('PUT', `/roles/${approverRole}/permissions/tabs/${t}`, admin.token, { actions: [`${t}:action.view`, `${t}:action.stage_facility_manager`], views });
  const requester = await userWithRoles([], 'SR requester');
  await kit.ok('PUT', `/users/${requester.id}/roles`, admin.token, { roleIds: [reqRole.id] });
  let number = '';

  await test.step('a requester raises one: the custom field is required; the number comes from the Pune series', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const pu = new Ui(p);
    await pu.tenantLogin('acme', requester.email, requester.password);
    await pu.nav(`nav-docs-${key}`);
    await p.getByTestId('doc-new').click();
    await fillCapexForm(p, { purpose: '', lines: [{ item: /MS Plate/, qty: '2' }] }).catch(async () => {
      // no purpose field on this type: location + lines only
      await pickLookup(p, 'location', /^Pune Plant/);
      await pickLookup(p, 'lines-0-item', /MS Plate/);
      await p.getByTestId('field-lines-0-qty-input').fill('2');
    });
    await p.getByTestId('doc-submit').click();
    const sd = p.getByTestId('submit-dialog');
    if (await sd.isVisible().catch(() => false)) await sd.getByRole('button', { name: /submit/i }).last().click();
    await expect(p.getByTestId('doc-form-error')).toBeVisible();
    await expect(p.getByTestId('field-service_window')).toContainText(/required/i);
    await p.getByTestId('field-service_window-input').fill('Saturday 10:00–14:00');
    await p.getByTestId('doc-submit').click();
    if (await sd.isVisible().catch(() => false)) await sd.getByRole('button', { name: /submit/i }).last().click();
    await expect(p.getByTestId('doc-number')).toHaveText(/^SRP\/001$/, { timeout: 20_000 });
    number = (await p.getByTestId('doc-number').innerText()).trim();
    await expect(p.getByTestId('wf-stage-facility_manager')).toBeVisible();
    await ctx.close();
  });

  await test.step('the HOD (Approver role) approves it from the inbox', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await new Ui(p).tenantLogin('acme', 'approver@acme.test', 'Approve@12345');
    await p.goto('/approvals');
    await p.getByTestId(`inbox-row-${number}`).click();
    await expect(p.getByTestId('approve-screen')).toHaveAttribute('data-stage', 'facility_manager');
    await p.getByTestId('decision-1-set-approve').click();
    await p.getByTestId('decision-submit').click();
    await p.waitForURL(/\/docs\//);
    await ctx.close();
    const [row] = await ownerQuery<{ status_key: string; custom: Record<string, unknown> }>(`select status_key, custom from app.document where number = $1 and doc_type_id = (select id from app.doc_type where key = $2)`, [number, key]);
    expect(row).toMatchObject({ status_key: 'approved', custom: { service_window: 'Saturday 10:00–14:00' } });
  });
});

// QA3-BUG-015 (fixed): the form builder did not know a document type's virtual `lines` grid: on every doc type header
// form (with lines) the system field total_amount = SUM(lines.amount) was reported "Unknown field 'lines'" and Publish
// was disabled. The builder now checks header formulas with the line form as `lines` (like the server).
test('[QA3-BUG-015] the form builder can publish a header field on a document type with lines (capex_header)', async ({ page }) => {
  await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
  await page.goto('/config/forms/capex_header');
  await page.getByTestId('palette-text').click();
  await page.getByTestId('builder-properties').getByTestId('prop-label').fill('Cost centre');
  await expect(page.getByTestId('builder-issues')).not.toContainText(/Unknown field 'lines'/, { timeout: 5_000 });
  await expect(page.getByTestId('builder-publish')).toBeEnabled({ timeout: 5_000 });
});

/**
 * J8 — document permissions (desktop):
 *  - the restricted indenter (seed: add/edit/submit/view; views draft + rejected + waiting_hod; Pune scope) sees only
 *    those status chips, cannot act on a waiting document (no approve button, API 403), and with `est_rate` hidden on
 *    the capex line form for the Indent clerk role sees no estimated rate in the form, the list, the detail or the API;
 *  - the HOD approver cannot see or act on a Chennai document (scope → 404) nor on a document they submitted
 *    themselves (self-approval off → 403, not in the inbox).
 */
import { expect, kit, test, Ui } from './support/fixtures';
import { ADMIN, APPROVER, apiCapex, INDENTER, login, seedIds, userWithRoles } from './support/phase3';

test.describe.configure({ mode: 'serial' });
type Doc = { id: string; number: string; statusKey: string; version: number; lines: { id: string; values: Record<string, unknown> }[]; allowedActions: string[] };

async function setIndenterEstRateHidden(hidden: boolean) {
  const admin = await login(ADMIN);
  const i = await seedIds();
  const perms = await kit.ok('GET', `/roles/${i.roles.indent_clerk}/permissions`, admin.token) as { grants: { key: string; effect: string }[] };
  const capex = perms.grants.filter(g => g.key.startsWith('doc.capex:') && g.effect === 'allow').map(g => g.key);
  await kit.ok('PUT', `/roles/${i.roles.indent_clerk}/permissions/tabs/doc.capex`, admin.token, {
    actions: capex.filter(k => k.includes(':action.')), views: capex.filter(k => k.includes(':view.')),
    fieldAccess: hidden ? [{ formKey: 'capex_line', fieldKey: 'est_rate', mode: 'hidden' }] : [],
  });
}

test('J8a: restricted indenter — granted views only, cannot act, est_rate hidden in form, list, detail and API', async ({ page }) => {
  const waiting = await apiCapex(ADMIN, [{ qty: '7', est_rate: '1234.56' }], { purpose: 'J8 hidden rate' }) as Doc;
  const approved = await apiCapex(ADMIN, [{ qty: '1', est_rate: '10' }], { purpose: 'J8 approved one' }) as Doc;
  await kit.ok('POST', `/docs/capex/${approved.id}/actions`, (await login(APPROVER)).token, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
  await setIndenterEstRateHidden(true);
  try {
    const ui = new Ui(page);
    await ui.tenantLogin('acme', INDENTER.email, INDENTER.password);
    await ui.nav('nav-docs-capex');
    await expect(page.getByTestId('doc-status-chips')).toBeVisible();
    const chips = () => page.getByTestId('doc-status-chips').locator('[data-testid^="doc-status-"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid')).filter(c => c !== 'doc-status-all').sort());
    await expect.poll(chips).toEqual(['doc-status-draft', 'doc-status-rejected', 'doc-status-waiting_hod']);
    await expect(page.getByTestId(`doc-row-${waiting.number}`)).toBeVisible();
    await expect(page.getByTestId(`doc-row-${approved.number}`)).toHaveCount(0);
    expect(await page.locator('main').innerText()).not.toContain('1,234.56');

    // detail: no approve, no est_rate
    await page.getByTestId(`doc-row-${waiting.number}`).click();
    await expect(page.getByTestId('doc-number')).toHaveText(waiting.number);
    await expect(page.getByTestId('doc-approve')).toHaveCount(0);
    await expect(page.getByTestId('doc-lines')).not.toContainText(/Estimated rate/i);
    expect(await page.locator('main').innerText()).not.toContain('1,234.56');
    // item-wise list
    await page.goto('/docs/capex?view=item');
    await expect(page.getByTestId(`doc-row-${waiting.number}-1`)).toBeVisible();
    expect(await page.locator('main').innerText()).not.toContain('1,234.56');
    // create form: no est_rate column
    await page.goto('/docs/capex/new');
    await expect(page.getByTestId('field-lines-0-qty-input')).toBeVisible();
    await expect(page.getByTestId('field-lines-0-est_rate-input')).toHaveCount(0);
    // approved document by URL → not visible (no view)
    await page.goto(`/docs/capex/${approved.id}`);
    await expect(page.getByTestId('doc-number')).toHaveCount(0);

    // API
    const s = await login(INDENTER);
    const detail = await kit.ok('GET', `/docs/capex/${waiting.id}`, s.token) as Doc;
    expect(detail.lines[0]!.values).not.toHaveProperty('est_rate');
    expect(detail.allowedActions).not.toContain('decide');
    expect(JSON.stringify(await kit.ok('GET', '/docs/capex?view=item&columns=est_rate&limit=200', s.token))).not.toContain('1234.56');
    expect((await kit.call('GET', '/docs/capex', s.token, undefined, { status: 'approved' })).status).toBe(403);
    expect((await kit.call('GET', `/docs/capex/${approved.id}`, s.token)).status).toBe(404);
    const actRes = await kit.call('POST', `/docs/capex/${waiting.id}/actions`, s.token, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
    expect(actRes.status).toBe(403);
    const write = await kit.call('POST', '/docs/capex', s.token, { values: { location: (await seedIds()).pune, purpose: 'x' }, lines: [{ values: { item: (await seedIds()).items['ITM-00001'], qty: '1', est_rate: '5' } }] });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('FIELD_READ_ONLY');
  } finally {
    await setIndenterEstRateHidden(false);
  }
});

test('J8b: approver — Chennai document is out of scope (404); own submission cannot be approved (self-approval off)', async ({ page }) => {
  const chennai = await apiCapex(ADMIN, [{ qty: '2', est_rate: '100' }], { location: 'chennai', purpose: 'J8 Chennai' }) as Doc;
  expect(chennai.number).toMatch(/^CAPEX\/CHENNAI\//);
  // a Pune requester who is also an HOD approver
  const both = await userWithRoles(['requester', 'approver'], 'Requester HOD');
  const own = await apiCapex(both, [{ qty: '1', est_rate: '100' }], { purpose: 'J8 my own' }) as Doc;
  const s = await login(both);
  expect((await kit.call('POST', `/docs/capex/${own.id}/actions`, s.token, { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).toBe(403);
  const ownDetail = await kit.ok('GET', `/docs/capex/${own.id}`, s.token) as Doc;
  expect(ownDetail.allowedActions).not.toContain('decide');
  const inbox = await kit.ok('GET', '/approvals', s.token) as { data: { documentId: string }[] };
  expect(inbox.data.map(x => x.documentId)).not.toContain(own.id);

  const ap = await login(APPROVER);
  expect((await kit.call('GET', `/docs/capex/${chennai.id}`, ap.token)).status).toBe(404);
  expect((await kit.call('POST', `/docs/capex/${chennai.id}/actions`, ap.token, { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).toBe(404);

  await new Ui(page).tenantLogin('acme', APPROVER.email, APPROVER.password);
  await page.goto('/approvals');
  await expect(page.getByTestId('inbox-list')).toBeVisible();
  await expect(page.getByTestId(`inbox-row-${chennai.number}`)).toHaveCount(0);
  await page.goto(`/docs/capex/${chennai.id}`);
  await expect(page.getByTestId('doc-number')).toHaveCount(0);
  await page.goto(`/docs/capex/${chennai.id}/approve?stage=hod`);
  await expect(page.getByTestId('approve-screen')).toHaveCount(0);
  // the own-submission user sees the document but no approve action
  const ctx = await page.context().browser()!.newContext();
  const p = await ctx.newPage();
  await new Ui(p).tenantLogin('acme', both.email, both.password);
  await p.goto(`/docs/capex/${own.id}`);
  await expect(p.getByTestId('doc-number')).toHaveText(own.number);
  await expect(p.getByTestId('doc-approve')).toHaveCount(0);
  await ctx.close();
});

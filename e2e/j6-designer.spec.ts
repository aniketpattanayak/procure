/**
 * J6 — Workflow designer (desktop): as the acme admin add a stage with a condition typed in the formula editor, an
 * actor and an SLA, publish v2; a document submitted before keeps v1 while a new one runs on v2 (+ the new stage);
 * then remove the Finance stage (v3) while a v1 document waits there → the Buyer can still act ("retired" keys),
 * and the retired keys disappear once nothing waits there.
 */
import { expect, kit, test, Ui } from './support/fixtures';
import { ADMIN, APPROVER, apiCapex, financeUser, INDENTER, login, seedIds } from './support/phase3';
import { ownerQuery, typeFormula } from './support/phase2';

test.describe.configure({ mode: 'serial' });

type Doc = { id: string; number: string; statusKey: string; workflow: { workflowVersion: number; stages: { key: string; status: string }[] } };
const NEW_KEY = 'plant_head_review';

async function publishInUi(page: import('@playwright/test').Page, note: string) {
  await page.getByTestId('wf-save').click();
  await expect(page.getByTestId('wf-designer')).not.toHaveAttribute('data-dirty', 'true');
  await expect(page.getByTestId('wf-issues')).toHaveAttribute('data-count', '0');
  await page.getByTestId('wf-publish').click();
  const d = page.getByTestId('wf-publish-dialog');
  await expect(d).toBeVisible();
  await d.getByTestId('wf-publish-note').fill(note);
  await d.getByTestId('wf-publish-confirm').click();
  await expect(d).toBeHidden({ timeout: 20_000 });
}

test('J6: designer — add a conditional stage with SLA, publish v2; v1 documents keep v1; removing a stage keeps retired keys', async ({ page, browser }) => {
  const admin = await login(ADMIN);
  const fin = await financeUser();
  const v0 = ((await kit.ok('GET', '/config/workflows/capex', admin.token)) as { publishedVersion: number }).publishedVersion;
  // A v1 document waiting at Finance (₹2 lakh → HOD → Finance)
  const old = await apiCapex(INDENTER, [{ qty: '20', est_rate: '10000' }], { purpose: 'J6 before the change' }) as Doc;
  await kit.ok('POST', `/docs/capex/${old.id}/actions`, (await login(APPROVER)).token, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
  expect(old.workflow.workflowVersion).toBe(v0);

  await test.step('add "Plant head review": formula condition, Approver role, 12 h SLA; publish', async () => {
    await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
    await page.goto('/config/workflows/capex');
    await expect(page.getByTestId('wf-designer')).toBeVisible();
    await page.getByTestId('wf-add-stage').click();
    const panel = page.getByTestId('wf-stage-panel');
    await expect(panel).toBeVisible();
    await panel.getByTestId('wf-prop-name').fill('Plant head review');
    await expect(panel.getByTestId('wf-prop-key')).toHaveValue(NEW_KEY);
    // condition in the formula editor: a typo is flagged, the fix is accepted
    await typeFormula(page, 'wf-prop-when', "priorty = 'Urgent'");
    await expect(panel.getByTestId('wf-prop-when-status')).toContainText(/unknown|not found|error|priorty/i);
    await expect(page.getByTestId('wf-issues')).not.toHaveAttribute('data-count', '0');
    await typeFormula(page, 'wf-prop-when', "priority = 'Urgent' and total_amount > 10000");
    await expect(panel.getByTestId('wf-prop-when-status')).not.toContainText(/unknown|error/i);
    // actor: Approver role
    await panel.getByTestId('wf-prop-actor-add').click();
    await panel.getByTestId('wf-prop-actor-0-type').selectOption('role');
    await panel.getByTestId('wf-prop-actor-0-role').selectOption({ label: 'Approver' });
    // SLA 12 h, remind every 4 h
    const sla = panel.locator('details').filter({ has: page.getByTestId('wf-prop-sla') });
    if (!(await sla.getAttribute('open'))) await sla.locator('summary').click();
    await panel.getByTestId('wf-prop-sla').click();
    await panel.getByTestId('wf-prop-slaHours').fill('12');
    await panel.getByTestId('wf-prop-slaRemind').fill('4');
    await expect(page.getByTestId(`wf-cond-${NEW_KEY}`)).toContainText("priority = 'Urgent'");
    await expect(page.getByTestId(`wf-sla-${NEW_KEY}`)).toContainText('12');
    await publishInUi(page, 'J6: plant head for urgent requests');
    await expect(page.getByTestId('wf-designer').getByText(`v${v0 + 1} live`)).toBeVisible();
    const detail = await kit.ok('GET', '/config/workflows/capex', admin.token) as { publishedVersion: number; published: { stages: { key: string; when?: string; sla?: { hours: number; remindEveryHours?: number }; actors: { type: string }[] }[] } };
    expect(detail.publishedVersion).toBe(v0 + 1);
    expect(detail.published.stages.find(s => s.key === NEW_KEY)).toMatchObject({ when: "priority = 'Urgent' and total_amount > 10000", sla: { hours: 12, remindEveryHours: 4 }, actors: [{ type: 'role' }] });
    // stage key + view generated
    const keys = await ownerQuery<{ key: string }>(`select key from app.permission_def where key like 'doc.capex:%${NEW_KEY}'`);
    expect(keys.map(k => k.key).sort()).toEqual([`doc.capex:action.stage_${NEW_KEY}`, `doc.capex:view.waiting_${NEW_KEY}`]);
  });

  let fresh: Doc;
  await test.step('a new urgent document runs on v2 and reaches the new stage; the old one stays on v1', async () => {
    const i = await seedIds();
    // grant the new stage key + view to the Approver role (through the roles API, as an admin would in the UI)
    const perms = await kit.ok('GET', `/roles/${i.roles.approver}/permissions`, admin.token) as { grants: { key: string; effect: string }[] };
    const capex = perms.grants.filter(g => g.key.startsWith('doc.capex:') && g.effect === 'allow').map(g => g.key);
    await kit.ok('PUT', `/roles/${i.roles.approver}/permissions/tabs/doc.capex`, admin.token, {
      actions: [...capex.filter(k => k.includes(':action.')), `doc.capex:action.stage_${NEW_KEY}`],
      views: [...capex.filter(k => k.includes(':view.')), `doc.capex:view.waiting_${NEW_KEY}`],
    });
    const s = await login(INDENTER);
    const d = await kit.ok('POST', '/docs/capex', s.token, {
      values: { location: i.pune, purpose: 'J6 after the change', priority: 'Urgent', justification: 'Line down' },
      lines: [{ values: { item: i.items['ITM-00001'], qty: '3', est_rate: '5000' } }],
    }, 201);
    fresh = await kit.ok('POST', `/docs/capex/${d.id}/submit`, s.token, { version: d.version }) as Doc;
    expect(fresh.workflow.workflowVersion).toBe(v0 + 1);
    expect(fresh.workflow.stages.map(x => x.key)).toEqual(['hod', 'finance', 'director', NEW_KEY]);
    expect(Object.fromEntries(fresh.workflow.stages.map(x => [x.key, x.status]))).toMatchObject({ hod: 'active', finance: 'skipped', director: 'skipped', [NEW_KEY]: 'pending' });
    const ap = await login(APPROVER);
    await kit.ok('POST', `/docs/capex/${fresh.id}/actions`, ap.token, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
    const after = await kit.ok('GET', `/docs/capex/${fresh.id}`, admin.token) as Doc;
    expect(after.statusKey).toBe(`waiting_${NEW_KEY}`);
    const oldNow = await kit.ok('GET', `/docs/capex/${old.id}`, admin.token) as Doc;
    expect(oldNow.workflow.workflowVersion).toBe(v0);
    expect(oldNow.workflow.stages.map(x => x.key)).toEqual(['hod', 'finance', 'director']);
    expect(oldNow.statusKey).toBe('waiting_finance');
  });

  await test.step('remove the Finance stage (v3) while the v1 document waits there → retired keys; Buyer still acts', async () => {
    await page.goto('/config/workflows/capex');
    await page.getByTestId('wf-stage-menu-finance').click();
    await page.getByTestId('wf-delete-finance').click();
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: /delete|remove/i });
    if (await confirm.count()) await confirm.getByRole('button', { name: /delete|remove/i }).last().click();
    await expect(page.getByTestId('wf-stage-finance')).toHaveCount(0);
    await publishInUi(page, 'J6: drop finance');
    await expect(page.getByTestId('wf-designer').getByText(`v${v0 + 2} live`)).toBeVisible();
    const defs = await ownerQuery<{ key: string; label: string }>(`select key, label from app.permission_def where key like 'doc.capex:%finance' order by key`);
    expect(defs.map(d => d.key)).toEqual(['doc.capex:action.stage_finance', 'doc.capex:view.waiting_finance']);
    expect(defs.every(d => /retired/i.test(d.label))).toBe(true);
    // the Buyer still sees it in the inbox and approves in the UI
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await new Ui(p).tenantLogin('acme', fin.email, fin.password);
    await p.goto('/approvals');
    await expect(p.getByTestId(`inbox-row-${old.number}`)).toBeVisible();
    await p.goto(`/docs/capex/${old.id}/approve?stage=finance`);
    await expect(p.getByTestId('approve-screen')).toHaveAttribute('data-stage', 'finance');
    await p.getByTestId('decision-1-set-approve').click();
    await p.getByTestId('decision-submit').click();
    await p.waitForURL(new RegExp(`/docs/capex/${old.id}$`));
    await ctx.close();
    expect(((await kit.ok('GET', `/docs/capex/${old.id}`, admin.token)) as Doc).statusKey).toBe('approved');
    // nothing waits at finance any more → retired keys (and their grants) are gone
    const left = await ownerQuery(`select key from app.permission_def where key like 'doc.capex:%finance'`);
    expect(left).toEqual([]);
  });

  await test.step('restore the seeded definition (later specs rely on Finance)', async () => {
    const vers = await kit.ok('GET', '/config/workflows/capex/versions/1', admin.token) as { stages: unknown[]; granularity: string };
    const cur = await kit.ok('GET', '/config/workflows/capex', admin.token) as { version: number };
    const saved = await kit.ok('PUT', '/config/workflows/capex/draft', admin.token, { definition: vers, version: cur.version }) as { version: number };
    await kit.ok('POST', '/config/workflows/capex/publish', admin.token, { version: saved.version, changeNote: 'J6 restore' });
    const i = await seedIds();
    // re-grant the Buyer's finance key (deleted with the stage)
    const perms = await kit.ok('GET', `/roles/${i.roles.buyer}/permissions`, admin.token) as { grants: { key: string; effect: string }[] };
    const capex = perms.grants.filter(g => g.key.startsWith('doc.capex:') && g.effect === 'allow').map(g => g.key);
    await kit.ok('PUT', `/roles/${i.roles.buyer}/permissions/tabs/doc.capex`, admin.token, {
      actions: [...new Set([...capex.filter(k => k.includes(':action.')), 'doc.capex:action.stage_finance'])],
      views: [...new Set([...capex.filter(k => k.includes(':view.')), 'doc.capex:view.waiting_finance'])],
    });
  });
});

// QA3-BUG-010 (fixed): the document detail did not show which workflow version a document runs on; the progress strip
// now ends with "Workflow version N".
test('[QA3-BUG-010] the document detail shows the workflow version the document runs on', async ({ page }) => {
  test.setTimeout(60_000);
  const doc = await apiCapex(INDENTER, [{ qty: '1', est_rate: '100' }], { purpose: 'J6 version label' }) as Doc;
  await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
  await page.goto(`/docs/capex/${doc.id}`);
  await expect(page.getByTestId('wf-progress')).toBeVisible();
  // (main's textContent runs "…version 4" into the next tab label, so match the version element itself)
  await expect(page.getByTestId('wf-version')).toHaveText(new RegExp(`(version\\s*|\\bv)${doc.workflow.workflowVersion}$`, 'i'), { timeout: 5_000 });
});

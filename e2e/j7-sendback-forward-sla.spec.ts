/**
 * J7 — send back, forward and SLA (desktop):
 *  - HOD sends a request back to the submitter → it is a draft again, editable; resubmission keeps the number;
 *  - Finance sends a ₹2 lakh request back to HOD → HOD sees it in the inbox again and re-approves;
 *  - HOD forwards a request to a colleague (Pune, capex view only) who then approves it (on behalf of the HOD);
 *  - SLA: the HOD stage gets a 0.01 h SLA (36 s, reminder every 18 s, escalate to the acme admin) through the API;
 *    the API's 1-minute `workflow-sla` repeatable job sends the reminder and escalates → notifications (bell),
 *    timeline entries and the inbox overdue flag.
 */
import { expect, kit, test, Ui } from './support/fixtures';
import { ADMIN, APPROVER, apiCapex, financeUser, INDENTER, login, scheduleSlaScan, seedIds, typeInto, userWithRoles } from './support/phase3';

test.describe.configure({ mode: 'serial' });
type Doc = { id: string; number: string; statusKey: string; version: number; lines: { id: string; lineNo: number; values: Record<string, unknown> }[] };

test('J7a: send back to the submitter → editable draft → resubmit keeps the number', async ({ page, browser }) => {
  const doc = await apiCapex(INDENTER, [{ qty: '4', est_rate: '2500' }, { qty: '2', est_rate: '1000' }], { purpose: 'J7 send back to me' }) as Doc;
  const ctx = await browser.newContext();
  const ap = await ctx.newPage();
  await new Ui(ap).tenantLogin('acme', APPROVER.email, APPROVER.password);
  await ap.goto(`/docs/capex/${doc.id}/approve?stage=hod`);
  await ap.getByTestId('send-back').click();
  const dlg = ap.getByTestId('send-back-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('send-back-target').selectOption('_draft');
  // reason required
  await dlg.getByTestId('send-back-confirm').click();
  await expect(dlg).toBeVisible();
  await dlg.getByTestId('send-back-reason').fill('Attach the vendor quote please');
  await dlg.getByTestId('send-back-confirm').click();
  await expect(dlg).toBeHidden();
  await ctx.close();

  await new Ui(page).tenantLogin('acme', INDENTER.email, INDENTER.password);
  // notification to the submitter, opens the document
  await page.getByTestId('notifications-bell').click();
  await page.getByText(`${doc.number} was sent back to you`).first().click();
  await page.waitForURL(new RegExp(`/docs/capex/${doc.id}`));
  // QA3-BUG-012 (fixed): the notifications panel closes when a notification navigates
  await expect(page.getByTestId('notifications-panel')).toBeHidden();
  await expect(page.getByTestId('doc-number')).toHaveText(doc.number);
  await expect(page.locator('main')).toContainText('Draft');
  await expect(page.getByTestId('doc-edit')).toBeVisible();
  await page.getByTestId('doc-tab-timeline').click();
  await expect(page.getByTestId('timeline')).toContainText('Sent back to the creator from HOD approval');
  await expect(page.getByTestId('timeline')).toContainText('Attach the vendor quote please');
  await page.getByTestId('doc-edit').click();
  await page.waitForURL(/\/edit$/);
  await typeInto(page.getByTestId('field-lines-0-qty-input'), '5');
  await expect(page.getByTestId('field-total_amount-input')).toContainText('14,500.00');
  await page.getByTestId('doc-submit').click();
  const sd = page.getByTestId('submit-dialog');
  if (await sd.isVisible().catch(() => false)) await sd.getByRole('button', { name: /submit/i }).last().click();
  await expect(page.getByTestId('doc-number')).toHaveText(doc.number, { timeout: 20_000 });
  const now = await kit.ok('GET', `/docs/capex/${doc.id}`, (await login(ADMIN)).token) as Doc & { lines: { qty: Record<string, string> }[] };
  expect(now.statusKey).toBe('waiting_hod');
  expect(now.number).toBe(doc.number);
  expect(now.lines[0]!.qty.pendingApproval).toBe('5');
});

test('J7b: Finance sends back to HOD; HOD re-approves; Finance approves', async ({ browser }) => {
  const fin = await financeUser();
  const doc = await apiCapex(INDENTER, [{ qty: '20', est_rate: '10000' }], { purpose: 'J7 send back to HOD' }) as Doc;
  const ap = await login(APPROVER);
  await kit.ok('POST', `/docs/capex/${doc.id}/actions`, ap.token, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await new Ui(p).tenantLogin('acme', fin.email, fin.password);
  await p.goto(`/docs/capex/${doc.id}/approve?stage=finance`);
  await p.getByTestId('send-back').click();
  const dlg = p.getByTestId('send-back-dialog');
  const opts = await dlg.getByTestId('send-back-target').locator('option').evaluateAll(os => os.map(o => (o as HTMLOptionElement).value));
  expect(opts).toEqual(expect.arrayContaining(['_draft', 'hod']));
  expect(opts).not.toContain('director');
  await dlg.getByTestId('send-back-target').selectOption('hod');
  await dlg.getByTestId('send-back-reason').fill('Recheck the quantity with the plant');
  await dlg.getByTestId('send-back-confirm').click();
  await expect(dlg).toBeHidden();
  await ctx.close();
  expect(((await kit.ok('GET', `/docs/capex/${doc.id}`, (await login(ADMIN)).token)) as Doc).statusKey).toBe('waiting_hod');

  const c2 = await browser.newContext();
  const h = await c2.newPage();
  await new Ui(h).tenantLogin('acme', APPROVER.email, APPROVER.password);
  await h.goto('/approvals');
  await expect(h.getByTestId(`inbox-row-${doc.number}`)).toBeVisible();
  await h.getByTestId(`inbox-row-${doc.number}`).click();
  await expect(h.getByTestId('approve-screen')).toHaveAttribute('data-stage', 'hod');
  await h.getByTestId('decision-1-set-approve').click();
  await h.getByTestId('decision-submit').click();
  await h.waitForURL(new RegExp(`/docs/capex/${doc.id}$`));
  await c2.close();
  // (the HOD has no waiting_finance view, so the admin reads the timeline)
  const tl = await kit.ok('GET', `/docs/capex/${doc.id}/timeline`, (await login(ADMIN)).token) as { title: string; detail?: string }[];
  expect(tl.map(e => e.title)).toEqual(expect.arrayContaining(['Sent back to HOD approval from Finance review']));
  expect(tl.find(e => e.title.startsWith('Sent back'))!.detail).toBe('Recheck the quantity with the plant');
  await kit.ok('POST', `/docs/capex/${doc.id}/actions`, (await login(fin)).token, { action: 'decide', stageKey: 'finance', outcome: 'approve' });
  expect(((await kit.ok('GET', `/docs/capex/${doc.id}`, (await login(ADMIN)).token)) as Doc).statusKey).toBe('approved');
});

test('J7c: forward to a colleague who then approves (on behalf of the HOD)', async ({ browser }) => {
  // a Pune colleague with capex view (+ the HOD waiting view) and the inbox, no stage key
  const admin = await login(ADMIN);
  const i = await seedIds();
  const role = await kit.role(admin.token, `fwd_${Date.now().toString(36)}`, 'Capex reviewer');
  await kit.ok('PUT', `/roles/${role.id}/permissions/tabs/doc.capex`, admin.token, { actions: ['doc.capex:action.view'], views: ['doc.capex:view.waiting_hod', 'doc.capex:view.approved'] });
  await kit.ok('PUT', `/roles/${role.id}/permissions/tabs/approvals`, admin.token, { actions: ['approvals:action.view'], views: [] });
  await kit.ok('PUT', `/roles/${role.id}/scope`, admin.token, { entries: [{ nodeId: i.pune }] });
  const colleague = await userWithRoles([], 'Reviewer');
  await kit.ok('PUT', `/users/${colleague.id}/roles`, admin.token, { roleIds: [role.id] });
  const doc = await apiCapex(INDENTER, [{ qty: '3', est_rate: '1000' }], { purpose: 'J7 forward' }) as Doc;

  const ctx = await browser.newContext();
  const ap = await ctx.newPage();
  await new Ui(ap).tenantLogin('acme', APPROVER.email, APPROVER.password);
  await ap.goto(`/docs/capex/${doc.id}/approve?stage=hod`);
  const fwdBtn = ap.getByTestId('forward');
  // the seeded HOD stage does not list 'forward' in its actions → no button; enable it for this test via the API
  if (!(await fwdBtn.count())) {
    const cur = await kit.ok('GET', '/config/workflows/capex', admin.token) as { published: { stages: { key: string; actions: string[] }[] }; version: number };
    const def = { ...cur.published, stages: cur.published.stages.map(s => (s.key === 'hod' ? { ...s, actions: [...s.actions, 'forward'] } : s)) };
    const saved = await kit.ok('PUT', '/config/workflows/capex/draft', admin.token, { definition: def, version: cur.version }) as { version: number };
    await kit.ok('POST', '/config/workflows/capex/publish', admin.token, { version: saved.version, changeNote: 'J7 forward' });
    test.info().annotations.push({ type: 'note', description: 'Seeded HOD stage has no forward action; published a version with forward for J7c (documents keep their version, so a new one is raised).' });
    const fresh = await apiCapex(INDENTER, [{ qty: '3', est_rate: '1000' }], { purpose: 'J7 forward v2' }) as Doc;
    Object.assign(doc, fresh);
    await ap.goto(`/docs/capex/${doc.id}/approve?stage=hod`);
  }
  await ap.getByTestId('forward').click();
  const dlg = ap.getByTestId('forward-dialog');
  await expect(dlg).toBeVisible();
  const combo = dlg.getByTestId('forward-user').getByRole('combobox');
  await combo.click();
  await combo.pressSequentially(colleague.email.slice(0, 8));
  await dlg.page().getByTestId('forward-user-option').filter({ hasText: colleague.email }).first().click();
  await dlg.getByTestId('forward-reason').fill('You know this vendor, please decide');
  await dlg.getByTestId('forward-confirm').click();
  await expect(dlg).toBeHidden();
  await ctx.close();

  const c2 = await browser.newContext();
  const p = await c2.newPage();
  await new Ui(p).tenantLogin('acme', colleague.email, colleague.password);
  await p.goto('/approvals');
  const row = p.getByTestId(`inbox-row-${doc.number}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(/forwarded/i);
  await row.click();
  await expect(p.getByTestId('approve-screen')).toHaveAttribute('data-stage', 'hod');
  await p.getByTestId('decision-1-set-approve').click();
  await p.getByTestId('decision-submit').click();
  await p.waitForURL(new RegExp(`/docs/capex/${doc.id}$`));
  await p.getByTestId('doc-tab-timeline').click();
  await expect(p.getByTestId('timeline')).toContainText(`Forwarded to ${colleague.name}`);
  await expect(p.getByTestId('timeline')).toContainText('Approved 1 line at HOD approval');
  await c2.close();
  expect(((await kit.ok('GET', `/docs/capex/${doc.id}`, admin.token)) as Doc).statusKey).toBe('approved');
});

async function tinySla<T>(fn: (doc: Doc) => Promise<T>): Promise<T> {
  const admin = await login(ADMIN);
  const cur = await kit.ok('GET', '/config/workflows/capex', admin.token) as { published: { stages: { key: string; sla?: unknown }[] }; version: number };
  const original = cur.published;
  const adminId = (await seedIds()).users[ADMIN.email]!;
  const def = { ...original, stages: original.stages.map(s => (s.key === 'hod' ? { ...s, sla: { hours: 0.01, remindEveryHours: 0.005, escalateTo: { type: 'users', userIds: [adminId] } } } : s)) };
  const saved = await kit.ok('PUT', '/config/workflows/capex/draft', admin.token, { definition: def, version: cur.version }) as { version: number };
  await kit.ok('POST', '/config/workflows/capex/publish', admin.token, { version: saved.version, changeNote: 'J7 tiny SLA' });
  try {
    return await fn(await apiCapex(INDENTER, [{ qty: '1', est_rate: '500' }], { purpose: 'J7 SLA' }) as Doc);
  } finally {
    const now = await kit.ok('GET', '/config/workflows/capex', admin.token) as { version: number };
    const back = await kit.ok('PUT', '/config/workflows/capex/draft', admin.token, { definition: original, version: now.version }) as { version: number };
    await kit.ok('POST', '/config/workflows/capex/publish', admin.token, { version: back.version, changeNote: 'J7 restore' });
  }
}
let adminToken: string | null = null; // one sign-in: polling must not trip the per-account sign-in limiter
const titles = async (docId: string) => ((await kit.ok('GET', `/docs/capex/${docId}/timeline`, (adminToken ??= (await login(ADMIN)).token))) as { title: string }[]).map(e => e.title);

// QA3-BUG-013 (fixed): the API used to start its workers before module init, so the repeatable jobs (workflow-sla,
// outbox relay, audit-verify) were never registered in the API process. This runs on the API's own 1-minute job.
test('[QA3-BUG-013 fixed] J7d: SLA 0.01 h — the API\'s own 1-minute job reminds and escalates', async () => {
  test.setTimeout(200_000);
  await tinySla(async doc => {
    // due after 36 s; the repeatable runs every 60 s → escalated within ~100 s
    await expect.poll(() => titles(doc.id), { timeout: 110_000, intervals: [5_000] }).toEqual(expect.arrayContaining(['Escalated at HOD approval']));
  });
});

test('J7e: SLA 0.01 h with the workflow-sla job scheduled on the API queue: bell, timeline, inbox overdue, escalation', async ({ page }) => {
  test.setTimeout(200_000);
  const stop = await scheduleSlaScan(5_000);
  try {
    await tinySla(async doc => {
      const admin = await login(ADMIN);
      const ap = await login(APPROVER);
      await expect.poll(async () => {
        const inbox = await kit.ok('GET', '/approvals', ap.token) as { data: { documentId: string; overdue: boolean }[] };
        return inbox.data.find(x => x.documentId === doc.id)?.overdue ?? false;
      }, { timeout: 90_000, intervals: [3_000] }).toBe(true);
      await expect.poll(() => titles(doc.id), { timeout: 60_000, intervals: [3_000] })
        .toEqual(expect.arrayContaining(['Escalated at HOD approval', 'Reminder sent at HOD approval']));
      expect((await titles(doc.id)).filter(t => t === 'Escalated at HOD approval').length).toBe(1);

      await new Ui(page).tenantLogin('acme', APPROVER.email, APPROVER.password);
      await page.goto('/approvals');
      await expect(page.getByTestId('inbox-overdue-count')).toBeVisible();
      await page.getByTestId('inbox-overdue').click();
      await expect(page.getByTestId(`inbox-row-${doc.number}`)).toBeVisible();
      await expect(page.getByTestId(`inbox-row-${doc.number}`)).toContainText(/was due/i); // overdue style + siren icon
      await page.getByTestId('notifications-bell').click();
      await expect(page.getByText(`Reminder: ${doc.number} is waiting for HOD approval`).first()).toBeVisible();
      await expect(page.getByText(`${doc.number} is overdue at HOD approval`).first()).toBeVisible();
      await page.keyboard.press('Escape');
      const adminInbox = await kit.ok('GET', '/approvals', admin.token) as { data: { documentId: string; assignedBecause: string; overdue: boolean }[] };
      expect(adminInbox.data.find(x => x.documentId === doc.id)).toMatchObject({ assignedBecause: 'escalation', overdue: true });
      await page.goto(`/docs/capex/${doc.id}`);
      await page.getByTestId('doc-tab-timeline').click();
      await expect(page.getByTestId('timeline')).toContainText('Escalated at HOD approval');
      await expect(page.getByTestId('timeline')).toContainText('Reminder sent at HOD approval');
    });
  } finally {
    await stop();
  }
});

// QA3-BUG-011 (fixed): send back to the submitter (and cancel) used to close the instance by marking its ACTIVE stages
// 'done', so the draft's progress strip showed "HOD approval — Done". They now go back to pending.
test('[QA3-BUG-011] after a send back to draft the progress does not show the sending stage as done/approved', async ({ page }) => {
  const doc = await apiCapex(INDENTER, [{ qty: '1', est_rate: '100' }], { purpose: 'J7 progress after send back' }) as Doc;
  await kit.ok('POST', `/docs/capex/${doc.id}/actions`, (await login(APPROVER)).token, { action: 'send_back', stageKey: 'hod', toStage: '_draft', reason: 'Fix it' });
  const row = await kit.ok('GET', `/docs/capex/${doc.id}`, (await login(ADMIN)).token) as { workflow: { status: string; stages: { key: string; status: string }[] } | null };
  expect(row.workflow?.stages.find(s => s.key === 'hod')?.status ?? 'none', 'API marks HOD done').not.toBe('done');
  await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
  await page.goto(`/docs/capex/${doc.id}`);
  await expect(page.getByTestId('wf-stage-hod')).not.toHaveAttribute('data-state', 'done', { timeout: 5_000 });
});

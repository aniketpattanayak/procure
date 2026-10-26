/**
 * J4 — Capex workflow, the brief's line-level approval journey (desktop):
 * indenter creates a 5-line Capex request in the UI (live line amounts + header total) and submits it (number from
 * the Pune series CPX-PUN/…); the HOD approver, in ONE action, approves lines 1–2, holds 3, rejects 4 and approves
 * 200 of 300 on line 5 (reasons for hold/reject/reduction, keyboard shortcuts on rows 1–2); statuses, quantity
 * buckets (detail + item-wise list), timeline sentences and inbox counts are checked; then line 3 is released and
 * approved → partially approved; the ledger (owner DB) matches requested/approved/held/rejected per line.
 */
import { expect, test, Ui } from './support/fixtures';
import { ADMIN, APPROVER, fillCapexForm, INDENTER, inr, ledger, login } from './support/phase3';
import { kit } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const LINES = [
  { item: /MS Plate/, qty: '100', est_rate: '100' },
  { item: /Copper Wire/, qty: '100', est_rate: '100' },
  { item: /Aluminium Sheet/, qty: '100', est_rate: '100' },
  { item: /Corrugated Carton/, qty: '100', est_rate: '100' },
  { item: /MS Plate/, qty: '300', est_rate: '100' }, // a repeat item: Cotton Waste may have been deactivated by J3
];

test('J4: 5-line Capex — one decision approves 1–2, holds 3, rejects 4, approves 200/300 on 5; unhold → partially approved', async ({ page, browser }) => {
  const ui = new Ui(page);
  let number = '';
  let docId = '';

  await test.step('indenter raises a 5-line request: live amounts and total', async () => {
    await ui.tenantLogin('acme', INDENTER.email, INDENTER.password);
    await ui.nav('nav-docs-capex');
    await page.getByTestId('doc-new').click();
    await page.waitForURL(/\/docs\/capex\/new/);
    await fillCapexForm(page, { purpose: 'J4 line approvals — new design cell', lines: LINES });
    // live line amounts and header total (qty × est_rate, SUM(lines.amount))
    await expect(page.getByTestId('field-lines-4-amount-input')).toContainText('30,000.00');
    await expect(page.getByTestId('field-lines-0-amount-input')).toContainText('10,000.00');
    await expect(page.getByTestId('field-total_amount-input')).toContainText(inr(70000));
    await expect(page.getByTestId('doc-total')).toContainText('70,000');
    // change one qty → amounts follow before saving
    await page.getByTestId('field-lines-4-qty-input').fill('301');
    await expect(page.getByTestId('field-lines-4-amount-input')).toContainText('30,100.00');
    await expect(page.getByTestId('field-total_amount-input')).toContainText(inr(70100));
    await page.getByTestId('field-lines-4-qty-input').fill('300');
    await expect(page.getByTestId('field-total_amount-input')).toContainText(inr(70000));

    await page.getByTestId('doc-submit').click();
    const dlg = page.getByTestId('submit-dialog');
    if (await dlg.isVisible().catch(() => false)) await dlg.getByRole('button', { name: /submit/i }).last().click();
    await expect(page.getByTestId('doc-number')).toHaveText(/^CPX-PUN\/\d\d-\d\d\/\d{4}$/, { timeout: 20_000 });
    number = (await page.getByTestId('doc-number').innerText()).trim();
    docId = page.url().match(/\/docs\/capex\/([0-9a-f-]{36})/)![1]!;
    await expect(page.getByTestId('wf-progress')).toBeVisible();
    await expect(page.getByTestId('wf-stage-hod')).toHaveAttribute('data-state', /active|current/);
    // HOD only (₹70,000 ≤ 1 lakh): finance and director skipped
    await expect(page.getByTestId('wf-stage-finance')).toHaveAttribute('data-state', /skipped/);
    await expect(page.getByTestId('wf-stage-director')).toHaveAttribute('data-state', /skipped/);
    for (let n = 1; n <= 5; n++) await expect(page.getByTestId(`qty-pending-${n}`)).toHaveText(n === 5 ? '300' : '100');
  });

  const actx = await browser.newContext();
  const ap = await actx.newPage();
  const aui = new Ui(ap);
  let inboxBefore = 0;

  await test.step('approver: inbox shows the document with a count; opens the approval screen', async () => {
    await aui.tenantLogin('acme', APPROVER.email, APPROVER.password);
    const counts = (await kit.ok('GET', '/approvals/counts', (await login(APPROVER)).token)) as { byType: { docTypeKey: string; stageKey: string; count: number }[] };
    inboxBefore = counts.byType.find(b => b.docTypeKey === 'capex' && b.stageKey === 'hod')?.count ?? 0;
    await aui.nav('nav-approvals');
    await expect(ap.getByTestId('inbox-list')).toBeVisible();
    await expect(ap.getByTestId('inbox-filter-capex-hod')).toHaveAttribute('data-count', String(inboxBefore));
    await ap.getByTestId(`inbox-row-${number}`).click();
    await ap.waitForURL(/\/docs\/capex\/.+/);
    if (!/\/approve/.test(ap.url())) await ap.getByTestId('doc-approve').click();
    await expect(ap.getByTestId('approve-screen')).toHaveAttribute('data-stage', 'hod');
    await expect(ap.getByTestId('approve-screen')).toHaveAttribute('data-granularity', 'line');
  });

  await test.step('one action: keyboard a/j/a on rows 1–2, hold 3, reject 4, reduce 5 to 200 — reasons required', async () => {
    // keyboard: focus row 1, 'a' approves it, 'j' moves down, 'a' approves row 2
    await ap.getByTestId('decision-row-1').click({ position: { x: 5, y: 5 } });
    await ap.keyboard.press('a');
    await ap.keyboard.press('j');
    await ap.keyboard.press('a');
    await expect(ap.getByTestId('decision-row-1')).toHaveAttribute('data-outcome', 'approve');
    await expect(ap.getByTestId('decision-row-2')).toHaveAttribute('data-outcome', 'approve');
    await ap.getByTestId('decision-3-set-hold').click();
    await ap.getByTestId('decision-4-set-reject').click();
    await ap.getByTestId('decision-5-approve').fill('200');
    await expect(ap.getByTestId('decision-row-3')).toHaveAttribute('data-outcome', 'hold');
    await expect(ap.getByTestId('decision-row-4')).toHaveAttribute('data-outcome', 'reject');
    await expect(ap.getByTestId('decision-row-5')).toHaveAttribute('data-outcome', /reduce|mixed/);
    // without reasons the submit is blocked, the three lines are flagged
    await ap.getByTestId('decision-submit').click();
    await expect(ap.getByTestId('decision-errors')).toBeVisible();
    for (const n of [3, 4, 5]) await expect(ap.getByTestId(`decision-${n}-error`)).toBeVisible();
    await ap.getByTestId('decision-3-reason').fill('Check budget head first');
    await ap.getByTestId('decision-4-reason').fill('Duplicate of last month');
    await ap.getByTestId('decision-5-reason').fill('Only 200 needed this quarter');
    await expect(ap.getByTestId('decision-errors')).toHaveCount(0);
    await ap.getByTestId('decision-submit').click();
    // stays on the approval screen while held qty remains, or returns to the detail page
    await expect(ap.getByTestId('unhold-panel').or(ap.getByTestId('doc-number'))).toBeVisible({ timeout: 20_000 });
  });

  await test.step('the restricted indenter (views draft/rejected/waiting_hod) no longer sees the on-hold document', async () => {
    await page.reload();
    await expect(page.getByTestId('doc-number')).toHaveCount(0);
    await expect(page.locator('main')).toContainText(/not found|no access|don.t have access|doesn.t exist/i);
  });

  // The admin (all views) checks the outcome.
  const adm = await browser.newContext();
  const page2 = await adm.newPage();
  await new Ui(page2).tenantLogin('acme', ADMIN.email, ADMIN.password);

  await test.step('statuses, buckets (detail + item-wise), timeline sentence, inbox counts', async () => {
    const page = page2;
    await page.goto(`/docs/capex/${docId}`);
    await expect(page.getByTestId('doc-number')).toHaveText(number);
    await page.getByTestId('doc-tab-lines').click();
    const want: Record<number, [string, string, string, string, string]> = {
      // requested, approved, held, rejected, pending
      1: ['100', '100', '0', '0', '0'], 2: ['100', '100', '0', '0', '0'], 3: ['100', '0', '100', '0', '100'], 4: ['100', '0', '0', '100', '0'], 5: ['300', '200', '0', '100', '0'],
    };
    for (const [n, [rq, ap_, h, rj, p]] of Object.entries(want)) {
      await expect(page.getByTestId(`qty-requested-${n}`)).toHaveText(rq);
      await expect(page.getByTestId(`qty-approved-${n}`)).toHaveText(ap_);
      await expect(page.getByTestId(`qty-held-${n}`)).toHaveText(h);
      await expect(page.getByTestId(`qty-rejected-${n}`)).toHaveText(rj);
      await expect(page.getByTestId(`qty-pending-${n}`)).toHaveText(p);
    }
    await expect(page.getByTestId('doc-line-3')).toContainText(/on hold/i);
    await expect(page.getByTestId('doc-line-4')).toContainText(/rejected/i);
    await expect(page.getByTestId('doc-line-5')).toContainText(/partially approved/i);
    await expect(page.getByTestId('wf-progress')).toHaveAttribute('data-status', /hold|running|on_hold/);

    await page.getByTestId('doc-tab-timeline').click();
    const tl = page.getByTestId('timeline');
    await expect(tl.getByTestId('timeline-entry').filter({ hasText: 'Approved 3 lines, held 1, rejected 2 at HOD approval' })).toHaveCount(1);
    await expect(tl.getByTestId('timeline-decisions').first()).toContainText('Only 200 needed this quarter');
    await expect(tl.getByTestId('timeline-entry').filter({ hasText: /Submitted as CPX-PUN/ })).toHaveCount(1);

    // item-wise list: status filter on_hold shows line 3 with its held qty
    await page.goto('/docs/capex?view=item');
    await expect(page.getByTestId(`doc-row-${number}-3`)).toBeVisible();
    await expect(page.getByTestId(`qty-held-${number}-3`)).toHaveText('100');
    await expect(page.getByTestId(`qty-approved-${number}-5`)).toHaveText('200');
    await expect(page.getByTestId(`qty-rejected-${number}-5`)).toHaveText('100');
    await expect(page.getByTestId(`qty-pending-${number}-1`)).toHaveText('0');

    // inbox: still listed (line 3 held at HOD) with 1 held line
    const inbox = (await kit.ok('GET', '/approvals', (await login(APPROVER)).token)) as { data: { documentId: string; heldLines: number; pendingLines: number }[] };
    expect(inbox.data.find(i => i.documentId === docId)).toMatchObject({ heldLines: 1, pendingLines: 0 });
  });

  await test.step('release line 3 and approve it → partially approved; ledger matches', async () => {
    await ap.goto(`/docs/capex/${docId}/approve?stage=hod`);
    await expect(ap.getByTestId('held-row-3')).toBeVisible();
    await ap.getByTestId('unhold-3').click();
    await expect(ap.getByTestId('decision-row-3')).toBeVisible({ timeout: 15_000 });
    await expect(ap.getByTestId('qty-pending-3')).toHaveText('100');
    await ap.getByTestId('decision-3-set-approve').click();
    await ap.getByTestId('decision-submit').click();
    await ap.waitForURL(new RegExp(`/docs/capex/${docId}$`), { timeout: 20_000 });
    await expect(ap.getByTestId('doc-number')).toHaveText(number);

    const page = page2;
    await page.goto(`/docs/capex/${docId}`);
    await expect(page.getByTestId('wf-progress')).toHaveAttribute('data-status', /partially_approved|completed/);
    await expect(page.locator('main')).toContainText(/Partially approved/);
    const counts = (await kit.ok('GET', '/approvals/counts', (await login(APPROVER)).token)) as { byType: { docTypeKey: string; stageKey: string; count: number }[] };
    expect(counts.byType.find(b => b.docTypeKey === 'capex' && b.stageKey === 'hod')?.count ?? 0).toBe(inboxBefore - 1);
    const L = await ledger(docId);
    expect(L.map(l => [l.line_no, Number(l.requested), Number(l.approved), Number(l.held), Number(l.rejected), Number(l.cancelled)])).toEqual([
      [1, 100, 100, 0, 0, 0], [2, 100, 100, 0, 0, 0], [3, 100, 100, 0, 0, 0], [4, 100, 0, 0, 100, 0], [5, 300, 200, 0, 100, 0],
    ]);
    const row = (await kit.ok('GET', `/docs/capex/${docId}`, (await login(INDENTER)).token).catch(() => null)) as { statusKey: string } | null;
    // the indenter may not hold the partially_approved view (seed: draft, rejected, waiting_hod) → hidden
    expect(row).toBeNull();
  });
  await actx.close();
  await adm.close();
});

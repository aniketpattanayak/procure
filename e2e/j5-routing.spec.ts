/**
 * J5 — Capex amount routing on the seeded workflow (HOD → Finance when total > ₹1 lakh → Director when ≥ ₹5 lakh):
 * three requests (₹50,000 / ₹2,00,000 / ₹6,00,000) take the expected routes; the Finance review is done by a
 * Buyer-role user created for the test; the Director (acme admin) decides with one outcome for the whole document;
 * and the designer's simulation reports the same route for the same values as the real runs.
 */
import { expect, kit, test, Ui } from './support/fixtures';
import { ADMIN, APPROVER, apiCapex, financeUser, INDENTER, login, typeInto } from './support/phase3';

test.describe.configure({ mode: 'serial' });

type Doc = { id: string; number: string; statusKey: string; workflow: { stages: { key: string; status: string }[] } };
const CASES = [
  { label: '₹50,000', qty: '10', rate: '5000', route: { hod: 'run', finance: 'skipped_condition', director: 'skipped_condition' } },
  { label: '₹2,00,000', qty: '20', rate: '10000', route: { hod: 'run', finance: 'run', director: 'skipped_condition' } },
  { label: '₹6,00,000', qty: '60', rate: '10000', route: { hod: 'run', finance: 'run', director: 'run' } },
] as const;

test('J5: routing by amount — HOD only / + Finance (Buyer user) / + Director (one outcome); simulation matches', async ({ page, browser }) => {
  const docs: Doc[] = [];
  const fin = await financeUser();
  const finCount = async () => ((await kit.ok('GET', '/approvals/counts', (await login(fin)).token)) as { byType: { stageKey: string; count: number }[] }).byType.find(b => b.stageKey === 'finance')?.count ?? 0;
  const finBefore = await finCount();

  await test.step('three submitted requests start with the expected stage states', async () => {
    for (const c of CASES) docs.push(await apiCapex(INDENTER, [{ qty: c.qty, est_rate: c.rate }], { purpose: `J5 ${c.label}` }) as Doc);
    for (const [i, c] of CASES.entries()) {
      const st = Object.fromEntries(docs[i]!.workflow.stages.map(s => [s.key, s.status]));
      expect(st, c.label).toEqual({ hod: 'active', finance: c.route.finance === 'run' ? 'pending' : 'skipped', director: c.route.director === 'run' ? 'pending' : 'skipped' });
      expect(docs[i]!.statusKey).toBe('waiting_hod');
      expect(docs[i]!.number).toMatch(/^CPX-PUN\//);
    }
  });

  await test.step('designer simulation: same values → same route as the real documents', async () => {
    await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
    await page.goto('/config/workflows/capex');
    await expect(page.getByTestId('wf-designer')).toBeVisible();
    await page.getByTestId('wf-simulate').click();
    const drawer = page.getByTestId('wf-sim-drawer');
    await expect(drawer).toBeVisible();
    await drawer.getByTestId('wf-sim-source-published').check({ force: true });
    await expect(drawer.getByTestId('wf-sim-source-published')).toBeChecked();
    for (const c of CASES) {
      await typeInto(drawer.getByTestId('field-lines-0-qty-input'), c.qty);
      await typeInto(drawer.getByTestId('field-lines-0-est_rate-input'), c.rate);
      await expect(drawer.getByTestId('field-total_amount-input')).toContainText((Number(c.qty) * Number(c.rate)).toLocaleString('en-IN'));
      await drawer.getByTestId('wf-sim-run').click();
      await expect(drawer.getByTestId('wf-sim-result')).toBeVisible();
      for (const [k, outcome] of Object.entries(c.route)) {
        await expect(drawer.getByTestId(`wf-sim-result-${k}`), `${c.label} ${k}`).toHaveAttribute('data-outcome', outcome);
        await expect(page.getByTestId(`wf-stage-${k}`)).toHaveAttribute('data-sim', outcome);
      }
    }
    // the API simulation agrees when given the computed total (it does not evaluate formulas itself: QA3-BUG-009,
    // apps/api/test/qa-phase3-integrity.test.ts)
    const admin = await login(ADMIN);
    for (const c of CASES) {
      const total = String(Number(c.qty) * Number(c.rate));
      const r = await kit.ok('POST', '/config/workflows/capex/simulate', admin.token, { values: { total_amount: total }, lines: [{ qty: c.qty, est_rate: c.rate, amount: total }], useDraft: false }) as { stages: { key: string; outcome: string }[] };
      expect(Object.fromEntries(r.stages.map(s => [s.key, s.outcome])), c.label).toEqual(c.route);
    }
  });

  await test.step('HOD approves all three in the UI (apply to all)', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await new Ui(p).tenantLogin('acme', APPROVER.email, APPROVER.password);
    for (const d of docs) {
      await p.goto(`/docs/capex/${d.id}/approve?stage=hod`);
      await expect(p.getByTestId('approve-screen')).toHaveAttribute('data-stage', 'hod');
      await p.getByTestId('decision-1-set-approve').click();
      await p.getByTestId('decision-submit').click();
      await p.waitForURL(new RegExp(`/docs/capex/${d.id}$`));
    }
    await ctx.close();
    const admin = await login(ADMIN);
    const st = await Promise.all(docs.map(d => kit.ok('GET', `/docs/capex/${d.id}`, admin.token) as Promise<Doc>));
    expect(st.map(d => d.statusKey)).toEqual(['approved', 'waiting_finance', 'waiting_finance']);
  });

  await test.step('Finance (Buyer-role user) sees exactly the two > ₹1 lakh documents and approves them', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await new Ui(p).tenantLogin('acme', fin.email, fin.password);
    await p.goto('/approvals');
    await expect(p.getByTestId('inbox-list')).toBeVisible();
    await expect(p.getByTestId(`inbox-row-${docs[0]!.number}`)).toHaveCount(0);
    for (const d of docs.slice(1)) await expect(p.getByTestId(`inbox-row-${d.number}`)).toBeVisible();
    await expect(p.getByTestId('inbox-filter-capex-finance')).toHaveAttribute('data-count', String(finBefore + 2));
    for (const d of docs.slice(1)) {
      await p.goto(`/docs/capex/${d.id}/approve?stage=finance`);
      await expect(p.getByTestId('approve-screen')).toHaveAttribute('data-stage', 'finance');
      // Finance review allows approve/reject/send back only: hold is disabled (button and qty input)
      await expect(p.getByTestId('decision-1-set-hold')).toBeDisabled();
      await expect(p.getByTestId('decision-1-hold')).toBeDisabled();
      await p.getByTestId('decision-1-set-approve').click();
      await p.getByTestId('decision-submit').click();
      await p.waitForURL(new RegExp(`/docs/capex/${d.id}$`));
    }
    await ctx.close();
    expect(await finCount()).toBe(finBefore);
    const admin = await login(ADMIN);
    const st = await Promise.all(docs.map(d => kit.ok('GET', `/docs/capex/${d.id}`, admin.token) as Promise<Doc>));
    expect(st.map(d => d.statusKey)).toEqual(['approved', 'approved', 'waiting_director']);
  });

  await test.step('Director (acme admin) decides the ₹6 lakh request with one outcome for the whole document', async () => {
    // The seed calls this "document granularity", but granularity is a workflow-level setting (schema) and the
    // Capex workflow is 'line'; the director gives one outcome through "apply to all" (UI) / `outcome` (API).
    await page.goto(`/docs/capex/${docs[2]!.id}/approve?stage=director`);
    await expect(page.getByTestId('approve-screen')).toHaveAttribute('data-stage', 'director');
    await page.getByTestId('decision-select-all').click();
    await page.getByTestId('decision-apply-all-approve').click();
    await expect(page.getByTestId('decision-row-1')).toHaveAttribute('data-outcome', 'approve');
    await page.getByTestId('decision-submit').click();
    await page.waitForURL(new RegExp(`/docs/capex/${docs[2]!.id}$`));
    await expect(page.getByTestId('wf-stage-director')).toHaveAttribute('data-state', /done/);
    await expect(page.locator('main')).toContainText('Approved');
    const tl = await kit.ok('GET', `/docs/capex/${docs[2]!.id}/timeline`, (await login(ADMIN)).token) as { kind: string; title: string }[];
    const titles = tl.filter(e => e.kind === 'workflow').map(e => e.title);
    expect(titles).toEqual(expect.arrayContaining(['Approved 1 line at HOD approval', 'Approved 1 line at Finance review', 'Approved 1 line at Director approval', 'Workflow completed']));
  });
});

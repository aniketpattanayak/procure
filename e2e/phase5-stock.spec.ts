/**
 * Phase 5 stock journeys (web): receive a partial GRN against the seeded PO → run it through the verification chain →
 * stock rises; issue against the seeded issue request → return part of it → ledger shows the movements.
 * Workflow decisions go through the API (the approval screen itself is covered by the Phase 3 journeys).
 */
import { SEED } from './support/env';
import { expect, kit, test } from './support/fixtures';

type Line = { id: string; lineNo: number; stages: Record<string, { pending: string; held: string }> };
type Doc = { id: string; number: string | null; statusKey: string; lines: Line[] };

async function adminToken() {
  return (await kit.tenantLogin(SEED.acme.code, SEED.acme.email, SEED.acme.password)).token;
}

/**
 * Submitters cannot approve their own documents, so decisions are taken by the seeded approver (scope Pune Plant +
 * below), whose role gets view + every stage key + every status view the admin holds on these document tabs.
 */
let approver: string | null = null;
async function approverToken(admin: string) {
  if (approver) return approver;
  const me = await kit.ok<{ permissions: { keys: string[] } }>('GET', '/auth/me', admin);
  const roles = await kit.ok<{ id: string; name: string }[] | { data: { id: string; name: string }[] }>('GET', '/roles', admin);
  const role = (Array.isArray(roles) ? roles : roles.data).find(r => r.name === 'Approver');
  if (!role) throw new Error('seeded Approver role not found');
  for (const tab of ['doc.grn', 'doc.store_issue', 'doc.store_return']) {
    const keys = me.permissions.keys.filter(k => k.startsWith(`${tab}:`) && (k.includes(':view.') || k.endsWith(':action.view') || k.includes(':action.stage_')));
    await kit.ok('PUT', `/roles/${role.id}/permissions/tabs/${tab}`, admin, { actions: keys.filter(k => k.includes(':action.')), views: keys.filter(k => k.includes(':view.')), fieldAccess: [] });
  }
  approver = (await kit.tenantLogin(SEED.acme.code, 'approver@acme.test', 'Approve@12345')).token;
  return approver;
}

/** Approve every pending line at whatever stage it waits, until nothing is pending (max 6 rounds). */
async function approveAll(admin: string, type: string, id: string): Promise<Doc> {
  const token = await approverToken(admin);
  let doc = await kit.ok<Doc>('GET', `/docs/${type}/${id}`, token);
  for (let round = 0; round < 6; round++) {
    const byStage = new Map<string, { lineId: string; approve: string }[]>();
    for (const l of doc.lines) for (const [stage, s] of Object.entries(l.stages ?? {})) if (Number(s.pending) > 0) byStage.set(stage, [...(byStage.get(stage) ?? []), { lineId: l.id, approve: s.pending }]);
    if (!byStage.size) break;
    for (const [stageKey, decisions] of byStage) doc = await kit.ok<Doc>('POST', `/docs/${type}/${id}/actions`, token, { action: 'decide', stageKey, decisions });
  }
  return doc;
}

async function available(token: string, itemId: string): Promise<number> {
  const s = await kit.ok<{ totals: { available: string } }>('GET', `/stock/items/${itemId}/summary`, token);
  return Number(s.totals.available);
}

test.describe('Phase 5 stock', () => {
  test('receive a partial GRN against a PO, verify it, stock rises', async ({ page, ui }) => {
    const token = await adminToken();
    const lines = await kit.ok<{ data: { poLineId: string; poNumber: string; lineNo: number; pendingReceipt: string; item: { id: string; code: string } }[] }>('GET', '/inventory/receivable-po-lines', token);
    const line = lines.data.find(l => Number(l.pendingReceipt) >= 2);
    test.skip(!line, 'seed has no receivable PO line');
    const before = await available(token, line!.item.id);
    const k = `${line!.poNumber}-${line!.lineNo}`;

    await ui.tenantLogin(SEED.acme.code, SEED.acme.email, SEED.acme.password);
    await page.goto('/stock/receive');
    await page.getByTestId(`grn-pick-${k}`).click();
    // Default qty = pending; receive a partial quantity instead.
    await expect(page.getByTestId(`grn-qty-${k}`)).toHaveValue(String(Number(line!.pendingReceipt)));
    await page.getByTestId(`grn-qty-${k}`).fill('1');
    await page.getByTestId('grn-create-submit').click();
    await page.waitForURL(/\/docs\/grn\/[0-9a-f-]{36}$/);
    const grnId = page.url().split('/').pop()!;
    await expect(page.getByTestId('grn-po-ordered-1').first()).toBeVisible();

    const done = await approveAll(token, 'grn', grnId);
    expect(['approved', 'partially_approved']).toContain(done.statusKey);
    expect(await available(token, line!.item.id)).toBe(before + 1);

    // Balances grid → item drawer shows the new total; the ledger lists the receipt for this GRN.
    await page.goto(`/stock?q=${encodeURIComponent(line!.item.code)}`);
    await page.getByTestId('stock-search').fill(line!.item.code);
    await page.getByTestId('stock-balances').getByText(line!.item.code).first().click();
    await expect(page.getByTestId('summary-available')).toHaveAttribute('data-value', String(before + 1));
    await page.goto(`/stock/ledger?document=${grnId}`);
    await expect(page.getByTestId('stock-ledger').getByText(done.number!).first()).toBeVisible();
  });

  test('issue against a request, return part of it, ledger shows both', async ({ page, ui }) => {
    const token = await adminToken();
    const issuable = await kit.ok<{ data: { requestNumber: string; lineNo: number; pendingIssue: string; available: string; item: { id: string } }[] }>('GET', '/inventory/issuable-lines', token);
    const line = issuable.data.find(l => Number(l.pendingIssue) >= 3 && Number(l.available) >= 3);
    test.skip(!line, 'seed has no issuable request line with stock');
    const before = await available(token, line!.item.id);
    const k = `${line!.requestNumber}-${line!.lineNo}`;

    await ui.tenantLogin(SEED.acme.code, SEED.acme.email, SEED.acme.password);
    await page.goto('/stock/issue');
    await page.getByTestId(`issue-pick-${k}`).click();
    await page.getByTestId(`issue-qty-${k}`).fill('3');
    await page.getByTestId('issue-create-submit').click();
    await page.waitForURL(/\/docs\/store_issue\/[0-9a-f-]{36}$/);
    const issueId = page.url().split('/').pop()!;
    const issue = await approveAll(token, 'store_issue', issueId);
    expect(await available(token, line!.item.id)).toBe(before - 3);

    await page.goto(`/stock/return?issue=${issueId}`);
    const rk = `${issue.number}-1`;
    await page.getByTestId(`return-pick-${rk}`).click();
    await page.getByTestId(`return-qty-${rk}`).fill('2');
    await page.getByTestId('return-create-submit').click();
    await page.waitForURL(/\/docs\/store_return\/[0-9a-f-]{36}$/);
    const returnId = page.url().split('/').pop()!;
    await approveAll(token, 'store_return', returnId);
    expect(await available(token, line!.item.id)).toBe(before - 1);

    await page.goto(`/stock/ledger?item=${line!.item.id}`);
    await expect(page.getByTestId('stock-ledger').getByText(issue.number!).first()).toBeVisible();
    await page.goto(`/docs/store_return/${returnId}?tab=stock-movements`);
    await page.getByTestId('doc-tab-stock-movements').click();
    await expect(page.getByTestId('doc-stock-movements')).toBeVisible();
  });
});

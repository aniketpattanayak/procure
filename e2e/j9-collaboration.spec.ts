/**
 * J9 — collaboration on a document (desktop): the HOD comments with an @mention of the indenter; the indenter gets a
 * notification that opens the document; the admin attaches a file; the timeline shows the comment and the attachment
 * next to the workflow entries.
 */
import { expect, kit, test, Ui } from './support/fixtures';
import { ADMIN, APPROVER, apiCapex, INDENTER, login } from './support/phase3';
import { multipart, png } from './support/phase2';

test.describe.configure({ mode: 'serial' });
type Doc = { id: string; number: string };

test('J9: @mention → notification opens the document; attachment; timeline shows both', async ({ page, browser }) => {
  const doc = await apiCapex(INDENTER, [{ qty: '3', est_rate: '900' }], { purpose: 'J9 collaboration' }) as Doc;

  await test.step('HOD comments with an @mention', async () => {
    await new Ui(page).tenantLogin('acme', APPROVER.email, APPROVER.password);
    await page.goto(`/docs/capex/${doc.id}`);
    await page.getByTestId('doc-tab-comments').click();
    const input = page.getByTestId('comment-input');
    await input.click();
    await input.pressSequentially('Please confirm the vendor, @Indent');
    await page.getByTestId('mention-option').filter({ hasText: 'Indent Clerk' }).first().click();
    await input.pressSequentially(' thanks');
    await page.getByTestId('comment-submit').click();
    const c = page.getByTestId('comment').last();
    await expect(c).toContainText('Please confirm the vendor');
    await expect(c.getByTestId('mention-chip')).toContainText('Indent Clerk');
  });

  await test.step('the indenter gets a mention notification that opens the document', async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await new Ui(p).tenantLogin('acme', INDENTER.email, INDENTER.password);
    await p.getByTestId('notifications-bell').click();
    const n = p.getByText(/mentioned you/i).first();
    await expect(n).toBeVisible();
    await n.click();
    await p.waitForURL(new RegExp(`/docs/capex/${doc.id}`));
    await expect(p.getByTestId('notifications-panel')).toBeHidden(); // QA3-BUG-012 fixed
    await expect(p.getByTestId('doc-number')).toHaveText(doc.number);
    await p.getByTestId('doc-tab-comments').click();
    await expect(p.getByTestId('comment').filter({ hasText: 'Please confirm the vendor' })).toBeVisible();
    await ctx.close();
    const notes = await kit.notifications((await login(INDENTER)).token);
    expect(notes.data.find((x: { kind: string }) => x.kind === 'mention')).toMatchObject({ link: `/docs/capex/${doc.id}` });
  });

  await test.step('admin attaches a file (API: the UI upload is QA3-BUG-014); timeline shows comment, attachment and workflow entries', async () => {
    const admin = await login(ADMIN);
    const up = await multipart('/files', admin.token, { name: 'quote.png', body: png(40, 30), type: 'image/png' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    await kit.ok('POST', `/docs/capex/${doc.id}/attachments`, admin.token, { fileId: up.body.id, note: 'Vendor quote' }, 201);
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await new Ui(p).tenantLogin('acme', ADMIN.email, ADMIN.password);
    await p.goto(`/docs/capex/${doc.id}`);
    await p.getByTestId('doc-tab-attachments').click();
    await expect(p.getByTestId('attachment-row').filter({ hasText: 'quote.png' })).toBeVisible({ timeout: 20_000 });
    await p.getByTestId('doc-tab-timeline').click();
    const tl = p.getByTestId('timeline');
    await expect(tl.getByTestId('timeline-entry').filter({ hasText: 'Attached quote.png' })).toBeVisible();
    await expect(tl.getByTestId('timeline-entry').filter({ hasText: 'Commented' })).toContainText('Please confirm the vendor');
    await expect(tl.getByTestId('timeline-entry').filter({ hasText: 'Entered the workflow' })).toBeVisible();
    const kinds = await tl.getByTestId('timeline-entry').evaluateAll(els => els.map(e => e.getAttribute('data-kind')));
    expect(kinds).toEqual(expect.arrayContaining(['attachment', 'comment', 'workflow', 'submitted', 'created']));
    expect(kinds[0]).toBe('attachment'); // newest first
    await ctx.close();
  });
});

// QA3-BUG-014 (fixed): the document attachments panel (and the create form's attachments drop zone) used to upload
// with `fieldKey: 'attachments'` but no `formKey`; POST /files answered 400 "formKey is required with fieldKey".
// uploadFile now sends a field key only together with its form key.
test('[QA3-BUG-014] attach a file to a document from the Attachments tab', async ({ page }) => {
  const doc = await apiCapex(INDENTER, [{ qty: '1', est_rate: '100' }], { purpose: 'J9 UI attachment' }) as Doc;
  await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
  await page.goto(`/docs/capex/${doc.id}`);
  await page.getByTestId('doc-tab-attachments').click();
  const uploads: number[] = [];
  page.on('response', r => { if (r.url().endsWith('/api/v1/files') && r.request().method() === 'POST') uploads.push(r.status()); });
  await page.getByTestId('upload-input-attachments').setInputFiles({ name: 'quote.png', mimeType: 'image/png', buffer: png(40, 30) });
  await expect.poll(() => uploads.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(uploads[0], 'POST /files status').toBe(201);
  await page.getByTestId('attach-save').click({ timeout: 5_000 });
  await expect(page.getByTestId('attachment-row').filter({ hasText: 'quote.png' })).toBeVisible({ timeout: 10_000 });
});

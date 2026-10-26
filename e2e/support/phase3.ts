/**
 * Phase 3 E2E helpers: seed sessions (admin, indenter, approver) through the API, a Finance (Buyer-role) user, Capex
 * documents raised through the API for setup, the documents UI (create form with lines, approval screen) and
 * owner-DB reads for ledger assertions.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { SEED } from './env';
import { kit, uniq } from './fixtures';
import { ownerQuery, pickLookup } from './phase2';

export const INDENTER = { email: 'indenter@acme.test', password: 'Indent@12345', name: 'Indent Clerk' };
export const APPROVER = { email: 'approver@acme.test', password: 'Approve@12345', name: 'Hema HOD' };
export const ADMIN = { email: SEED.acme.email, password: SEED.acme.password, name: 'Acme Admin' };
export const FINANCE_PASSWORD = 'Finance@12345';

export type Creds = { email: string; password: string; name?: string };
export const login = (c: Creds) => kit.tenantLogin('acme', c.email, c.password);

export interface Ids { pune: string; puneMain: string; chennai: string; items: Record<string, string>; roles: Record<string, string>; users: Record<string, string> }

let ids: Ids | null = null;
/** Seed ids by code/key (cached per run; the seed is deterministic after global setup). */
export async function seedIds(): Promise<Ids> {
  if (ids) return ids;
  const loc = await ownerQuery<{ code: string; id: string }>(`select n.code, n.id from app.location_node n join platform.tenant t on t.id = n.tenant_id where t.code = 'acme'`);
  const items = await ownerQuery<{ code: string; id: string }>(`select r.code, r.id from app.master_record r join app.master_def d on d.id = r.master_id join platform.tenant t on t.id = r.tenant_id where t.code = 'acme' and d.key = 'item'`);
  const roles = await ownerQuery<{ key: string; id: string }>(`select r.key, r.id from app.role r join platform.tenant t on t.id = r.tenant_id where t.code = 'acme' and not r.is_deleted`);
  const users = await ownerQuery<{ email: string; id: string }>(`select u.email, u.id from app.tenant_user u join platform.tenant t on t.id = u.tenant_id where t.code = 'acme'`);
  const by = <T extends Record<string, string>>(rows: T[], k: keyof T) => Object.fromEntries(rows.map(r => [r[k], r.id]));
  const l = by(loc, 'code');
  ids = { pune: l.PUNE!, puneMain: l['PUNE-MAIN']!, chennai: l.CHENNAI!, items: by(items, 'code'), roles: by(roles, 'key'), users: by(users, 'email') };
  return ids;
}
export function resetIdCache() { ids = null; }

/** Creates (once per run) an active user with the given role(s); returns credentials. */
export async function userWithRoles(roleKeys: string[], label: string, password = FINANCE_PASSWORD): Promise<Creds & { id: string }> {
  const admin = await login(ADMIN);
  const i = await seedIds();
  const email = `${uniq(label.toLowerCase().replace(/\W+/g, '-'))}@acme.test`;
  const u = await kit.user(admin.token, { name: `${label} ${email.slice(-6, -10)}`.trim(), email, roleIds: roleKeys.map(k => i.roles[k]!) });
  const first = await kit.tenantLogin('acme', u.email, u.temporaryPassword);
  await kit.changePassword(first, u.temporaryPassword, password);
  return { id: u.id, email: u.email, password, name: u.name };
}

let finance: (Creds & { id: string }) | null = null;
/** A Buyer-role user (the seed has none) = the Capex "Finance review" actor. */
export async function financeUser() {
  finance ??= await userWithRoles(['buyer'], 'Finance');
  return finance;
}

export interface CapexLine { item?: string; qty: string; est_rate: string; remarks?: string }
/** Creates (and optionally submits) a Capex request through the API as `who`. */
export async function apiCapex(who: Creds, lines: CapexLine[], opts: { location?: 'pune' | 'chennai' | 'puneMain'; submit?: boolean; purpose?: string } = {}) {
  const s = await login(who);
  const i = await seedIds();
  const codes = ['ITM-00001', 'ITM-00002', 'ITM-00003', 'ITM-00004', 'ITM-00005'];
  const body = {
    values: { location: i[opts.location ?? 'pune'], purpose: opts.purpose ?? 'E2E capex', priority: 'Normal' },
    lines: lines.map((l, n) => ({ values: { item: l.item ?? i.items[codes[n % codes.length]!], qty: l.qty, est_rate: l.est_rate, ...(l.remarks ? { remarks: l.remarks } : {}) } })),
  };
  const d = await kit.ok('POST', '/docs/capex', s.token, body, 201);
  if (opts.submit === false) return d;
  return kit.ok('POST', `/docs/capex/${d.id}/submit`, s.token, { version: d.version });
}

/** Ledger buckets per line straight from line_qty_summary (owner role). */
export async function ledger(docId: string) {
  return ownerQuery<{ line_no: number; requested: string; approved: string; held: string; rejected: string; cancelled: string }>(
    `select l.line_no, s.requested::text, s.approved::text, s.held::text, s.rejected::text, s.cancelled::text
       from app.document_line l join app.line_qty_summary s on s.line_id = l.id
      where l.document_id = $1 and not l.is_deleted order by l.line_no`, [docId]);
}
export const n4 = (v: string) => Number(v);

// ------------------------------------------------------------------ UI

/**
 * Replaces the value of a renderer number/currency input the way a keyboard user does (focus, select all, type).
 * Playwright's fill() selects BEFORE the input's focus handler swaps the formatted text ("5,000.00") for the raw one,
 * so the selection collapses and the new text is appended ("5000.0010000"). Tab/Shift+Tab and Ctrl+A work for users.
 */
export async function typeInto(l: Locator, text: string) {
  await l.focus();
  await l.press('ControlOrMeta+A');
  await l.pressSequentially(text);
  await l.press('Tab');
}

/** Fills the Capex create form (location, purpose, lines) on /docs/capex/new. */
export async function fillCapexForm(page: Page, o: { location?: string | RegExp; purpose: string; lines: { item: string | RegExp; qty: string; est_rate?: string; remarks?: string }[] }) {
  await expect(page.getByTestId('doc-form')).toBeVisible();
  await pickLookup(page, 'location', o.location ?? /^Pune Plant/);
  await page.getByTestId('field-purpose-input').fill(o.purpose);
  for (const [i, l] of o.lines.entries()) {
    if (i > 0 && !(await page.getByTestId(`grid-lines-row-${i}`).count())) await page.getByTestId('line-add').click();
    await pickItem(page, i, l.item);
    await page.getByTestId(`field-lines-${i}-qty-input`).fill(l.qty);
    if (l.est_rate !== undefined) await page.getByTestId(`field-lines-${i}-est_rate-input`).fill(l.est_rate);
    if (l.remarks) await page.getByTestId(`field-lines-${i}-remarks-input`).fill(l.remarks);
  }
}

/** Picks an item in line `i` by typing a search term first (the option list shows only the first few items). */
export async function pickItem(page: Page, i: number, label: string | RegExp) {
  const input = page.getByTestId(`field-lines-${i}-item-input`).getByRole('combobox');
  await input.click();
  const term = typeof label === 'string' ? label : label.source.replace(/[\\^$.*+?()[\]{}|]/g, ' ').trim().split(/\s+/)[0]!;
  await input.pressSequentially(term);
  const list = page.getByTestId(`field-lines-${i}-item-input-options`);
  await expect(list).toBeVisible();
  await list.getByRole('option', { name: label }).first().click();
}

/** Indian-grouped rupee text without symbol, e.g. 70000 → "70,000.00". */
export const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Opens the document detail by number from the list (document-wise). */
export async function openDocFromList(page: Page, number: string) {
  await page.goto('/docs/capex');
  await page.getByTestId(`doc-row-${number}`).click();
  await expect(page.getByTestId('doc-number')).toHaveText(number);
}

export async function docIdByNumber(number: string): Promise<string> {
  const [r] = await ownerQuery<{ id: string }>(`select id from app.document where number = $1`, [number]);
  return r!.id;
}

/**
 * Harness workaround for QA3-BUG-013 (the API process never registers its repeatable jobs): adds the `workflow-sla`
 * job to the running API's BullMQ queue (same Redis + prefix) every `everyMs`; the API's late-started worker runs it.
 * Returns a remover.
 */
export async function scheduleSlaScan(everyMs = 5_000): Promise<() => Promise<void>> {
  const apiDir = resolve(process.env.E2E_STACK_DIR ?? resolve(__dirname, '../..'), 'apps/api');
  // bullmq is an API dependency (not of the e2e package): load it from the API build and type the bit we use
  type Q = { add(n: string, d: unknown, o: unknown): Promise<unknown>; getRepeatableJobs(): Promise<{ name: string; every: string | null; key: string }[]>; removeRepeatableByKey(k: string): Promise<unknown>; close(): Promise<void> };
  const { Queue } = createRequire(resolve(apiDir, 'package.json'))('bullmq') as { Queue: new (name: string, opts: unknown) => Q };
  const q = new Queue('workflow', { connection: { url: process.env.E2E_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379' }, prefix: `procure:${process.env.E2E_API_ENV ?? 'development'}` });
  await q.add('workflow-sla', {}, { repeat: { every: everyMs }, jobId: 'qa-e2e-sla' });
  return async () => {
    for (const r of await q.getRepeatableJobs()) if (r.name === 'workflow-sla' && Number(r.every) === everyMs) await q.removeRepeatableByKey(r.key);
    await q.close();
  };
}

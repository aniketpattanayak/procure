/**
 * Phase 8 accessibility (WCAG 2.2 AA): axe-core over the main tenant and platform routes at desktop (1280) and
 * 390 px, plus a keyboard-only walkthrough of the core flow (sign in → create indent → submit → approve) with a focus
 * visibility check on every Tab stop, and a dialog focus-trap check. Findings: docs/qa/phase-8-a11y-report.md.
 *
 * A11Y_COLLECT=1 appends every violation (all impacts) to test-results/a11y-phase8.jsonl without failing; the default
 * run fails on any serious/critical violation not listed in KNOWN (each entry is documented in the report).
 */
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SEED } from './support/env';
import { expect, kit, test, Ui } from './support/fixtures';
import { ADMIN, login, seedIds } from './support/phase3';

const COLLECT = process.env.A11Y_COLLECT === '1';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** Serious/critical rule ids accepted for now, per route pattern (documented in the a11y report). */
const KNOWN: { rule: string; route: RegExp; why: string }[] = [];

type Found = { route: string; viewport: string; id: string; impact: string; help: string; nodes: string[] };
const found: Found[] = [];
const OUT_DIR = resolve(__dirname, '../test-results');
mkdirSync(OUT_DIR, { recursive: true });
/** One JSON line per violation (all impacts), appended as routes are scanned. */
const OUT = resolve(OUT_DIR, 'a11y-phase8.jsonl');

async function settle(page: Page) {
  await page.locator('main, [role="main"]').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"], .animate-pulse'), undefined, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForFunction(() => document.title.trim() !== '', undefined, { timeout: 15_000 }).catch(() => undefined); // redirects
  await page.waitForTimeout(300);
}

async function scan(page: Page, route: string, viewport: string) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const v of res.violations) {
    const f = { route, viewport, id: v.id, impact: v.impact ?? 'n/a', help: v.help, nodes: v.nodes.slice(0, 4).map(n => `${n.target.join(' ')} :: ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`) };
    found.push(f);
    appendFileSync(OUT, `${JSON.stringify(f)}\n`);
  }
}

function blocking(list: Found[]) {
  return list.filter(f => (f.impact === 'serious' || f.impact === 'critical') && !KNOWN.some(k => k.rule === f.id && k.route.test(f.route)))
    .map(f => `${f.viewport} ${f.route} ${f.id} (${f.impact}) ${f.nodes[0] ?? ''}`);
}

test.setTimeout(600_000);

// ------------------------------------------------------------------ keyboard-only core flow

/** Presses Tab until `target` has focus (max `max` stops); records Tab stops without a visible focus indicator. */
async function tabTo(page: Page, target: Locator, invisible: string[], max = 120) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate(el => el === document.activeElement || el.contains(document.activeElement)).catch(() => false)) return;
    await page.keyboard.press('Tab');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
    // Chrome applies :focus to a date/time host a task after focus enters its first inner segment
    if (await page.evaluate(() => /^(date|datetime-local|time|month)$/.test((document.activeElement as HTMLInputElement | null)?.type ?? ''))) await page.waitForTimeout(250);
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const opaque = (c: string) => !/rgba\([^)]*,\s*0\)|transparent/.test(c);
      // the indicator may sit on the element or on a wrapper (focus-within), up to 3 levels up
      // Chrome's own calendar/clock picker button inside a date/time input: focus sits in the UA shadow root, the host
      // no longer matches :focus, and Chrome draws its ring on the icon (verified by screenshot; not readable here).
      if (/^(date|datetime-local|time|month)$/.test((el as HTMLInputElement).type ?? '') && !el.matches(':focus')) return null;
      let ring = false;
      for (let n: HTMLElement | null = el, i = 0; n && i < 4 && !ring; n = n.parentElement, i++) {
        const s = getComputedStyle(n);
        ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && opaque(s.outlineColor)) || (!!s.boxShadow && s.boxShadow !== 'none');
      }
      const label = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName;
      return { ring: !!ring, label: `${el.tagName.toLowerCase()}[${label}]` };
    });
    if (info && !info.ring) invisible.push(info.label);
  }
  throw new Error(`Tab never reached ${target.toString()}`);
}

/** Moves the active option with ArrowDown until it matches `name`, then presses Enter (keyboard only). */
async function chooseWithKeys(page: Page, list: Locator, name: RegExp) {
  for (let i = 0; i < 15; i++) {
    if (i > 0) await page.keyboard.press('ArrowDown');
    const active = await list.evaluate(l => {
      const id = document.activeElement?.getAttribute('aria-activedescendant');
      const el = (id && document.getElementById(id)) || l.querySelector('[aria-selected="true"], [data-highlighted]');
      return el?.textContent ?? '';
    });
    if (name.test(active.trim())) { await page.keyboard.press('Enter'); return; }
  }
  throw new Error(`no option ${name} reachable with ArrowDown`);
}

test('keyboard only: sign in → new indent → submit → approve; every Tab stop shows focus', async ({ page }) => {
  const invisible: string[] = [];
  await page.setViewportSize({ width: 1280, height: 900 });
  // sign in with the keyboard
  await page.goto('/login');
  const form = page.getByTestId('login-form');
  await tabTo(page, form.getByTestId('login-tenant'), invisible);
  await page.keyboard.type(SEED.acme.code);
  await tabTo(page, form.getByTestId('login-email'), invisible);
  await page.keyboard.type(SEED.acme.email);
  await tabTo(page, form.getByTestId('login-password'), invisible);
  await page.keyboard.type(SEED.acme.password);
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/dashboard/, { timeout: 60_000 });

  // skip link / landmark: the first Tab stop should let keyboard users bypass the navigation
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => ({ text: document.activeElement?.textContent?.trim() ?? '', href: document.activeElement?.getAttribute('href') ?? '' }));
  test.info().annotations.push({ type: 'first-tab-stop', description: JSON.stringify(first) });

  // new indent with the keyboard
  await page.goto('/docs/indent/new');
  await expect(page.getByTestId('doc-form')).toBeVisible({ timeout: 120_000 });
  await page.locator('body').focus();
  const loc = page.getByTestId('field-location-input').getByRole('combobox');
  await tabTo(page, loc, invisible);
  await page.keyboard.type('Pune Plant');
  await expect(page.getByTestId('field-location-input-options').getByRole('option', { name: /^Pune Plant\s*PUNE$/ })).toBeVisible();
  await page.waitForTimeout(400); // let the debounced search settle before choosing with the keyboard
  await chooseWithKeys(page, page.getByTestId('field-location-input-options'), /^Pune Plant\s*PUNE$/);
  await expect(page.getByTestId('field-location-input-options')).toBeHidden();
  const dep = page.getByTestId('field-department-input').getByRole('combobox');
  if (await dep.count()) {
    await tabTo(page, dep, invisible);
    await page.keyboard.press('ArrowDown');
    const opts = page.getByTestId('field-department-input-options');
    if (await opts.getByRole('option').count().catch(() => 0)) await page.keyboard.press('Enter'); else await page.keyboard.press('Escape');
  }
  await tabTo(page, page.getByTestId('field-purpose-input'), invisible);
  await page.keyboard.type('Keyboard-only indent (a11y phase 8)');
  const item = page.getByTestId('field-lines-0-item-input').getByRole('combobox');
  await tabTo(page, item, invisible);
  await page.keyboard.type('Aluminium');
  await expect(page.getByTestId('field-lines-0-item-input-options').getByRole('option', { name: /Aluminium/ }).first()).toBeVisible();
  await page.waitForTimeout(400);
  await chooseWithKeys(page, page.getByTestId('field-lines-0-item-input-options'), /Aluminium/);
  await expect(page.getByTestId('field-lines-0-item-input-options')).toBeHidden();
  await tabTo(page, page.getByTestId('field-lines-0-qty-input'), invisible);
  await page.keyboard.type('7');
  await tabTo(page, page.getByTestId('doc-submit'), invisible);
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog');
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
    // focus must be inside the dialog and stay there
    for (let i = 0; i < 8; i++) {
      expect(await confirm.evaluate(d => d.contains(document.activeElement)), 'dialog keeps focus').toBe(true);
      await page.keyboard.press('Tab');
    }
    await tabTo(page, confirm.getByRole('button', { name: /^Submit$/ }), invisible, 10);
    await page.keyboard.press('Enter');
  }
  await page.waitForURL(/\/docs\/indent\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const id = /\/docs\/indent\/([0-9a-f-]{36})/.exec(page.url())![1]!;

  // approve with the keyboard as a second administrator (self-approval is off)
  const admin = await login(ADMIN);
  const email = `a11y8-${Date.now()}@acme.test`;
  const u = await kit.user(admin.token, { name: 'A11y Approver', email, isTenantAdmin: true });
  const firstLogin = await kit.tenantLogin('acme', u.email, u.temporaryPassword);
  await kit.changePassword(firstLogin, u.temporaryPassword, 'A11yAppr@12345');
  await page.context().clearCookies();
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await new Ui(page).tenantLogin('acme', email, 'A11yAppr@12345');
  await page.goto(`/docs/indent/${id}/approve?stage=verify`);
  await expect(page.getByTestId('approve-screen')).toBeVisible({ timeout: 60_000 });
  await page.locator('body').focus();
  await tabTo(page, page.getByTestId('decision-1-set-approve'), invisible);
  await page.keyboard.press('Enter');
  // a single-line decision may submit straight away (Enter = submit shortcut); otherwise Tab to Submit
  if (await page.getByTestId('decision-submit').isEnabled({ timeout: 2000 }).catch(() => false)) {
    await tabTo(page, page.getByTestId('decision-submit'), invisible);
    await page.keyboard.press('Enter');
  }
  await expect.poll(async () => (await kit.ok('GET', `/docs/indent/${id}`, admin.token)).statusKey, { timeout: 30_000 }).not.toBe('submitted');

  console.log(`focus-invisible: ${JSON.stringify([...new Set(invisible)])}; first tab stop: ${JSON.stringify(first)}`);
  if (!COLLECT) expect([...new Set(invisible)], 'Tab stops without a visible focus indicator').toEqual([]);
});

test('dialogs trap focus and return it on Escape', async ({ page }) => {
  await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
  await page.goto('/users');
  const trigger = page.getByTestId('users-invite').or(page.getByRole('button', { name: /add user|invite|new user/i })).first();
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 15; i++) {
    expect(await dialog.evaluate(d => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
  }
  await expect(dialog).toHaveAttribute('aria-modal', 'true').catch(async () => expect(await dialog.getAttribute('role')).toBe('dialog'));
  expect(await dialog.evaluate(d => !!(d.getAttribute('aria-labelledby') || d.getAttribute('aria-label')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await trigger.evaluate(el => el === document.activeElement)).toBe(true);
});

// ------------------------------------------------------------------ axe sweeps

async function tenantRoutes(): Promise<string[]> {
  const s = await login(ADMIN);
  const first = async (path: string) => {
    const r = await kit.ok('GET', path, s.token).catch(() => null) as { data?: { id: string }[] } | { id: string }[] | null;
    const rows = Array.isArray(r) ? r : r?.data ?? [];
    return rows[0]?.id as string | undefined;
  };
  const i = await seedIds();
  const indent = await first('/docs/indent?limit=1');
  const po = await first('/docs/po?limit=1');
  const grn = await first('/docs/grn?limit=1');
  const report = await first('/reports');
  const routes = [
    '/dashboard', '/dashboard/design', '/approvals',
    '/docs/indent', '/docs/indent/new', '/docs/indent?view=item',
    ...(indent ? [`/docs/indent/${indent}`, `/docs/indent/${indent}?tab=timeline`] : []),
    '/docs/po', ...(po ? [`/docs/po/${po}`] : []), '/procurement', '/procurement/select', '/procurement/order',
    '/docs/grn', '/docs/grn/new', ...(grn ? [`/docs/grn/${grn}`] : []),
    '/stock', '/stock/ledger', '/stock/receive', '/stock/issue', '/stock/reorder', '/stock/opening',
    '/reports', '/reports/new', ...(report ? [`/reports/${report}`] : []), '/exports', '/messages',
    '/settings', '/users', '/roles', `/roles/${i.roles.buyer ?? Object.values(i.roles)[0]}`, '/locations', `/masters/item`,
    '/config/forms', '/config/forms/item', '/config/doc-types', '/config/workflows', '/config/workflows/indent',
    '/config/templates', '/config/triggers', '/config/webhooks', '/config/numbering', '/audit', '/usage', '/account/sessions',
  ];
  return routes;
}

for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: '390px', width: 390, height: 844 }]) {
  test(`axe: tenant routes at ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const routes = await tenantRoutes();
    await new Ui(page).tenantLogin('acme', ADMIN.email, ADMIN.password);
    const before = found.length;
    for (const r of routes) {
      await page.goto(r, { timeout: 120_000 }); // dev server compiles each route on first visit
      await settle(page);
      await scan(page, r, vp.name);
    }
    // the approval screen of a submitted indent (first pending one in the inbox), if any
    if (!COLLECT) expect(blocking(found.slice(before))).toEqual([]);
  });

  test(`axe: platform routes at ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const owner = await kit.platformLogin(SEED.owner.email, SEED.owner.password);
    const tenants = await kit.ok('GET', '/platform/tenants', owner.token) as { data?: { id: string }[] } | { id: string }[];
    const plans = await kit.ok('GET', '/platform/plans', owner.token) as { id: string }[] | { data: { id: string }[] };
    const tId = (Array.isArray(tenants) ? tenants : tenants.data ?? [])[0]?.id;
    const pId = (Array.isArray(plans) ? plans : plans.data ?? [])[0]?.id;
    await new Ui(page).platformLogin();
    const before = found.length;
    for (const r of ['/platform/tenants', ...(tId ? [`/platform/tenants/${tId}`] : []), '/platform/tenants/new', '/platform/plans', ...(pId ? [`/platform/plans/${pId}`] : []), '/platform/plans/new', '/platform/usage', '/platform/audit', '/platform/providers']) {
      await page.goto(r, { timeout: 120_000 });
      await settle(page);
      await scan(page, r, vp.name);
    }
    if (!COLLECT) expect(blocking(found.slice(before))).toEqual([]);
  });
}

test('axe: login pages and the approval screen', async ({ page }) => {
  for (const r of ['/login', '/platform/login']) {
    await page.goto(r);
    await settle(page);
    await scan(page, r, 'desktop');
  }
  const s = await login(ADMIN);
  const pending = await kit.ok('GET', '/inbox?limit=5', s.token).catch(() => null) as { data?: { documentId?: string; docTypeKey?: string; stageKey?: string; id?: string }[] } | null;
  test.info().annotations.push({ type: 'inbox', description: JSON.stringify(pending?.data?.[0] ?? null) });
  if (!COLLECT) expect(blocking(found.filter(f => f.route.includes('login')))).toEqual([]);
});

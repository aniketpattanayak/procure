/**
 * Phase 2 E2E helpers: API sessions for seed users, multipart uploads (the test-kit transport is JSON-only),
 * DB-owner reads for assertions the API cannot make, sample images and spreadsheets, and small UI helpers for the
 * form renderer / builder.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';
import { deflateSync } from 'node:zlib';
import { API_ORIGIN, SEED } from './env';
import { kit } from './fixtures';

export const INDENTER = { email: 'indenter@acme.test', password: 'Indent@12345' };

export async function acmeAdmin() {
  return kit.tenantLogin('acme', SEED.acme.email, SEED.acme.password);
}

/** Multipart POST against the API (files, imports). */
export async function multipart(path: string, token: string, file: { name: string; body: Buffer; type?: string }, fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set('file', new Blob([new Uint8Array(file.body)], { type: file.type ?? 'application/octet-stream' }), file.name);
  const res = await fetch(`${API_ORIGIN}/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const text = await res.text();
  let body: any = text; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body };
}

/** Runs a query as the DB owner (bypasses RLS) — for assertions on state the API does not expose. */
export async function ownerQuery<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure' });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

// ------------------------------------------------------------------ PNG generator (no deps)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Solid-colour RGB PNG of w x h. */
export function png(w = 64, h = 48, rgb: [number, number, number] = [30, 120, 200]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ renderer helpers

/** Opens a lookup combobox and returns the visible option labels (waits for loading to finish). */
export async function lookupOptions(page: Page, field: string): Promise<string[]> {
  const input = page.getByTestId(`field-${field}-input`).getByRole('combobox');
  await input.click();
  const list = page.getByTestId(`field-${field}-input-options`);
  await expect(list).toBeVisible();
  await expect(list.getByText(/Loading/)).toHaveCount(0);
  const labels = await list.getByRole('option').allTextContents();
  await input.press('Escape');
  return labels.map(s => s.trim());
}

/** Text of the listbox when it has no options (empty state). */
export async function lookupEmptyText(page: Page, field: string): Promise<string> {
  const input = page.getByTestId(`field-${field}-input`).getByRole('combobox');
  await input.click();
  const list = page.getByTestId(`field-${field}-input-options`);
  await expect(list).toBeVisible();
  await expect(list.getByText(/Loading/)).toHaveCount(0);
  await expect(list.getByRole('option')).toHaveCount(0);
  const text = (await list.innerText()).trim();
  await input.press('Escape');
  return text;
}

/** Picks the option whose text matches `label` in a lookup. */
export async function pickLookup(page: Page, field: string, label: string | RegExp) {
  const input = page.getByTestId(`field-${field}-input`).getByRole('combobox');
  await input.click();
  const list = page.getByTestId(`field-${field}-input-options`);
  await expect(list).toBeVisible();
  await list.getByRole('option', { name: label }).first().click();
}

/** Types into a CodeMirror editor identified by its content test id (replaces the whole text). */
export async function typeFormula(page: Page, testId: string, text: string) {
  const cm = page.getByTestId(testId);
  await cm.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 10 });
}

/** Publishes the form open in the builder and waits for the publish dialog to close. */
export async function builderPublish(page: Page, note = 'QA') {
  await page.getByTestId('builder-publish').click();
  const d = page.getByTestId('publish-dialog');
  await expect(d).toBeVisible();
  await d.getByTestId('publish-note').fill(note);
  await d.getByTestId('publish-confirm').click();
  await expect(d).toBeHidden({ timeout: 20_000 });
}

export async function selectByValue(l: Locator, value: string) {
  await l.selectOption(value);
}

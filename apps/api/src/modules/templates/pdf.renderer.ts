import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Route } from 'playwright-core';
import { config } from '../../core/config';

/**
 * HTML → PDF with headless Chromium (Playwright). Locked down per contract "Rendering safety":
 *   - JavaScript disabled, no service workers, no downloads;
 *   - every request is intercepted: the page itself is served from a fake origin, `/api/v1/files/<id>/content` signed
 *     URLs (logo, signatures) are answered in-process by `resolveFile` (signature verified there), `data:` URLs never
 *     reach the network layer, and everything else is aborted;
 *   - 20 s timeout per render, at most 3 concurrent pages per process; the browser is reused and relaunched after a
 *     crash/disconnect.
 * Executable: PDF_CHROMIUM_PATH, else the first chromium under PLAYWRIGHT_BROWSERS_PATH.
 */
export const RENDER_ORIGIN = 'https://pdf.render.invalid';
export const PDF_TIMEOUT_MS = 20_000;
export const MAX_CONCURRENT_PAGES = 3;
const FILE_PATH = /^\/api\/v1\/files\/([0-9a-f-]{36})\/content$/i;

export interface PdfRenderOptions {
  format: 'A4' | 'A5' | 'Letter' | 'Legal';
  landscape: boolean;
  marginMm: { top: number; right: number; bottom: number; left: number };
  headerHtml?: string | null;
  footerHtml?: string | null;
}
export type FileResolver = (q: { id: string; t?: string; exp?: string; sig?: string; w?: string }) => Promise<{ body: Buffer; mime: string } | null>;
export interface PdfRenderResult { pdf: Buffer; blocked: string[]; served: string[] }

const META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/**
 * QA47-BUG-009: removes page-level navigation from layout HTML so rendering is deterministic: every
 * `<meta http-equiv=…>` (refresh and friends; values may be entity-encoded, so the whole tag goes — `<meta charset>`
 * and named metas stay). JavaScript is off, so no script-driven navigation exists; the route lock below also refuses
 * any second load of the page itself.
 */
export function stripNavigation(html: string): string {
  return html.replace(META_TAG, tag => (/\bhttp-equiv\b/i.test(tag) ? '' : tag));
}

export function chromiumPath(): string | undefined {
  if (process.env.PDF_CHROMIUM_PATH) return process.env.PDF_CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const dir = readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()[0];
  const exe = dir ? join(root, dir, 'chrome-linux', 'chrome') : null;
  return exe && existsSync(exe) ? exe : undefined;
}

@Injectable()
export class PdfRenderer implements OnApplicationShutdown {
  private readonly log = new Logger('PdfRenderer');
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  /** Counts browser launches (tests assert reuse). */
  launches = 0;

  private allowedHosts(): Set<string> {
    const hosts = new Set([new URL(RENDER_ORIGIN).host]);
    if (config.files.urlBase) {
      try {
        hosts.add(new URL(config.files.urlBase).host);
      } catch { /* relative base */ }
    }
    return hosts;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = (async () => {
        const { chromium } = await import('playwright-core');
        const b = await chromium.launch({
          executablePath: chromiumPath(),
          headless: true,
          args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--disable-sync'],
        });
        this.launches++;
        b.on('disconnected', () => {
          if (this.browser === b) this.browser = null;
        });
        this.browser = b;
        return b;
      })().finally(() => {
        this.launching = null;
      });
    }
    return this.launching;
  }

  private async acquire() {
    if (this.active < MAX_CONCURRENT_PAGES) {
      this.active++;
      return;
    }
    await new Promise<void>(res => this.waiters.push(res));
    this.active++;
  }

  private release() {
    this.active--;
    this.waiters.shift()?.();
  }

  get inFlight() {
    return this.active;
  }

  async render(rawHtml: string, opts: PdfRenderOptions, resolveFile: FileResolver, timeoutMs = PDF_TIMEOUT_MS): Promise<PdfRenderResult> {
    const html = stripNavigation(rawHtml);
    await this.acquire();
    try {
      try {
        return await this.renderOnce(html, opts, resolveFile, timeoutMs);
      } catch (e) {
        // Browser crashed or was killed mid-render: relaunch once and retry.
        if (this.browser && this.browser.isConnected()) throw e;
        this.log.warn(`chromium unavailable (${(e as Error).message}); relaunching`);
        this.browser = null;
        return await this.renderOnce(html, opts, resolveFile, timeoutMs);
      }
    } finally {
      this.release();
    }
  }

  private async renderOnce(html: string, opts: PdfRenderOptions, resolveFile: FileResolver, timeoutMs: number): Promise<PdfRenderResult> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false, offline: false });
    const blocked: string[] = [];
    const served: string[] = [];
    const hosts = this.allowedHosts();
    let timer: NodeJS.Timeout | undefined;
    let pageServed = false;
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      await context.route('**/*', async (route: Route) => {
        const url = route.request().url();
        try {
          if (url === `${RENDER_ORIGIN}/` && !pageServed) {
            // Served once: a later navigation back to the page (refresh, `<base>` tricks) is refused (QA47-BUG-009).
            pageServed = true;
            await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
            return;
          }
          const u = new URL(url);
          const m = FILE_PATH.exec(u.pathname);
          if (m && (u.protocol === 'https:' || u.protocol === 'http:') && hosts.has(u.host)) {
            const q = Object.fromEntries(u.searchParams.entries());
            const file = await resolveFile({ id: m[1]!, t: q.t, exp: q.exp, sig: q.sig, w: q.w }).catch(() => null);
            if (file) {
              served.push(url);
              await route.fulfill({ status: 200, contentType: file.mime, body: file.body });
              return;
            }
          }
          blocked.push(url);
          await route.abort('blockedbyclient');
        } catch {
          await route.abort('failed').catch(() => undefined);
        }
      });
      const work = (async () => {
        await page.goto(`${RENDER_ORIGIN}/`, { waitUntil: 'load', timeout: timeoutMs });
        const header = opts.headerHtml ?? null;
        const footer = opts.footerHtml ?? null;
        const mm = (n: number) => `${n}mm`;
        return page.pdf({
          format: opts.format, landscape: opts.landscape, printBackground: true, preferCSSPageSize: false,
          margin: { top: mm(opts.marginMm.top), right: mm(opts.marginMm.right), bottom: mm(opts.marginMm.bottom), left: mm(opts.marginMm.left) },
          displayHeaderFooter: !!(header || footer), headerTemplate: header ?? '<span></span>', footerTemplate: footer ?? '<span></span>',
        });
      })();
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`PDF rendering took longer than ${timeoutMs / 1000} s`)), timeoutMs);
      });
      const pdf = await Promise.race([work, timeout]);
      return { pdf, blocked, served };
    } finally {
      if (timer) clearTimeout(timer);
      await context.close().catch(() => undefined);
    }
  }

  async onApplicationShutdown() {
    const b = this.browser;
    this.browser = null;
    await b?.close().catch(() => undefined);
  }
}

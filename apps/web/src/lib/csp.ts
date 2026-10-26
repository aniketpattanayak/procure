import { themeBootScript } from './theme';

/**
 * SEC8-016 (follows SEC8-010): the Content-Security-Policy, built per request by `src/middleware.ts` with a fresh nonce.
 * Scripts run only when they carry the nonce ('strict-dynamic' lets those scripts load Next's chunks), so an injected
 * inline <script> or event handler no longer runs. Next reads the nonce from the request's CSP header and adds it to
 * its own scripts. The one inline script of our own (the theme boot script in the root layout) is allowed by its
 * sha256 hash instead, since a nonce prop on a React-rendered script fails hydration (browsers hide the attribute). Styles keep 'unsafe-inline' (React `style`
 * props and the component library's inline styles; style injection cannot run script). Dev also needs eval (React
 * Refresh / Turbopack) and websockets for HMR.
 */
export function buildCsp(nonce: string, opts: { dev: boolean; apiUrl?: string; scriptHashes?: string[] }): string {
  const apiOrigin = (() => {
    try {
      return new URL(opts.apiUrl ?? 'http://localhost:4000/api/v1').origin;
    } catch {
      return '';
    }
  })();
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${(opts.scriptHashes ?? []).map(h => ` '${h}'`).join('')} 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https: ${apiOrigin}`,
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}${opts.dev ? ' ws: wss:' : ''}`,
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** 128-bit random nonce, base64 (Web Crypto: runs in the edge middleware runtime). */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}

let themeHash: Promise<string> | null = null;
/** CSP source for the theme boot script: 'sha256-<base64>' of its exact text (computed once per process). */
export function themeScriptHash(): Promise<string> {
  themeHash ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(themeBootScript))
    .then(d => `sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}`);
  return themeHash;
}

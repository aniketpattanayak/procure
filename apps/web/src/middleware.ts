import { NextRequest, NextResponse } from 'next/server';
import { buildCsp, newNonce, themeScriptHash } from '@/lib/csp';

/**
 * SEC8-016: nonce-based CSP. A fresh nonce per document request goes into the request headers (`x-nonce` and the CSP
 * header, from which Next stamps its own <script> tags) and into the response CSP. Pages are rendered per request
 * (root layout `dynamic = 'force-dynamic'`), which the app does anyway (authenticated, per-user pages).
 *
 * Subdomain tenant resolution: if the request comes in on a subdomain of the configured BASE_DOMAIN
 * (e.g. "acme.app.example.com" when BASE_DOMAIN="app.example.com"), the subdomain is extracted and
 * forwarded to the login page as x-tenant-hint so the tenant code field is pre-filled.
 */

const BASE_DOMAIN = process.env.NEXT_PUBLIC_BASE_DOMAIN ?? '';

/** Extract subdomain from host, e.g. "acme.app.example.com" → "acme". Returns null for www/base/localhost. */
function extractSubdomain(host: string): string | null {
  if (!BASE_DOMAIN) return null;
  const cleanHost = host.split(':')[0]!.toLowerCase();
  const cleanBase = BASE_DOMAIN.toLowerCase();
  if (!cleanHost.endsWith('.' + cleanBase)) return null;
  const sub = cleanHost.slice(0, cleanHost.length - cleanBase.length - 1);
  if (!sub || sub === 'www') return null;
  return sub;
}

export async function middleware(request: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== 'production', apiUrl: process.env.NEXT_PUBLIC_API_URL, scriptHashes: [await themeScriptHash()] });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);

  // Subdomain → tenant hint
  const host = request.headers.get('host') ?? '';
  const subdomain = extractSubdomain(host);
  if (subdomain) {
    headers.set('x-tenant-hint', subdomain);
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  // Set/clear tenant hint cookie so the login page can pre-fill the company field
  if (subdomain) {
    res.cookies.set('x-tenant-hint', subdomain, { path: '/', sameSite: 'lax', httpOnly: false, maxAge: 60 });
  } else {
    res.cookies.delete('x-tenant-hint');
  }
  return res;
}

export const config = {
  matcher: [
    {
      // Documents only: static chunks, images and the favicon need no policy; router prefetches are RSC payloads.
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

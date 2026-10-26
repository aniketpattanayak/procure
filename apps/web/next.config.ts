import type { NextConfig } from 'next';
import path from 'node:path';

/**
 * SEC8-010: security headers for every response. The Content-Security-Policy is not set here: since SEC8-016 it is
 * nonce-based and built per request by src/middleware.ts (src/lib/csp.ts), which covers every document route.
 */
const dev = process.env.NODE_ENV !== 'production';
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  ...(dev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]),
];

const config: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Parallel agents/CI slots build side by side (e.g. NEXT_DIST_DIR=.next-fix3); default unchanged.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Self-contained server bundle for the Docker image (infra/docker/web.Dockerfile).
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@procure/ui', '@procure/schema'],
  poweredByHeader: false,
  experimental: {
    optimizePackageImports: ['lucide-react', '@procure/ui'],
  },
};

export default config;

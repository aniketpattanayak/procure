import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import { themeBootScript } from '@/lib/theme';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: t('app.name'), template: `%s · ${t('app.name')}` },
  description: t('app.tagline'),
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#12151a',
};

/**
 * SEC8-016: the CSP is nonce-based (src/middleware.ts). Next stamps the per-request nonce on its scripts only when a
 * page is rendered per request, so no page may be prerendered statically.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Allowed by its sha256 hash in the CSP (src/lib/csp.ts), not the nonce: browsers hide nonce attributes
            from the DOM, so a nonce prop here would fail hydration. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg">
        <a href="#main" className="sr-only z-[200] rounded bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:shadow-pop">
          {t('common.skipToContent')}
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

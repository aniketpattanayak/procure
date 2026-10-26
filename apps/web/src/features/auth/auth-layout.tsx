import type { ReactNode } from 'react';
import { t } from '@/i18n';

/** Centered single-column card used by every signed-out screen. */
export function AuthLayout({ title, subtitle, children, footer, variant = 'tenant' }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode; variant?: 'tenant' | 'platform' }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center bg-subtle px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span aria-hidden className="grid size-8 place-items-center rounded bg-accent font-semibold text-accent-fg">P</span>
          <div className="leading-tight">
            <p className="text-md font-semibold">{t('app.name')}</p>
            <p className="text-sm text-fg-muted">{variant === 'platform' ? t('auth.platformConsole') : t('app.tagline')}</p>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-fg-muted">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-fg-muted">{footer}</div>}
      </div>
    </main>
  );
}

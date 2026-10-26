'use client';
import { Button } from '@procure/ui';
import { Eye } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { t } from '@/i18n';
import { useSession } from '@/lib/session';

/** Persistent, non-dismissable banner while a Super Admin is signed in as a tenant. */
export function ImpersonationBanner() {
  const { impersonation, principal, exitImpersonation } = useSession();
  const ref = useRef<HTMLDivElement>(null);

  // Expose the banner height to the layout so sticky elements sit below it.
  useEffect(() => {
    const root = document.documentElement;
    if (!impersonation || !ref.current) {
      root.style.setProperty('--banner-h', '0px');
      return;
    }
    const el = ref.current;
    const set = () => root.style.setProperty('--banner-h', `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.setProperty('--banner-h', '0px'); };
  }, [impersonation]);

  if (!impersonation) return null;
  const tenantName = principal?.kind === 'tenant' ? principal.tenantName : impersonation.tenantName;
  const by = principal?.kind === 'tenant' && principal.impersonatedBy?.name ? principal.impersonatedBy.name : impersonation.byName;

  return (
    <div
      ref={ref}
      role="region"
      aria-label={t('impersonation.region')}
      data-testid="impersonation-banner"
      className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-b border-warning/40 bg-warning-soft px-4 py-2 text-center text-warning"
    >
      <p className="flex items-center gap-2 font-medium">
        <Eye className="size-4 shrink-0" aria-hidden />
        <span>{t('impersonation.banner', { tenant: tenantName, admin: by })}</span>
      </p>
      <Button size="sm" variant="secondary" onClick={() => void exitImpersonation()} data-testid="impersonation-exit">
        {t('impersonation.exit')}
      </Button>
    </div>
  );
}

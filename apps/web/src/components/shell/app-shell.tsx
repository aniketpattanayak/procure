'use client';
import { Button, Sheet, SheetContent } from '@procure/ui';
import { Menu, Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { t } from '@/i18n';
import { useMe } from '@/lib/permissions';
import { ImpersonationBanner } from './impersonation-banner';
import { LocationSwitcher } from './location-switcher';
import type { NavItem } from './nav';
import { ProfileMenu } from './profile-menu';
import { Brand, NavList } from './sidebar';

/** Placeholder: global search arrives with the first searchable module. */
function GlobalSearch() {
  return (
    <div className="relative hidden max-w-md flex-1 sm:block">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
      <input
        type="search"
        disabled
        aria-label={t('topbar.search')}
        placeholder={t('topbar.searchPlaceholder')}
        title={t('common.comingSoon')}
        className="h-9 w-full rounded border border-border bg-subtle pl-8 pr-3 text-base placeholder:text-fg-subtle disabled:cursor-not-allowed"
        data-testid="global-search"
      />
    </div>
  );
}

export function AppShell({ nav, subtitle, children, showLocation, actions }: { nav: NavItem[]; subtitle?: string; children: ReactNode; showLocation?: boolean; actions?: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const me = useMe();
  const logoUrl = me?.logoUrl ?? null;
  return (
    <div className="flex min-h-dvh flex-col">
      <ImpersonationBanner />
      <div className="flex flex-1">
        <aside
          className="sticky hidden w-sidebar shrink-0 flex-col border-r border-border bg-subtle py-4 lg:flex"
          style={{ top: 'var(--banner-h)', height: 'calc(100dvh - var(--banner-h))' }}
          aria-label={t('nav.sidebar')}
        >
          <Brand subtitle={subtitle} logoUrl={logoUrl} />
          <div className="mt-6 flex-1 overflow-y-auto"><NavList items={nav} /></div>
        </aside>

        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetContent side="left" title={t('nav.menu')} hideTitle closeLabel={t('common.close')} className="bg-subtle">
            <div className="py-4">
              <Brand subtitle={subtitle} logoUrl={logoUrl} />
              <div className="mt-6"><NavList items={nav} onNavigate={() => setDrawer(false)} /></div>
            </div>
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky z-30 flex h-topbar items-center gap-2 border-b border-border bg-bg/95 px-3 backdrop-blur sm:gap-3 sm:px-5" style={{ top: 'var(--banner-h)' }}>
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setDrawer(true)} aria-label={t('nav.open')} data-testid="nav-open">
              <Menu aria-hidden />
            </Button>
            <GlobalSearch />
            <div className="ml-auto flex items-center gap-1 sm:gap-2">
              {showLocation && <LocationSwitcher />}
              {actions}
              <ProfileMenu />
            </div>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">{children}</main>
        </div>
      </div>
    </div>
  );
}

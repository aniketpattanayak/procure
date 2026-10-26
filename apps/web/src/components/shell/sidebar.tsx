'use client';
import { cn } from '@procure/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { t } from '@/i18n';
import { sectionLabel, sectionOrder, type NavItem } from './nav';

export function Brand({ subtitle, logoUrl }: { subtitle?: string; logoUrl?: string | null }) {
  return (
    <div className="flex items-center gap-2.5 px-4">
      {logoUrl
        ? <img src={logoUrl} alt={subtitle ?? 'Logo'} className="size-7 rounded object-contain" />
        : <span aria-hidden className="grid size-7 place-items-center rounded bg-accent text-sm font-semibold text-accent-fg">P</span>
      }
      <div className="min-w-0 leading-tight">
        <p className="font-semibold">{t('app.name')}</p>
        {subtitle && <p className="truncate text-xs text-fg-muted">{subtitle}</p>}
      </div>
    </div>
  );
}

export function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const sections = sectionOrder
    .map(s => ({ s, items: items.filter(i => (i.section ?? 'main') === s) }))
    .filter(g => g.items.length > 0);
  return (
    <nav aria-label={t('nav.primary')} className="flex flex-col gap-5 px-2">
      {sections.map(({ s, items: group }) => {
        const heading = sectionLabel[s];
        return (
          <div key={s}>
            {heading && <p className="mb-1 px-2.5 text-xs font-medium text-fg-subtle">{t(heading)}</p>}
            <ul className="flex flex-col gap-0.5">
              {group.map(item => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      data-testid={`nav-${item.href.split('/').filter(Boolean).join('-')}`}
                      className={cn(
                        'flex h-9 items-center gap-2.5 rounded px-2.5 text-base transition-colors',
                        active ? 'bg-accent-soft font-medium text-accent' : 'text-fg-muted hover:bg-muted hover:text-fg',
                      )}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      <span className="truncate">{item.text ?? t(item.label)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

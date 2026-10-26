'use client';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@procure/ui';
import { KeyRound, LogOut, MonitorSmartphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { t } from '@/i18n';
import { useSession } from '@/lib/session';

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]!.toUpperCase()).join('') || '?';
}

export function ProfileMenu() {
  const { principal, logout, impersonation } = useSession();
  const router = useRouter();
  if (!principal) return null;
  const isTenant = principal.kind === 'tenant';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-2 rounded-full p-0.5 hover:bg-muted sm:rounded sm:px-1.5 sm:py-1"
        aria-label={t('profile.menu', { name: principal.name })}
        data-testid="profile-menu"
      >
        <span aria-hidden className="grid size-7 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{initials(principal.name)}</span>
        <span className="hidden max-w-36 truncate text-base font-medium md:block">{principal.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel className="text-fg">
          <span className="block truncate text-base font-medium">{principal.name}</span>
          <span className="block truncate font-normal text-fg-muted">{principal.email}</span>
          {principal.kind === 'tenant' && <span className="block truncate font-normal text-fg-subtle">{principal.tenantName}</span>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isTenant && (
          <DropdownMenuItem onSelect={() => router.push('/account/sessions')} data-testid="menu-sessions">
            <MonitorSmartphone aria-hidden />{t('profile.sessions')}
          </DropdownMenuItem>
        )}
        {!impersonation && (
          <DropdownMenuItem onSelect={() => router.push(isTenant ? '/change-password' : '/platform/change-password')}>
            <KeyRound aria-hidden />{t('profile.changePassword')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()} data-testid="logout">
          <LogOut aria-hidden />{impersonation ? t('impersonation.exit') : t('profile.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

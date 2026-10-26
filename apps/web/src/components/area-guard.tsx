'use client';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '@/lib/session';
import { PageSkeleton } from './guards';

/** Ensures the signed-in principal matches the area; otherwise redirects (login / change password / own home). */
export function AreaGuard({ kind, children }: { kind: 'tenant' | 'platform'; children: ReactNode }) {
  const { status, me, homeTarget } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const login = kind === 'platform' ? '/platform/login' : '/login';

  const ok = status === 'ready' && !!me && me.principal.kind === kind && !me.mustChangePassword;

  useEffect(() => {
    if (status === 'anonymous') router.replace(`${login}?next=${encodeURIComponent(pathname)}`);
    else if (status === 'ready' && me) {
      if (me.mustChangePassword) router.replace(me.principal.kind === 'platform' ? '/platform/change-password' : '/change-password');
      else if (me.principal.kind !== kind) router.replace(homeTarget(me.principal));
    }
  }, [status, me, kind, login, pathname, router, homeTarget]);

  if (!ok) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6"><PageSkeleton /></div>
    );
  }
  return <>{children}</>;
}

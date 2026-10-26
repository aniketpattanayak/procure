'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homeFor, useSession } from '@/lib/session';

export function useRedirectIfSignedIn(kind: 'tenant' | 'platform') {
  const { status, me } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status !== 'ready' || !me) return;
    if (me.mustChangePassword) return;
    if (me.principal.kind === kind) router.replace(homeFor(me.principal));
  }, [status, me, kind, router]);
}

export function safeNext(next: string | null, kind: 'tenant' | 'platform') {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return null;
  const isPlatform = next.startsWith('/platform');
  if (kind === 'platform' ? !isPlatform : isPlatform) return null;
  if (next.includes('/login')) return null;
  return next;
}

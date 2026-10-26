'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PageSkeleton } from '@/components/guards';
import { homeFor, useSession } from '@/lib/session';

export default function Home() {
  const { status, me } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
    if (status === 'ready' && me) router.replace(me.mustChangePassword ? (me.principal.kind === 'platform' ? '/platform/change-password' : '/change-password') : homeFor(me.principal));
  }, [status, me, router]);
  return <div className="p-6"><PageSkeleton /></div>;
}

'use client';
import type { AuthResult, MeResponse, Principal } from '@procure/schema';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from '@procure/ui';
import { t } from '@/i18n';
import { http, onAuthEvent, refreshSession, tokens, type ImpersonationInfo } from './api';

type Status = 'loading' | 'anonymous' | 'ready';

interface SessionContextValue {
  status: Status;
  me: MeResponse | null;
  principal: Principal | null;
  features: Set<string>;
  impersonation: ImpersonationInfo | null;
  /** Called after any successful login / password change. Returns the route to go to next. */
  acceptAuth: (result: AuthResult) => Promise<string>;
  reloadMe: () => Promise<MeResponse | null>;
  logout: () => Promise<void>;
  startImpersonation: (result: AuthResult, info: { tenantId: string; tenantName: string }) => Promise<void>;
  exitImpersonation: () => Promise<void>;
  /**
   * Where to send a principal that is in the wrong area. Returns a pending post-switch target
   * (e.g. tenant detail after Exit) when one is set for this principal kind, else its home.
   * Guards must use this instead of homeFor() so a still-mounted guard can't race the switch.
   */
  homeTarget: (p: Principal) => string;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function homeFor(p: Principal | null | undefined) {
  if (!p) return '/login';
  return p.kind === 'platform' ? '/platform/tenants' : '/dashboard';
}
export function changePasswordFor(pathname: string) {
  return pathname.startsWith('/platform') ? '/platform/change-password' : '/change-password';
}
export function loginFor(pathname: string) {
  return pathname.startsWith('/platform') ? '/platform/login' : '/login';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [impersonation, setImpersonation] = useState<ImpersonationInfo | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  // Destination after an identity switch (impersonation start/exit), keyed by the principal kind it is for.
  const pendingTarget = useRef<{ kind: Principal['kind']; path: string } | null>(null);

  const homeTarget = useCallback((p: Principal) => {
    const pending = pendingTarget.current;
    return pending && pending.kind === p.kind ? pending.path : homeFor(p);
  }, []);

  // Clear the pending target once we've arrived.
  useEffect(() => {
    if (pendingTarget.current && pathname === pendingTarget.current.path) pendingTarget.current = null;
  }, [pathname]);

  const reloadMe = useCallback(async () => {
    try {
      const next = await http.get<MeResponse>('/auth/me');
      setMe(next);
      setStatus('ready');
      return next;
    } catch {
      setMe(null);
      setStatus('anonymous');
      return null;
    }
  }, []);

  // Bootstrap: impersonation token for this tab, else refresh cookie.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const imp = tokens.impersonation;
      if (imp) {
        setImpersonation(imp);
        const ok = await reloadMe();
        if (ok || cancelled) return;
        tokens.endImpersonation();
        setImpersonation(null);
      }
      const refreshed = await refreshSession().catch(() => null);
      if (cancelled) return;
      if (refreshed) await reloadMe();
      else setStatus('anonymous');
    })();
    return () => { cancelled = true; };
  }, [reloadMe]);

  const resetToLogin = useCallback(() => {
    tokens.clear();
    qc.clear();
    setMe(null);
    setImpersonation(null);
    setStatus('anonymous');
    const login = loginFor(pathRef.current);
    if (!pathRef.current.endsWith('/login')) router.replace(`${login}?next=${encodeURIComponent(pathRef.current)}`);
  }, [qc, router]);

  const exitImpersonation = useCallback(async () => {
    const imp = tokens.impersonation;
    const target = imp ? `/platform/tenants/${imp.tenantId}` : '/platform/tenants';
    pendingTarget.current = { kind: 'platform', path: target };
    tokens.endImpersonation();
    setImpersonation(null);
    qc.clear();
    setStatus('loading');
    const refreshed = await refreshSession().catch(() => null);
    if (!refreshed) {
      pendingTarget.current = null;
      setMe(null);
      setStatus('anonymous');
      router.replace('/platform/login');
      return;
    }
    await reloadMe();
    router.replace(target);
  }, [qc, reloadMe, router]);

  useEffect(() => onAuthEvent(e => {
    if (e === 'unauthenticated') resetToLogin();
    else if (e === 'password-change-required') router.replace(changePasswordFor(pathRef.current));
    else if (e === 'impersonation-expired') {
      toast(t('impersonation.expired'));
      void exitImpersonation();
    }
  }), [resetToLogin, router, exitImpersonation]);

  const acceptAuth = useCallback(async (result: AuthResult) => {
    tokens.set(result.accessToken);
    qc.clear();
    if (result.mustChangePassword) {
      setMe({ principal: result.principal, mustChangePassword: true, features: [] });
      setStatus('ready');
      return result.principal.kind === 'platform' ? '/platform/change-password' : '/change-password';
    }
    const next = await reloadMe();
    return homeFor(next?.principal ?? result.principal);
  }, [qc, reloadMe]);

  const logout = useCallback(async () => {
    const wasPlatform = me?.principal.kind === 'platform';
    if (tokens.impersonation) {
      await exitImpersonation();
      return;
    }
    try { await http.post('/auth/logout'); } catch { /* already gone */ }
    tokens.clear();
    qc.clear();
    setMe(null);
    setStatus('anonymous');
    router.replace(wasPlatform ? '/platform/login' : '/login');
  }, [me, qc, router, exitImpersonation]);

  const startImpersonation = useCallback(async (result: AuthResult, info: { tenantId: string; tenantName: string }) => {
    const byName = result.principal.kind === 'tenant' && result.principal.impersonatedBy?.name
      ? result.principal.impersonatedBy.name
      : me?.principal.name ?? '';
    const imp: ImpersonationInfo = { accessToken: result.accessToken, tenantId: info.tenantId, tenantName: info.tenantName, byName, returnTo: pathRef.current };
    pendingTarget.current = { kind: 'tenant', path: '/dashboard' };
    tokens.startImpersonation(imp);
    setImpersonation(imp);
    qc.clear();
    setStatus('loading');
    await reloadMe();
    router.push('/dashboard');
  }, [me, qc, reloadMe, router]);

  const value = useMemo<SessionContextValue>(() => ({
    status,
    me,
    principal: me?.principal ?? null,
    features: new Set(me?.features ?? []),
    impersonation,
    acceptAuth,
    reloadMe,
    logout,
    startImpersonation,
    exitImpersonation,
    homeTarget,
  }), [status, me, impersonation, acceptAuth, reloadMe, logout, startImpersonation, exitImpersonation, homeTarget]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

export function useTenantPrincipal() {
  const { principal } = useSession();
  return principal?.kind === 'tenant' ? principal : null;
}

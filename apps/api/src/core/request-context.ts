import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '@procure/schema';

/** Per-request context available anywhere (audit, logging) without threading parameters. */
export interface RequestCtx {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  principal?: Principal;
  sessionId?: string;
}

export const requestStore = new AsyncLocalStorage<RequestCtx>();
export const ctx = (): RequestCtx | undefined => requestStore.getStore();

/** The tenant principal of the current request, or throws (used by tenant-only services). */
export function tenantPrincipal(): Extract<Principal, { kind: 'tenant' }> {
  const p = ctx()?.principal;
  if (!p || p.kind !== 'tenant') throw new Error('tenant principal required');
  return p;
}

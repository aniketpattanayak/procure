import { ErrorCode, type AuthResult, type Problem } from '@procure/schema';
import { API_URL } from './env';

/** Typed API error built from RFC 7807 problem JSON. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: { path: string; message: string }[];
  readonly meta: Record<string, unknown>;
  constructor(problem: Partial<Problem> & { status: number }) {
    super(problem.title || problem.detail || `Request failed (${problem.status})`);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code ?? (problem.status === 0 ? 'NETWORK' : `HTTP_${problem.status}`);
    this.errors = problem.errors ?? [];
    this.meta = problem.meta ?? {};
  }
  is(code: string) {
    return this.code === code || this.code.startsWith(`${code}.`);
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

// ---------------------------------------------------------------------------
// Token state (memory only; impersonation token mirrored to sessionStorage so a
// reload keeps the impersonation in this tab only).
// ---------------------------------------------------------------------------

const IMP_KEY = 'procure.impersonation';

export interface ImpersonationInfo {
  accessToken: string;
  tenantName: string;
  tenantId: string;
  byName: string;
  returnTo: string;
}

let accessToken: string | null = null;
let impersonation: ImpersonationInfo | null = null;

function loadImpersonation(): ImpersonationInfo | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(IMP_KEY);
    return raw ? (JSON.parse(raw) as ImpersonationInfo) : null;
  } catch {
    return null;
  }
}

export const tokens = {
  get access() { return impersonation?.accessToken ?? accessToken; },
  set(token: string | null) { accessToken = token; },
  get impersonation() {
    if (!impersonation) impersonation = loadImpersonation();
    return impersonation;
  },
  startImpersonation(info: ImpersonationInfo) {
    impersonation = info;
    try { window.sessionStorage.setItem(IMP_KEY, JSON.stringify(info)); } catch { /* private mode: memory only */ }
  },
  endImpersonation() {
    impersonation = null;
    try { window.sessionStorage.removeItem(IMP_KEY); } catch { /* ignore */ }
  },
  clear() {
    accessToken = null;
    this.endImpersonation();
  },
};

// ---------------------------------------------------------------------------
// Auth events so the session store / router can react without circular imports.
// ---------------------------------------------------------------------------

type AuthEvent = 'unauthenticated' | 'password-change-required' | 'impersonation-expired';
const listeners = new Set<(e: AuthEvent) => void>();
export function onAuthEvent(fn: (e: AuthEvent) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function emit(e: AuthEvent) {
  listeners.forEach(l => l(e));
}

// ---------------------------------------------------------------------------
// Single-flight refresh
// ---------------------------------------------------------------------------

let refreshing: Promise<AuthResult | null> | null = null;

/** Exchanges the httpOnly `rt` cookie for a fresh access token. Concurrent callers share one request. */
export function refreshSession(): Promise<AuthResult | null> {
  if (!refreshing) {
    // null = the session is really over (401). Rate limits, 5xx and network errors are transient:
    // retry with backoff, then throw an ApiError so callers keep the user signed in.
    const doRefresh = async (): Promise<AuthResult | null> => {
      for (let attempt = 0; ; attempt++) {
        let res: Response | null = null;
        try {
          res = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include', headers: { accept: 'application/json' } });
        } catch {
          res = null;
        }
        if (res?.ok) {
          const result = (await res.json()) as AuthResult;
          accessToken = result.accessToken;
          return result;
        }
        const transient = !res || res.status === 429 || res.status >= 500;
        if (!transient) return null;
        if (attempt >= 2) {
          throw new ApiError({ status: res?.status ?? 0, code: res?.status === 429 ? 'RATE_LIMITED' : 'NETWORK', title: 'The server is busy. Please try again in a moment.' });
        }
        const retryAfter = Number(res?.headers.get('retry-after') ?? 0);
        await new Promise(r => setTimeout(r, Math.min(5000, retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt)));
      }
    };
    refreshing = (async () => {
      try {
        // Refresh tokens rotate and reuse revokes the whole family, so two tabs must never
        // refresh with the same cookie at once. Web Locks serialises across tabs; the second
        // tab then sends the already-rotated cookie from the shared jar.
        const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
        return locks ? await locks.request('procure.auth.refresh', doRefresh) : await doRefresh();
      } catch (e) {
        if (e instanceof ApiError) throw e; // transient: do not sign the user out
        return null;
      } finally {
        // Let every waiter observe the same result before allowing another refresh.
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
  }
  return refreshing;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  query?: Query;
  /** Skip auth header + refresh (login endpoints). */
  anonymous?: boolean;
  signal?: AbortSignal;
  /** Extra request headers (e.g. `If-Match`, `Idempotency-Key`). */
  headers?: Record<string, string>;
}

const NO_REFRESH_CODES = new Set<string>([ErrorCode.INVALID_CREDENTIALS, ErrorCode.ACCOUNT_LOCKED, ErrorCode.REFRESH_REUSED]);

function buildUrl(path: string, query?: Query) {
  const url = new URL(`${API_URL}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  return url.toString();
}

async function toError(res: Response): Promise<ApiError> {
  let body: Partial<Problem> = {};
  try {
    body = (await res.json()) as Partial<Problem>;
  } catch {
    /* non-JSON error */
  }
  return new ApiError({ ...body, status: res.status, title: body.title ?? res.statusText });
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json, application/problem+json', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const token = tokens.access;
  if (!opts.anonymous && token) headers.authorization = `Bearer ${token}`;
  try {
    return await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError({ status: 0, code: 'NETWORK', title: 'Cannot reach the server. Check your connection and try again.' });
  }
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(path, opts);

  if (res.status === 401 && !opts.anonymous) {
    const err = await toError(res.clone());
    if (!NO_REFRESH_CODES.has(err.code)) {
      if (tokens.impersonation) {
        // Impersonation tokens are not refreshable; the session simply ends.
        emit('impersonation-expired');
        throw err;
      }
      const refreshed = await refreshSession();
      if (refreshed) {
        res = await send(path, opts);
      } else {
        tokens.clear();
        emit('unauthenticated');
        throw err;
      }
    }
  }

  if (!res.ok) {
    const err = await toError(res);
    if (err.code === ErrorCode.PASSWORD_CHANGE_REQUIRED) emit('password-change-required');
    if (err.status === 401 && !opts.anonymous) {
      tokens.clear();
      emit('unauthenticated');
    }
    throw err;
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const http = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => api<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => api<T>(path, { method: 'DELETE' }),
};

/** Map server field errors onto a react-hook-form instance; returns the message for a root banner when none mapped. */
export function applyProblemToForm(
  err: unknown,
  setError: (name: never, error: { type: string; message: string }) => void,
  knownFields?: readonly string[],
): string | null {
  if (!isApiError(err)) return err instanceof Error ? err.message : String(err);
  let mapped = 0;
  for (const fe of err.errors) {
    if (!fe.path) continue;
    if (knownFields && !knownFields.includes(fe.path) && !knownFields.includes(fe.path.split('.')[0]!)) continue;
    setError(fe.path as never, { type: 'server', message: fe.message });
    mapped++;
  }
  return mapped > 0 && mapped === err.errors.length ? null : err.message;
}

/**
 * Multipart uploads and authenticated binary downloads. The shared JSON client (`@/lib/api`) only sends JSON, so
 * these reuse its token state and single-flight refresh and turn problem JSON into the same ApiError.
 */
import type { FileMeta } from '@procure/schema';
import { API_URL } from '@/lib/env';
import { api, ApiError, refreshSession, tokens } from '@/lib/api';

async function problem(res: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  return new ApiError({ ...(body as object), status: res.status, title: (body.title as string) ?? res.statusText });
}

async function authed(path: string, init: RequestInit): Promise<Response> {
  const run = () => {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json, application/problem+json, */*');
    if (tokens.access) headers.set('authorization', `Bearer ${tokens.access}`);
    return fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' });
  };
  let res: Response;
  try {
    res = await run();
    if (res.status === 401 && !tokens.impersonation && (await refreshSession().catch(() => null))) res = await run();
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError({ status: 0, code: 'NETWORK', title: 'Cannot reach the server. Check your connection and try again.' });
  }
  if (!res.ok) throw await problem(res);
  return res;
}

/** File URLs from the API may be origin-relative (`/api/v1/files/…`); resolve them against the API origin. */
export function fileHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url, API_URL).toString(); } catch { return url; }
}

/** POST multipart to `path` and parse the JSON reply. */
export async function postMultipart<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  const res = await authed(path, { method: 'POST', body: form, signal });
  return (await res.json()) as T;
}

/** POST /files. Passing formKey + fieldKey makes the server apply that field's accept/maxSizeMb. */
export function uploadFile(file: Blob, opts: { filename?: string; formKey?: string; fieldKey?: string; signal?: AbortSignal } = {}): Promise<FileMeta> {
  const fd = new FormData();
  fd.append('file', file, opts.filename ?? (file instanceof File ? file.name : 'upload.bin'));
  // A field key only means something with its form (QA3-BUG-014: standalone uploads such as document attachments
  // pass a fieldKey for test ids / labels only; sending it alone is a 400 "formKey is required with fieldKey").
  if (opts.formKey) {
    fd.append('formKey', opts.formKey);
    if (opts.fieldKey) fd.append('fieldKey', opts.fieldKey);
  }
  return postMultipart<FileMeta>('/files', fd, opts.signal);
}

export function getFileMeta(id: string) {
  return api<FileMeta>(`/files/${id}`);
}

/** Download an authenticated binary (template, export) and hand it to the browser as a file. */
export async function downloadAuthed(path: string, fallbackName: string): Promise<void> {
  const res = await authed(path, { method: 'GET' });
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const name = m ? decodeURIComponent(m[1]!) : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

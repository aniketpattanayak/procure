import { ErrorCode } from '@procure/schema';
import { AppError } from '../../core/errors';

/**
 * Opaque keyset cursor for lists ordered by (created_at desc, id desc).
 * Encodes the last row's sort key; the next page is "strictly after" it.
 */
export interface KeysetCursor {
  t: string; // ISO timestamp
  id: string;
}

export function encodeCursor(createdAt: Date | string, id: string | number): string {
  const t = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  return Buffer.from(JSON.stringify({ t, id: String(id) })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): KeysetCursor | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as KeysetCursor;
    if (typeof v.t !== 'string' || typeof v.id !== 'string' || Number.isNaN(Date.parse(v.t))) throw new Error('bad');
    return v;
  } catch {
    throw new AppError(400, ErrorCode.VALIDATION, 'The page cursor is invalid. Start again from the first page.');
  }
}

/** Takes limit+1 rows, returns the page and the next cursor. */
export function toPage<R, T>(rows: R[], limit: number, key: (r: R) => { t: Date | string; id: string | number }, map: (r: R) => T) {
  const more = rows.length > limit;
  const pageRows = more ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    data: pageRows.map(map),
    nextCursor: more && last ? encodeCursor(key(last).t, key(last).id) : null,
  };
}

/** Escape LIKE wildcards in user search text (value is still passed as a bound parameter). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
}

export const toIso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { ErrorCode, Problem } from '@procure/schema';
import type { Response } from 'express';
import { ZodError } from 'zod';

/** Throw this everywhere. Rendered as RFC 7807 problem JSON with a stable code. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly meta?: Record<string, unknown>,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(message);
  }
  static notFound(what = 'Record') { return new AppError(404, ErrorCode.NOT_FOUND, `${what} not found`); }
  static forbidden(msg = 'You do not have permission for this action') { return new AppError(403, ErrorCode.FORBIDDEN, msg); }
  static conflict(msg: string, meta?: Record<string, unknown>) { return new AppError(409, ErrorCode.CONFLICT, msg, meta); }
  static versionConflict() { return new AppError(409, ErrorCode.VERSION_CONFLICT, 'This record was changed by someone else. Reload and try again.'); }
  static limitExceeded(limitKey: string, limit: number, used: number, label: string) {
    return new AppError(
      403,
      `${ErrorCode.LIMIT_EXCEEDED}.${limitKey}`,
      `Your plan allows ${limit} ${label}; you are using ${used}. Ask your administrator to upgrade the plan or free up capacity.`,
      { limitKey, limit, used },
    );
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const body = toProblem(err);
    if (body.status >= 500) this.log.error(err instanceof Error ? err.stack : String(err));
    res.status(body.status).type('application/problem+json').json(body);
  }
}

export function toProblem(err: unknown): Problem {
  if (err instanceof AppError) {
    return { type: 'about:blank', title: err.message, status: err.status, code: err.code, meta: err.meta, errors: err.errors };
  }
  if (err instanceof ZodError) {
    return {
      type: 'about:blank', title: 'Some fields are invalid', status: 400, code: ErrorCode.VALIDATION,
      errors: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  if (err instanceof HttpException) {
    const status = err.getStatus();
    return { type: 'about:blank', title: err.message, status, code: status === 404 ? ErrorCode.NOT_FOUND : `HTTP_${status}` };
  }
  // body-parser errors (too large / malformed JSON) carry an HTTP status and a type.
  const bp = err as { status?: number; type?: string };
  if (bp?.type === 'entity.too.large') return { type: 'about:blank', title: 'The request is too large', status: 413, code: 'PAYLOAD_TOO_LARGE' };
  if (bp?.type === 'entity.parse.failed') return { type: 'about:blank', title: 'The request body is not valid JSON', status: 400, code: ErrorCode.VALIDATION };
  // Postgres errors we translate deliberately
  const pg = err as { code?: string; constraint?: string };
  if (pg?.code === '23505') return { type: 'about:blank', title: 'A record with these values already exists', status: 409, code: ErrorCode.CONFLICT, meta: { constraint: pg.constraint } };
  if (pg?.code === '42501') return { type: 'about:blank', title: 'Not allowed', status: 403, code: ErrorCode.FORBIDDEN };
  return { type: 'about:blank', title: 'Something went wrong on our side', status: 500, code: 'INTERNAL' };
}

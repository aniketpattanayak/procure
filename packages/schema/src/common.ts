import { z } from 'zod';

/** Shared primitives used by every API contract. Owner: Architect. */

export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

export const TenantCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,30}$/, 'Use 2–31 lowercase letters, digits or hyphens');

export const Email = z.string().trim().toLowerCase().email().max(254);

/** Password policy floor; tenants may raise it via setting `security.password_min_length`. */
export const Password = z
  .string()
  .min(10, 'At least 10 characters')
  .max(128)
  .regex(/[a-z]/, 'Needs a lowercase letter')
  .regex(/[A-Z]/, 'Needs an uppercase letter')
  .regex(/[0-9]/, 'Needs a digit');

export const CurrencyCode = z.string().length(3).toUpperCase();

/** Cursor pagination request (every list endpoint). */
export const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().max(200).optional(),
  sort: z.string().regex(/^-?[a-zA-Z_.]+$/).optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** RFC 7807 problem body. `code` is stable and documented; `message` is for humans. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: { path: string; message: string }[];
  meta?: Record<string, unknown>;
}

/** Stable error codes. Add, never rename. */
export const ErrorCode = {
  VALIDATION: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'AUTH.INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'AUTH.ACCOUNT_LOCKED',
  PASSWORD_CHANGE_REQUIRED: 'AUTH.PASSWORD_CHANGE_REQUIRED',
  REFRESH_REUSED: 'AUTH.REFRESH_REUSED',
  TENANT_SUSPENDED: 'TENANT.SUSPENDED',
  SUBSCRIPTION_INACTIVE: 'TENANT.SUBSCRIPTION_INACTIVE',
  FORBIDDEN: 'FORBIDDEN',
  FEATURE_NOT_IN_PLAN: 'FEATURE_NOT_IN_PLAN',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

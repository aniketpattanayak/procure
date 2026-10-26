import { z } from 'zod';
import { Email, Password, TenantCode, Uuid } from './common';

/** Phase 1 auth + user contracts. */

export const TenantLogin = z.object({
  tenantCode: TenantCode,
  email: Email,
  password: z.string().min(1).max(128),
});
export const PlatformLogin = z.object({ email: Email, password: z.string().min(1).max(128) });

export const PasswordChange = z
  .object({ currentPassword: z.string().min(1), newPassword: Password })
  .refine(v => v.currentPassword !== v.newPassword, { path: ['newPassword'], message: 'Must differ from current password' });

export interface AuthResult {
  accessToken: string;
  expiresIn: number; // seconds
  mustChangePassword: boolean;
  principal: Principal;
}

export type Principal =
  | { kind: 'platform'; userId: string; name: string; email: string; role: 'owner' | 'support' | 'billing' }
  | {
      kind: 'tenant';
      userId: string;
      tenantId: string;
      tenantCode: string;
      tenantName: string;
      name: string;
      email: string;
      isTenantAdmin: boolean;
      impersonatedBy?: { userId: string; name: string };
    };

/** JWT access-token claims (15 min). */
export interface AccessClaims {
  sub: string;
  typ: 'platform' | 'tenant';
  tid?: string;          // tenant id
  sid: string;           // session id
  imp?: string;          // impersonating platform user id
  pcv?: boolean;         // must change password: only /auth/password/change + /auth/me allowed
}

export const UserCreate = z.object({
  name: z.string().trim().min(2).max(120),
  email: Email,
  phone: z.string().trim().max(20).optional(),
  isTenantAdmin: z.boolean().default(false),
  roleIds: z.array(Uuid).default([]),
  reportingManagerId: Uuid.optional(),
  /** Values for the tenant's custom fields on the `user` form (validated server-side against that form). */
  custom: z.record(z.string(), z.unknown()).optional(),
});
export type UserCreate = z.infer<typeof UserCreate>;

export const UserUpdate = UserCreate.omit({ email: true }).partial().extend({ version: z.number().int() });

export interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  isTenantAdmin: boolean;
  isActive: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  roles: { id: string; key: string; name: string }[];
  /** Custom field values from the `user` form. */
  custom?: Record<string, unknown>;
  version: number;
}

export interface SessionRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
  impersonatedBy: string | null;
}

export const RoleInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().trim().min(2).max(80),
  description: z.string().max(500).optional(),
});

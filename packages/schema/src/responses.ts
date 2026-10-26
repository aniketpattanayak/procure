import type { MyPermissions } from './access';
import type { z } from 'zod';
import type { Entitlements } from './platform';
import type { BillingCycle, SubscriptionStatus, TenantStatus } from './platform';
import type { Principal } from './identity';

/**
 * Response shapes named in docs/contracts/phase-1-api.md, typed to what the API returns.
 * Types only (no runtime schemas): the API owns these bodies; clients consume them.
 */

export type TenantStatusValue = z.infer<typeof TenantStatus>;
export type SubscriptionStatusValue = z.infer<typeof SubscriptionStatus>;
export type BillingCycleValue = z.infer<typeof BillingCycle>;

// ---------------------------------------------------------------- auth

/** GET /auth/me */
export interface MeResponse {
  principal: Principal;
  mustChangePassword: boolean;
  /** Effective plan features (tenant users); empty for platform users. */
  features: string[];
  /** Present for tenant users. */
  limits?: Entitlements['limits'];
  /** Phase 2 — tenant users only. */
  permissions?: MyPermissions;
  /** Tenant wording overrides for the user's language (i18n key -> text). */
  labels?: Record<string, string>;
  /** Non-sensitive settings the UI needs ('labels.location_levels', 'flow.*'). */
  settings?: Record<string, unknown>;
  /** Tenant logo URL (tenant users only). */
  logoUrl?: string | null;
}

// ---------------------------------------------------------------- platform catalog

/** GET /platform/catalog → features[] */
export interface FeatureCatalogRow {
  key: string;
  name: string;
  description: string | null;
  kind: 'module' | 'capability' | 'channel';
  sortOrder: number;
}

/** GET /platform/catalog → limits[] */
export interface LimitCatalogRow {
  key: string;
  name: string;
  unit: string;
  meter: 'live_count' | 'monthly' | 'lifetime';
  /** Limit only applies when this feature is on; null = always. */
  featureKey: string | null;
  sortOrder: number;
}

export interface CatalogResponse {
  features: FeatureCatalogRow[];
  limits: LimitCatalogRow[];
}

// ---------------------------------------------------------------- tenants

/** GET /platform/tenants → Page<TenantListRow> */
export interface TenantListRow {
  id: string;
  code: string;
  name: string;
  status: TenantStatusValue;
  planName: string | null;
  subscriptionStatus: SubscriptionStatusValue | null;
  renewalDate: string | null;
  activeUsers: number;
  maxUsers: number | null;
  createdAt: string;
}

/** Tenant record returned by GET/PUT /platform/tenants/:id and the status actions. */
export interface TenantRecord {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  logoUrl: string | null;
  taxIds: { gstin?: string; pan?: string };
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    stateCode?: string;
    postalCode?: string;
    country?: string;
  };
  timezone: string;
  currency: string;
  fyStartMonth: number;
  status: TenantStatusValue;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  customDomain: string | null;
  allowCustomDomain: boolean;
  version: number;
}

/** Subscription row (current subscription, POST /subscription, GET /subscriptions history). */
export interface SubscriptionRecord {
  id: string;
  tenantId: string;
  planId: string;
  planName: string | null;
  status: SubscriptionStatusValue;
  /** Calendar date YYYY-MM-DD. */
  startDate: string;
  renewalDate: string | null;
  trialEndsOn: string | null;
  /** ISO timestamp. */
  effectiveFrom: string;
  /** ISO timestamp; null = current. */
  effectiveTo: string | null;
  changeReason: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** GET /platform/tenants/:id */
export interface TenantDetail {
  tenant: TenantRecord;
  subscription: SubscriptionRecord | null;
  entitlements: Entitlements;
}

/** GET /platform/tenants/:id/overrides/history (newest first). Values are the JSON override values; null = none. */
export interface OverrideHistoryRow {
  id: string;
  kind: 'feature' | 'limit';
  key: string;
  /** Previous override value; null = there was no override. */
  oldValue: boolean | number | null;
  /** New override value; null = override removed (or limit set to unlimited — see `kind`). */
  newValue: boolean | number | null;
  reason: string;
  changedBy: string | null;
  changedByName: string | null;
  changedAt: string;
}

/** GET /platform/usage */
export interface TenantUsageRow {
  tenantId: string;
  code: string;
  name: string;
  limits: { key: string; used: number; effective: number | null }[];
}

/** GET /platform/audit → Page<PlatformAuditRow> */
export interface PlatformAuditRow {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  tenantId: string | null;
  tenantCode: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  at: string;
}

/** POST /platform/tenants/:id/admin/reset-password, POST /users/:id/reset-password */
export interface TemporaryPasswordResult {
  temporaryPassword: string;
}

// ---------------------------------------------------------------- tenant identity

/** GET /roles, POST /roles */
export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  version: number;
  userCount: number;
}

/** GET /notifications → Page<NotificationRow> */
export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/** POST /users */
export interface UserCreated {
  user: import('./identity').UserRow;
  temporaryPassword: string;
}

import { z } from 'zod';
import { CurrencyCode, Email, TenantCode, Uuid } from './common';

/** Phase 1 platform contracts. Owner: Platform & tenancy agent; frozen by Architect. */

export const BillingCycle = z.enum(['monthly', 'quarterly', 'yearly']);
export const SubscriptionStatus = z.enum(['trial', 'active', 'grace', 'expired', 'suspended']);
export const TenantStatus = z.enum(['active', 'suspended', 'archived']);
export const PlatformRole = z.enum(['owner', 'support', 'billing']);

/** Limit value: non-negative integer, or null = unlimited. */
export const LimitValue = z.number().int().min(0).nullable();

export const PlanInput = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{2,40}$/),
  name: z.string().trim().min(2).max(80),
  description: z.string().max(500).optional(),
  price: z.number().min(0),
  currency: CurrencyCode.default('INR'),
  billingCycle: BillingCycle.default('monthly'),
  trialDays: z.number().int().min(0).max(365).default(0),
  isActive: z.boolean().default(true),
  features: z.array(z.string()).default([]),
  limits: z.record(z.string(), LimitValue).default({}),
});
export type PlanInput = z.infer<typeof PlanInput>;

export interface Plan extends PlanInput {
  id: string;
  version: number;
  tenantCount: number;
}

export const Address = z.object({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(80).optional(),
  state: z.string().max(80).optional(),
  stateCode: z.string().max(4).optional(),
  postalCode: z.string().max(12).optional(),
  country: z.string().max(2).default('IN'),
});

export const GSTIN = z.string().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');
export const PAN = z.string().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN');

export const TenantProfile = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(200).optional(),
  logoUrl: z.string().url().optional(),
  taxIds: z.object({ gstin: GSTIN.optional(), pan: PAN.optional() }).default({}),
  address: Address.default({}),
  timezone: z.string().default('Asia/Kolkata'),
  currency: CurrencyCode.default('INR'),
  fyStartMonth: z.number().int().min(1).max(12).default(4),
});

export const TenantCreate = TenantProfile.extend({
  code: TenantCode,
  planId: Uuid,
  subscription: z.object({
    status: SubscriptionStatus.default('trial'),
    startDate: z.string().date(),
    renewalDate: z.string().date().optional(),
  }),
  admin: z.object({ name: z.string().trim().min(2).max(120), email: Email }),
  /** global_template bundle key copied in at creation (Phase 2+ populates bundles). */
  templateBundle: z.string().optional(),
});
export type TenantCreate = z.infer<typeof TenantCreate>;

export const TenantUpdate = TenantProfile.partial().extend({ version: z.number().int() });

export const TenantStatusChange = z.object({ reason: z.string().trim().min(3).max(500) });

export const OverrideSet = z.object({
  kind: z.enum(['feature', 'limit']),
  key: z.string(),
  /** feature: boolean; limit: integer or null (unlimited). Send `remove: true` to clear. */
  value: z.union([z.boolean(), LimitValue]).optional(),
  remove: z.boolean().optional(),
  reason: z.string().trim().min(3).max(500),
});
export type OverrideSet = z.infer<typeof OverrideSet>;

export const SubscriptionChange = z.object({
  planId: Uuid,
  status: SubscriptionStatus,
  effectiveFrom: z.string().datetime().optional(),     // default now
  renewalDate: z.string().date().optional(),
  reason: z.string().trim().min(3).max(500),
});

export interface Entitlements {
  planId: string | null;
  planName: string | null;
  subscriptionStatus: z.infer<typeof SubscriptionStatus> | null;
  features: { key: string; name: string; enabled: boolean; source: 'plan' | 'override' | 'none' }[];
  limits: {
    key: string;
    name: string;
    unit: string;
    meter: 'live_count' | 'monthly' | 'lifetime';
    /** Feature this limit belongs to; null = always applies. Tenant UI hides limits whose feature is off. */
    featureKey: string | null;
    planValue: number | null;
    override: number | null | undefined; // undefined = no override
    effective: number | null;
    used: number;
  }[];
}

export interface TenantCreated {
  tenantId: string;
  adminEmail: string;
  /** Shown once to Super Admin to share with the client; user must change it on first login. */
  temporaryPassword: string;
}

import { toIso } from '../identity';

export interface TenantDto {
  id: string; code: string; name: string; legalName: string | null; logoUrl: string | null;
  taxIds: Record<string, string>; address: Record<string, string>; timezone: string; currency: string; fyStartMonth: number;
  status: 'active' | 'suspended' | 'archived'; statusReason: string | null; createdAt: string; updatedAt: string;
  customDomain: string | null; allowCustomDomain: boolean; version: number;
}

export function toTenant(t: {
  id: string; code: string; name: string; legal_name: string | null; logo_url: string | null; tax_ids: Record<string, string>;
  address: Record<string, string>; timezone: string; currency: string; fy_start_month: number; status: 'active' | 'suspended' | 'archived';
  status_reason: string | null; created_at: Date; updated_at: Date; custom_domain: string | null; allow_custom_domain: boolean; version: number;
}): TenantDto {
  return {
    id: t.id, code: t.code, name: t.name, legalName: t.legal_name, logoUrl: t.logo_url, taxIds: t.tax_ids, address: t.address,
    timezone: t.timezone, currency: t.currency, fyStartMonth: t.fy_start_month, status: t.status, statusReason: t.status_reason,
    createdAt: toIso(t.created_at)!, updatedAt: toIso(t.updated_at)!, customDomain: t.custom_domain, allowCustomDomain: t.allow_custom_domain, version: t.version,
  };
}

export interface SubscriptionDto {
  id: string; tenantId: string; planId: string; planName: string | null; status: string; startDate: string; renewalDate: string | null;
  trialEndsOn: string | null; effectiveFrom: string; effectiveTo: string | null; changeReason: string | null; createdBy: string | null; createdAt: string;
}

/** Dates come back from pg as Date at local midnight; format as calendar date without shifting. */
export function toDate(v: string | Date | null): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function toSubscription(s: {
  id: string; tenant_id: string; plan_id: string; plan_name?: string | null; status: string; start_date: string | Date; renewal_date: string | Date | null;
  trial_ends_on: string | Date | null; effective_from: Date; effective_to: Date | null; change_reason: string | null; created_by: string | null; created_at: Date;
}): SubscriptionDto {
  return {
    id: s.id, tenantId: s.tenant_id, planId: s.plan_id, planName: s.plan_name ?? null, status: s.status,
    startDate: toDate(s.start_date)!, renewalDate: toDate(s.renewal_date), trialEndsOn: toDate(s.trial_ends_on),
    effectiveFrom: toIso(s.effective_from)!, effectiveTo: toIso(s.effective_to), changeReason: s.change_reason,
    createdBy: s.created_by, createdAt: toIso(s.created_at)!,
  };
}

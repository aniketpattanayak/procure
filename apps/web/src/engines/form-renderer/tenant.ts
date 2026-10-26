'use client';
import { useMe } from '@/lib/permissions';

/** Tenant currency and timezone from /auth/me settings (`tenant.currency`, `tenant.timezone`); INR / Asia/Kolkata until loaded. */
export function useTenantLocale(): { currency: string; timeZone: string } {
  const s = useMe()?.settings ?? {};
  const currency = typeof s['tenant.currency'] === 'string' ? (s['tenant.currency'] as string) : 'INR';
  const timeZone = typeof s['tenant.timezone'] === 'string' ? (s['tenant.timezone'] as string) : 'Asia/Kolkata';
  return { currency, timeZone };
}

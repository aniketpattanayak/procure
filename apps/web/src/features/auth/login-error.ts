import { ErrorCode } from '@procure/schema';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtTime, minutesUntil } from '@/lib/format';

/** Human message for login failures; lockout includes the unlock time. */
export function loginErrorMessage(err: unknown): string {
  if (!isApiError(err)) return t('error.generic');
  if (err.code === ErrorCode.ACCOUNT_LOCKED) {
    const until = typeof err.meta.lockedUntil === 'string' ? err.meta.lockedUntil : null;
    if (until) return t('auth.locked', { time: fmtTime(until), minutes: minutesUntil(until) });
    return t('auth.lockedNoTime');
  }
  if (err.code === ErrorCode.INVALID_CREDENTIALS) return t('auth.invalid');
  if (err.code === ErrorCode.TENANT_SUSPENDED) return t('auth.tenantSuspended');
  if (err.code === ErrorCode.SUBSCRIPTION_INACTIVE) return t('auth.subscriptionInactive');
  if (err.code === ErrorCode.RATE_LIMITED) return t('auth.rateLimited');
  return err.message;
}

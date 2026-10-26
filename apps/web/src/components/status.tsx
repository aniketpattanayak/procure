import { StatusBadge, type BadgeTone } from '@procure/ui';
import type { SubscriptionStatusValue, TenantStatusValue, UserRow } from '@procure/schema';
import { t, tMaybe } from '@/i18n';

const tenantTone: Record<TenantStatusValue, BadgeTone> = { active: 'success', suspended: 'warning', archived: 'neutral' };
const subTone: Record<SubscriptionStatusValue, BadgeTone> = { trial: 'accent', active: 'success', grace: 'warning', expired: 'danger', suspended: 'danger' };

export function TenantStatusBadge({ status }: { status: TenantStatusValue }) {
  return <StatusBadge tone={tenantTone[status] ?? 'neutral'}>{tMaybe(`tenantStatus.${status}`, status)}</StatusBadge>;
}

export function SubscriptionBadge({ status }: { status: SubscriptionStatusValue | null | undefined }) {
  if (!status) return <span className="text-fg-subtle">—</span>;
  return <StatusBadge tone={subTone[status] ?? 'neutral'}>{tMaybe(`subStatus.${status}`, status)}</StatusBadge>;
}

export function isLocked(u: Pick<UserRow, 'lockedUntil'>) {
  return !!u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now();
}

export function UserStatusBadge({ user }: { user: Pick<UserRow, 'isActive' | 'lockedUntil'> }) {
  if (!user.isActive) return <StatusBadge tone="neutral">{t('users.status.inactive')}</StatusBadge>;
  if (isLocked(user)) return <StatusBadge tone="warning">{t('users.status.locked')}</StatusBadge>;
  return <StatusBadge tone="success">{t('users.status.active')}</StatusBadge>;
}

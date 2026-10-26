'use client';
import type { Entitlements } from '@procure/schema';
import { cn, StatusBadge, UsageBar, usageLevel } from '@procure/ui';
import { t } from '@/i18n';
import { fmtNumber } from '@/lib/format';

type Limit = Entitlements['limits'][number];

export function meterLabel(m: Limit['meter']) {
  return t(`meter.${m}`);
}

/** Used / effective with a bar: amber from 80%, red at 100%. */
export function LimitRow({ limit, compact }: { limit: Limit; compact?: boolean }) {
  const level = usageLevel(limit.used, limit.effective);
  return (
    <div className={cn('space-y-2', !compact && 'py-3.5')} data-testid={`limit-${limit.key}`} data-level={level}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="font-medium">{limit.name}</p>
          {!compact && <p className="text-sm text-fg-muted">{meterLabel(limit.meter)}</p>}
        </div>
        <div className="flex items-center gap-2">
          {level === 'warn' && <StatusBadge tone="warning">{t('usage.nearLimit')}</StatusBadge>}
          {level === 'full' && <StatusBadge tone="danger">{t('usage.atLimit')}</StatusBadge>}
          <p className="tabular text-base">
            <span className="font-semibold">{fmtNumber(limit.used)}</span>
            <span className="text-fg-muted"> / {limit.effective === null ? t('usage.unlimited') : fmtNumber(limit.effective)} {limit.unit !== 'count' ? limit.unit : ''}</span>
          </p>
        </div>
      </div>
      <UsageBar used={limit.used} max={limit.effective} label={limit.name} />
    </div>
  );
}

export function LimitsList({ limits }: { limits: Limit[] }) {
  return (
    <div className="divide-y divide-border">
      {limits.map(l => <LimitRow key={l.key} limit={l} />)}
    </div>
  );
}

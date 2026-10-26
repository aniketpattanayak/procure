'use client';
import { EmptyState, Skeleton, SkeletonGroup } from '@procure/ui';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import { usePermissions } from '@/lib/permissions';
import { useTenantPrincipal } from '@/lib/session';

/** Tenant-admin only content. Nav already hides these; this covers direct URL access. */
export function AdminOnly({ children }: { children: ReactNode }) {
  const p = useTenantPrincipal();
  if (!p) return null;
  if (!p.isTenantAdmin) return <EmptyState icon={<Lock />} title={t('guard.adminOnly.title')} description={t('guard.adminOnly.body')} />;
  return <>{children}</>;
}

/**
 * Permission-gated page content (Phase 2). Nav already hides entries the user can't view; this covers direct URLs.
 * Pass `perm` (single key) or `anyOf`.
 */
export function RequirePermission({ perm: key, anyOf, children }: { perm?: string; anyOf?: string[]; children: ReactNode }) {
  const p = usePermissions();
  if (!p.ready) return null;
  const ok = (!key || p.has(key)) && (!anyOf?.length || p.hasAny(...anyOf));
  if (!ok) return <EmptyState icon={<Lock />} title={t('guard.noAccess.title')} description={t('guard.noAccess.body')} />;
  return <>{children}</>;
}

export function PageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <SkeletonGroup label={t('common.loading')} className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="space-y-2 rounded-lg border border-border bg-surface p-4">
        {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
      </div>
    </SkeletonGroup>
  );
}

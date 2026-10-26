'use client';
import type { SessionRow } from '@procure/schema';
import { Badge, Button, EmptyState, Skeleton, SkeletonGroup, Table, TBody, TD, TH, THead, TR } from '@procure/ui';
import { MonitorSmartphone } from 'lucide-react';
import { t } from '@/i18n';
import { describeAgent, fmtDateTime, fmtRelative } from '@/lib/format';

export function SessionsTable({ sessions, loading, onRevoke, revokingId }: { sessions: SessionRow[] | undefined; loading: boolean; onRevoke?: (s: SessionRow) => void; revokingId?: string | null }) {
  if (loading) {
    return (
      <SkeletonGroup className="space-y-2">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}
      </SkeletonGroup>
    );
  }
  if (!sessions?.length) return <EmptyState icon={<MonitorSmartphone />} title={t('sessions.empty')} />;
  return (
    <Table data-testid="sessions-table">
      <THead>
        <TR>
          <TH>{t('sessions.device')}</TH>
          <TH>{t('sessions.ip')}</TH>
          <TH>{t('sessions.started')}</TH>
          <TH>{t('sessions.lastUsed')}</TH>
          {onRevoke && <TH><span className="sr-only">{t('common.actions')}</span></TH>}
        </TR>
      </THead>
      <TBody>
        {sessions.map(s => (
          <TR key={s.id}>
            <TD>
              <div className="flex flex-wrap items-center gap-2">
                <span>{describeAgent(s.userAgent)}</span>
                {s.current && <Badge tone="accent">{t('sessions.current')}</Badge>}
                {s.impersonatedBy && <Badge tone="warning">{t('sessions.impersonated')}</Badge>}
              </div>
            </TD>
            <TD className="tabular text-fg-muted">{s.ip ?? '—'}</TD>
            <TD className="text-fg-muted">{fmtDateTime(s.createdAt)}</TD>
            <TD className="text-fg-muted">{fmtRelative(s.lastUsedAt)}</TD>
            {onRevoke && (
              <TD className="text-right">
                {!s.current && (
                  <Button size="sm" variant="secondary" onClick={() => onRevoke(s)} loading={revokingId === s.id} data-testid="session-revoke">
                    {t('sessions.revoke')}
                  </Button>
                )}
              </TD>
            )}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

'use client';
import type { SessionRow } from '@procure/schema';
import { Card, CardBody, CardHeader, toast } from '@procure/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageBody, PageHeader } from '@/components/page';
import { SessionsTable } from '@/features/users/sessions-table';
import { t } from '@/i18n';
import { http } from '@/lib/api';

export default function MySessionsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me', 'sessions'], queryFn: ({ signal }) => http.get<SessionRow[]>('/auth/sessions', undefined, signal) });
  const revoke = useMutation({
    mutationFn: (id: string) => http.del<void>(`/auth/sessions/${id}`),
    onSuccess: () => { toast.success(t('sessions.revoked')); void qc.invalidateQueries({ queryKey: ['me', 'sessions'] }); },
    onError: e => toast.error(t('sessions.revokeFailed'), (e as Error).message),
  });
  return (
    <PageBody className="max-w-4xl">
      <PageHeader title={t('sessions.myTitle')} description={t('sessions.myDescription')} />
      <Card>
        <CardHeader title={t('sessions.active')} />
        <CardBody className="p-0 sm:p-0">
          <SessionsTable sessions={q.data} loading={q.isLoading} onRevoke={s => revoke.mutate(s.id)} revokingId={revoke.isPending ? revoke.variables : null} />
        </CardBody>
      </Card>
    </PageBody>
  );
}

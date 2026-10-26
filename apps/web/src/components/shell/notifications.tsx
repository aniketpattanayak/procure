'use client';
import type { NotificationRow, Page } from '@procure/schema';
import { Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, Skeleton } from '@procure/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/i18n';
import { http } from '@/lib/api';
import { fmtRelative } from '@/lib/format';

export function NotificationsBell() {
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const unread = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: ({ signal }) => http.get<Page<NotificationRow>>('/notifications', { unread: true, limit: 50 }, signal),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const list = useQuery({
    queryKey: ['notifications', 'recent'],
    queryFn: ({ signal }) => http.get<Page<NotificationRow>>('/notifications', { limit: 15 }, signal),
    enabled: false,
  });
  const markRead = useMutation({
    mutationFn: (id: string) => http.post<void>(`/notifications/${id}/read`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const count = unread.data?.data.length ?? 0;
  const countLabel = count > 9 ? '9+' : String(count);

  return (
    <DropdownMenu open={open} onOpenChange={o => { setOpen(o); if (o) void list.refetch(); }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={count ? t('notifications.labelUnread', { count }) : t('notifications.label')} data-testid="notifications-bell">
          <Bell aria-hidden />
          {count > 0 && (
            <span aria-hidden className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white dark:text-bg">
              {countLabel}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[min(22rem,calc(100vw-2rem))] p-0" data-testid="notifications-panel">
        <div className="border-b border-border px-3 py-2.5 font-medium">{t('notifications.title')}</div>
        <div className="max-h-96 overflow-y-auto">
          {list.isFetching && !list.data ? (
            <div className="space-y-3 p-3" aria-busy="true">
              {[0, 1, 2].map(i => <div key={i} className="space-y-1.5"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>)}
            </div>
          ) : list.isError ? (
            <p className="p-4 text-center text-fg-muted">{t('notifications.error')}</p>
          ) : !list.data?.data.length ? (
            <p className="p-6 text-center text-fg-muted">{t('notifications.empty')}</p>
          ) : (
            <ul>
              {list.data.data.map(n => (
                <li key={n.id} className="border-b border-border last:border-0">
                  <button
                    type="button"
                    className={cn('flex w-full gap-2.5 px-3 py-2.5 text-left hover:bg-subtle focus-visible:bg-subtle focus-visible:outline-none')}
                    onClick={() => {
                      if (!n.readAt) markRead.mutate(n.id);
                      // QA3-BUG-012: close the panel when a notification navigates (it used to stay open over the page).
                      if (n.link) { setOpen(false); router.push(n.link); }
                    }}
                  >
                    <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-accent')} />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block', !n.readAt && 'font-medium')}>
                        {n.title}
                        {!n.readAt && <span className="sr-only"> ({t('notifications.unread')})</span>}
                      </span>
                      {n.body && <span className="mt-0.5 block text-sm text-fg-muted">{n.body}</span>}
                      <span className="mt-0.5 block text-xs text-fg-subtle">{fmtRelative(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

'use client';
import { useQuery } from '@tanstack/react-query';
import { approvalsApi, docKeys } from '@/features/documents/api';

/** GET /approvals/counts, refreshed every minute (dashboard widget, inbox chips). */
export function useInboxCounts(enabled = true) {
  return useQuery({ queryKey: docKeys.inboxCounts, queryFn: approvalsApi.counts, enabled, refetchInterval: 60_000, staleTime: 15_000, retry: false });
}

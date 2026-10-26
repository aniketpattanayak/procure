import { tMaybe } from '@/i18n';

export const MOVEMENT_TYPES = [
  'opening', 'receipt', 'issue', 'return', 'transfer_out', 'transfer_in', 'adjustment_in', 'adjustment_out', 'block', 'unblock', 'reject', 'rtv', 'count_in', 'count_out', 'reversal',
] as const;

/** Display name of a stock movement type (`stock.mv.<type>` in en.json, tenant-overridable). */
export const movementLabel = (m: string) => tMaybe(`stock.mv.${m}`, m.replace(/_/g, ' '));

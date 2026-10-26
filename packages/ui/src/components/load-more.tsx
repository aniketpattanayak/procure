import { Button } from './button';

export function LoadMore({ onClick, loading, hasMore, label = 'Load more', loadingLabel = 'Loading…' }: { onClick: () => void; loading?: boolean; hasMore: boolean; label?: string; loadingLabel?: string }) {
  if (!hasMore) return null;
  return (
    <div className="flex justify-center py-3">
      <Button variant="secondary" size="sm" onClick={onClick} loading={loading}>{loading ? loadingLabel : label}</Button>
    </div>
  );
}

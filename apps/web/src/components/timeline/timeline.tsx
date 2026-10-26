'use client';
import type { TimelineEntry, TimelineKind } from '@procure/schema';
import { cn, Skeleton } from '@procure/ui';
import type { LucideIcon } from 'lucide-react';
import {
  Ban, FilePlus2, Flag, GitPullRequestArrow, History, Lock, MessageSquare, Paperclip, PencilLine, Scale, Send,
} from 'lucide-react';
import { MentionText } from '@/components/comments/mention-text';
import { t } from '@/i18n';
import { fmtDate, fmtTime } from '@/lib/format';

const ICON: Record<TimelineKind, { icon: LucideIcon; tone: string }> = {
  created: { icon: FilePlus2, tone: 'text-fg-muted bg-muted' },
  updated: { icon: PencilLine, tone: 'text-fg-muted bg-muted' },
  submitted: { icon: Send, tone: 'text-accent bg-accent-soft' },
  status: { icon: Flag, tone: 'text-accent bg-accent-soft' },
  workflow: { icon: GitPullRequestArrow, tone: 'text-success bg-success-soft' },
  comment: { icon: MessageSquare, tone: 'text-fg bg-muted' },
  attachment: { icon: Paperclip, tone: 'text-fg-muted bg-muted' },
  cancelled: { icon: Ban, tone: 'text-danger bg-danger-soft' },
  closed: { icon: Lock, tone: 'text-fg-muted bg-muted' },
  quantity: { icon: Scale, tone: 'text-fg-muted bg-muted' },
  audit: { icon: History, tone: 'text-fg-muted bg-muted' },
};

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.map(show).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? '✓' : '✗';
  return String(v);
}

/** Document timeline: every action, comment, attachment and status change, newest first, grouped by day. */
export function Timeline({ entries, loading, error }: { entries: TimelineEntry[] | undefined; loading?: boolean; error?: boolean }) {
  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label={t('common.loading')}>
        {[0, 1, 2, 3].map(i => <div key={i} className="flex gap-3"><Skeleton className="size-8 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div></div>)}
      </div>
    );
  }
  if (error) return <p role="alert" className="text-fg-muted">{t('timeline.error')}</p>;
  if (!entries?.length) return <p className="rounded border border-dashed border-border px-3 py-6 text-center text-fg-muted">{t('timeline.empty')}</p>;

  const groups: { day: string; items: TimelineEntry[] }[] = [];
  for (const e of entries) {
    const day = fmtDate(e.at);
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(e); else groups.push({ day, items: [e] });
  }

  return (
    <div className="space-y-6" data-testid="timeline">
      {groups.map(g => (
        <section key={g.day} aria-label={g.day}>
          <h3 className="mb-3 text-sm font-medium text-fg-muted">{g.day}</h3>
          <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-4 before:top-2 before:w-px before:bg-border">
            {g.items.map(e => <Entry key={e.id} e={e} />)}
          </ol>
        </section>
      ))}
    </div>
  );
}

function Entry({ e }: { e: TimelineEntry }) {
  const { icon: Icon, tone } = ICON[e.kind] ?? ICON.audit;
  return (
    <li className="relative flex gap-3" data-testid="timeline-entry" data-kind={e.kind}>
      <span className={cn('relative z-10 grid size-8 shrink-0 place-items-center rounded-full ring-4 ring-surface', tone)} aria-hidden><Icon className="size-4" /></span>
      <div className="min-w-0 flex-1 pt-1">
        <p className="text-base">
          {e.actor && <span className="font-medium">{e.actor.name} </span>}
          <span className={e.actor ? 'text-fg-muted' : ''}>{e.title}</span>
          <time dateTime={e.at} className="ml-2 text-xs text-fg-subtle">{fmtTime(e.at)}</time>
        </p>
        {(e.onBehalfOf || e.impersonatedBy) && (
          <p className="text-xs text-fg-subtle">
            {e.onBehalfOf && t('timeline.onBehalfOf', { name: e.onBehalfOf.name })}
            {e.impersonatedBy && t('timeline.impersonatedBy', { name: e.impersonatedBy.name })}
          </p>
        )}
        {e.detail && (
          <div className={cn('mt-1.5 rounded border border-border px-3 py-2 text-base', e.kind === 'comment' ? 'bg-surface' : 'bg-subtle')}>
            <MentionText body={e.detail} />
          </div>
        )}
        {!!e.lineDecisions?.length && <LineDecisionsTable rows={e.lineDecisions} />}
        {!!e.changes?.length && <ChangesTable changes={e.changes} />}
      </div>
    </li>
  );
}

function LineDecisionsTable({ rows }: { rows: NonNullable<TimelineEntry['lineDecisions']> }) {
  return (
    <div className="mt-2 overflow-x-auto rounded border border-border">
      <table className="w-full text-sm" data-testid="timeline-decisions">
        <thead className="bg-subtle text-xs text-fg-muted">
          <tr>
            <th scope="col" className="px-2.5 py-1.5 text-right font-medium">#</th>
            <th scope="col" className="px-2.5 py-1.5 text-right font-medium">{t('docs.qty.approved')}</th>
            <th scope="col" className="px-2.5 py-1.5 text-right font-medium">{t('docs.qty.held')}</th>
            <th scope="col" className="px-2.5 py-1.5 text-right font-medium">{t('docs.qty.rejected')}</th>
            <th scope="col" className="px-2.5 py-1.5 text-left font-medium">{t('common.reason')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.lineNo} className="border-t border-border">
              <td className="px-2.5 py-1.5 text-right text-fg-subtle tabular-nums">{r.lineNo}</td>
              <td className={cn('px-2.5 py-1.5 text-right tabular-nums', num(r.approve) ? 'text-success' : 'text-fg-subtle')}>{r.approve ?? '0'}</td>
              <td className={cn('px-2.5 py-1.5 text-right tabular-nums', num(r.hold) ? 'text-warning' : 'text-fg-subtle')}>{r.hold ?? '0'}</td>
              <td className={cn('px-2.5 py-1.5 text-right tabular-nums', num(r.reject) ? 'text-danger' : 'text-fg-subtle')}>{r.reject ?? '0'}</td>
              <td className="px-2.5 py-1.5 text-fg-muted">{r.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const num = (v?: string) => !!v && Number(v) !== 0;

function ChangesTable({ changes }: { changes: NonNullable<TimelineEntry['changes']> }) {
  return (
    <dl className="mt-2 space-y-1 rounded border border-border bg-subtle px-3 py-2 text-sm" data-testid="timeline-changes">
      {changes.map(c => (
        <div key={c.field} className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3">
          <dt className="text-fg-muted">{c.label}</dt>
          <dd className="min-w-0 break-words">
            <del className="text-fg-subtle decoration-danger/60">{show(c.before)}</del>
            <span className="mx-1.5 text-fg-subtle" aria-label={t('timeline.changedTo')}>→</span>
            <ins className="font-medium no-underline">{show(c.after)}</ins>
          </dd>
        </div>
      ))}
    </dl>
  );
}

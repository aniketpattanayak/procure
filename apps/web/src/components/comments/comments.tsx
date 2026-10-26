'use client';
import type { CommentRow } from '@procure/schema';
import { Button, Skeleton, toast } from '@procure/ui';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { deserializeMentions, MentionInput, serializeMentions, type Mention } from './mention-input';
import { MentionText } from './mention-text';

export interface CommentsApi {
  list: () => Promise<CommentRow[]>;
  create: (body: string) => Promise<CommentRow>;
  update: (id: string, body: string) => Promise<CommentRow>;
  remove: (id: string) => Promise<void>;
}

/** Comment thread with @mentions. Authors may edit (server enforces the 15-minute window via `canEdit`) or remove. */
export function Comments({ queryKey, api, canComment, onChanged }: { queryKey: QueryKey; api: CommentsApi; canComment: boolean; onChanged?: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey, queryFn: api.list });
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const changed = () => { void qc.invalidateQueries({ queryKey }); onChanged?.(); };

  const add = useMutation({
    mutationFn: () => api.create(serializeMentions(text.trim(), mentions)),
    onSuccess: () => { setText(''); setMentions([]); changed(); },
    onError: e => toast.error(t('comments.postFailed'), isApiError(e) ? e.message : undefined),
  });
  const submit = () => { if (text.trim() && !add.isPending) add.mutate(); };

  const rows = [...(list.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <div className="space-y-4" data-testid="comments">
      {list.isLoading ? (
        <div className="space-y-3" aria-busy="true">{[0, 1].map(i => <div key={i} className="space-y-1.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-10 w-full" /></div>)}</div>
      ) : rows.length === 0 ? (
        <p className="rounded border border-dashed border-border px-3 py-6 text-center text-fg-muted"><MessageSquare className="mx-auto mb-1 size-5 text-fg-subtle" aria-hidden />{t('comments.empty')}</p>
      ) : (
        <ul className="space-y-3">{rows.map(c => <CommentItem key={c.id} c={c} api={api} onChanged={changed} />)}</ul>
      )}
      {canComment && (
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); submit(); }}>
          <MentionInput value={text} onChange={setText} mentions={mentions} onMentionsChange={setMentions} onSubmit={submit}
            label={t('comments.label')} placeholder={t('comments.placeholder')} />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-fg-subtle">{t('comments.hint')}</p>
            <Button type="submit" size="sm" loading={add.isPending} disabled={!text.trim()} data-testid="comment-submit">{t('comments.post')}</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function CommentItem({ c, api, onChanged }: { c: CommentRow; api: CommentsApi; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const init = deserializeMentions(c.body);
  const [text, setText] = useState(init.text);
  const [mentions, setMentions] = useState<Mention[]>(init.mentions);
  const save = useMutation({
    mutationFn: () => api.update(c.id, serializeMentions(text.trim(), mentions)),
    onSuccess: () => { setEditing(false); onChanged(); },
    onError: e => toast.error(t('comments.editFailed'), isApiError(e) ? e.message : undefined),
  });
  const remove = useMutation({
    mutationFn: () => api.remove(c.id),
    onSuccess: onChanged,
    onError: e => toast.error(t('comments.deleteFailed'), isApiError(e) ? e.message : undefined),
  });
  const removed = !c.body;
  return (
    <li className="flex gap-3" data-testid="comment">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">{initials(c.createdBy.name)}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <span className="font-medium">{c.createdBy.name}</span>
          <time dateTime={c.createdAt} title={fmtDateTime(c.createdAt)} className="ml-2 text-xs text-fg-subtle">{fmtRelative(c.createdAt)}</time>
          {c.editedAt && <span className="ml-1.5 text-xs text-fg-subtle">{t('comments.edited')}</span>}
        </p>
        {editing ? (
          <form className="mt-1 space-y-2" onSubmit={e => { e.preventDefault(); if (text.trim()) save.mutate(); }}>
            <MentionInput value={text} onChange={setText} mentions={mentions} onMentionsChange={setMentions} onSubmit={() => text.trim() && save.mutate()} label={t('comments.editLabel')} testId="comment-edit-input" rows={2} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" loading={save.isPending} disabled={!text.trim()}>{t('comments.save')}</Button>
              <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setText(init.text); }}>{t('common.cancel')}</Button>
            </div>
          </form>
        ) : removed ? (
          <p className="mt-0.5 italic text-fg-subtle">{t('comments.removed')}</p>
        ) : (
          <div className="mt-0.5 text-base"><MentionText body={c.body} /></div>
        )}
        {c.canEdit && !editing && !removed && (
          <div className="mt-1 flex gap-1">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(true)} data-testid="comment-edit"><Pencil aria-hidden />{t('common.edit')}</Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs hover:text-danger" onClick={() => remove.mutate()} loading={remove.isPending} data-testid="comment-delete"><Trash2 aria-hidden />{t('comments.delete')}</Button>
          </div>
        )}
      </div>
    </li>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]!.toUpperCase()).join('');
}

import { Fragment, type ReactNode } from 'react';

/** `@[Name](user:<uuid>)` tokens in comment bodies. */
export const MENTION_RE = /@\[([^\]]{1,120})\]\(user:([0-9a-fA-F-]{36})\)/g;

/** Renders a comment body with mentions as chips; everything else is plain text (line breaks kept). */
export function MentionText({ body, className }: { body: string; className?: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(<Fragment key={`t${last}`}>{body.slice(last, at)}</Fragment>);
    parts.push(
      <span key={`m${at}`} className="mx-px inline-flex items-center rounded bg-accent-soft px-1 font-medium text-accent" data-testid="mention-chip" data-user-id={m[2]}>
        @{m[1]}
      </span>,
    );
    last = at + m[0].length;
  }
  if (last < body.length) parts.push(<Fragment key={`t${last}`}>{body.slice(last)}</Fragment>);
  return <span className={className ?? 'whitespace-pre-wrap break-words'}>{parts}</span>;
}

/** Plain-text preview of a body (mentions as @Name). */
export function mentionPlain(body: string) {
  return body.replace(MENTION_RE, (_m, name: string) => `@${name}`);
}

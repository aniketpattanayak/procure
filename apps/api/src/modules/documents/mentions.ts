/** `@[Name](user:<uuid>)` mentions in comment bodies. */
const MENTION_RE = /@\[([^\]\n]{1,120})\]\(user:([0-9a-fA-F-]{36})\)/g;

export function parseMentions(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) out.add(m[2]!.toLowerCase());
  return [...out];
}

/** Plain-text excerpt with mentions rendered as @Name (for notifications). */
export function plainExcerpt(body: string, max = 140): string {
  const text = body.replace(MENTION_RE, (_m, name: string) => `@${name}`).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

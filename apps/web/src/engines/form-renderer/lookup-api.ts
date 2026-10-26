import type { LocationNode, OptionRow } from '@procure/schema';

/** GET /users/options row. */
export interface UserOption { id: string; name: string; email: string }
import { api } from '@/lib/api';

export type LookupSourceDef =
  | { kind: 'master'; masterKey: string }
  | { kind: 'location'; activeOnly?: boolean; withinScope?: boolean }
  | { kind: 'user'; activeOnly?: boolean };

export interface OptionsRequest {
  q?: string;
  limit?: number;
  /** `targetField:value` pairs; an empty value means "parent not chosen". */
  filter?: string[];
  include?: string[];
  attrs?: string[];
  signal?: AbortSignal;
}

function qs(params: [string, string | number | undefined][]) {
  const sp = new URLSearchParams();
  for (const [k, v] of params) if (v !== undefined && v !== '') sp.append(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** One options feed for every lookup source. Masters use /masters/:key/options (repeated filter/include/attrs). */
export async function fetchOptions(source: LookupSourceDef, req: OptionsRequest): Promise<OptionRow[]> {
  if (source.kind === 'master') {
    // filter=category: (empty) -> [] on the server; short-circuit to save the call.
    if (req.filter?.some(f => f.endsWith(':'))) return [];
    const params: [string, string | number | undefined][] = [['q', req.q?.trim() || undefined], ['limit', req.limit ?? 30]];
    req.filter?.forEach(f => params.push(['filter', f]));
    req.include?.forEach(id => params.push(['include', id]));
    req.attrs?.forEach(a => params.push(['attrs', a]));
    return api<OptionRow[]>(`/masters/${source.masterKey}/options${qs(params)}`, { signal: req.signal });
  }
  if (source.kind === 'location') {
    const nodes = await api<LocationNode[]>(`/locations${qs([
      ['q', req.q?.trim() || undefined],
      ['view', source.activeOnly === false ? 'all' : 'active'],
      ['scope', source.withinScope === false ? 'all' : 'mine'],
    ])}`, { signal: req.signal });
    return nodes.slice(0, req.limit ?? 30).map(n => ({
      id: n.id, code: n.code, name: n.name, isActive: n.isActive,
      label: [...n.pathNames.slice(0, -1), n.name].join(' / ') || n.name,
      attrs: { code: n.code, name: n.name },
    }));
  }
  // Lightweight feed for user lookups (any tenant user; active users only).
  const users = await api<UserOption[]>(`/users/options${qs([['q', req.q?.trim() || undefined], ['limit', req.limit ?? 30]])}`, { signal: req.signal });
  return users.map(u => ({ id: u.id, code: u.email, name: u.name, label: u.name, isActive: true, attrs: { code: u.email, name: u.name, email: u.email } }));
}

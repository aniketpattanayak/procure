import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for outgoing webhooks (contract: URL must resolve to a public IP; re-checked at send time).
 * Blocks loopback, private (RFC 1918 / ULA), link-local (incl. 169.254.169.254 metadata), CGNAT 100.64/10,
 * unspecified, multicast, reserved/documentation/benchmark ranges, and IPv4 embedded in IPv6 (mapped / NAT64 / 6to4).
 */
const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4num = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const V4_RANGES = V4_BLOCKS.map(([base, bits]) => {
  const size = 2 ** (32 - bits);
  const start = Math.floor(v4num(base) / size) * size;
  return { start, end: start + size - 1 };
});

function v4Blocked(ip: string): boolean {
  const n = v4num(ip);
  return V4_RANGES.some(r => n >= r.start && n <= r.end);
}

/** Expands an IPv6 address to 8 16-bit groups (handles :: and a trailing dotted IPv4). */
function v6groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4num(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t];
  if (parts.length !== 8) return null;
  return parts.map(p => parseInt(p || '0', 16));
}

function v6Blocked(ip: string): boolean {
  const g = v6groups(ip);
  if (!g || g.some(x => Number.isNaN(x))) return true;
  const embedded = (hi: number, lo: number) => v4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  if (g.every(x => x === 0)) return true;                                    // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true;          // ::1
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every(x => x === 0)) return true;                        // ::a.b.c.d (deprecated compat)
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6]!, g[7]!);       // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!);                        // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true;                              // fc00::/7 ULA (incl. fd00:ec2::254)
  if ((g[0]! & 0xffc0) === 0xfe80) return true;                              // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true;                              // fec0::/10 site-local
  if ((g[0]! & 0xff00) === 0xff00) return true;                              // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                       // documentation
  if (g[0] === 0x2001 && g[1]! < 0x0200) return true;                        // 2001::/23 IETF special (Teredo, ORCHID, benchmarking)
  if (g[0] === 0x0100 && g.slice(1, 4).every(x => x === 0)) return true;     // 100::/64 discard
  return false;
}

/** True when `ip` must never be contacted by an outgoing webhook. Non-IP input is treated as blocked. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Blocked(ip);
  if (v === 6) return v6Blocked(ip);
  return true;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export const systemResolver: Resolver = host => dnsLookup(host, { all: true, verbatim: true });

export class SsrfError extends Error {
  constructor(message: string) { super(message); this.name = 'SsrfError'; }
}

/**
 * Resolves the URL's host and checks every address. Returns the vetted addresses (the caller connects to one of
 * them, so a DNS answer that changes between check and connect — rebinding — cannot redirect the request).
 */
export async function vetUrl(rawUrl: string, resolve: Resolver = systemResolver): Promise<{ url: URL; addresses: { address: string; family: number }[] }> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new SsrfError('The URL is not valid.'); }
  if (url.protocol !== 'https:') throw new SsrfError('Only HTTPS URLs are allowed.');
  if (url.username || url.password) throw new SsrfError('URLs with credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new SsrfError('This host is not allowed.');
  }
  let addresses: { address: string; family: number }[];
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try { addresses = await resolve(host); } catch { throw new SsrfError(`The host "${host}" could not be resolved.`); }
  }
  if (!addresses.length) throw new SsrfError(`The host "${host}" could not be resolved.`);
  const bad = addresses.find(a => isBlockedIp(a.address));
  if (bad) throw new SsrfError(`The host "${host}" resolves to a private or reserved address (${bad.address}); only public addresses are allowed.`);
  return { url, addresses };
}

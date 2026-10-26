/**
 * Minimal Redis client (RESP over node:net) so E2E needs neither redis-cli nor an npm Redis package.
 * Only what the suite needs: SCAN-free key deletion by pattern (via EVAL) and FLUSHDB.
 */
import { createConnection } from 'node:net';

const url = new URL(process.env.E2E_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379');
const db = Number(url.pathname.slice(1) || 0);

function encode(args: (string | number)[]) {
  return `*${args.length}\r\n${args.map(a => { const s = String(a); return `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }).join('')}`;
}

/** Sends commands in one pipeline and resolves once a reply line per command has arrived (simple replies only). */
export function redis(...commands: (string | number)[][]): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: url.hostname, port: Number(url.port || 6379) });
    let buf = '';
    const all = [['SELECT', db], ...commands];
    sock.setTimeout(5_000, () => { sock.destroy(); reject(new Error('redis timeout')); });
    sock.on('error', reject);
    sock.on('data', d => {
      buf += d.toString();
      const replies = buf.split('\r\n').filter(l => /^[+\-:]/.test(l));
      if (replies.length >= all.length) {
        sock.end();
        const err = replies.find(l => l.startsWith('-'));
        if (err) reject(new Error(err)); else resolve(buf);
      }
    });
    sock.write(all.map(encode).join(''));
  });
}

/** Deletes every key matching a glob pattern (server-side Lua, one round trip). */
export function delPattern(pattern: string) {
  const lua = "local n=0 for _,k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) n=n+1 end return n";
  return redis(['EVAL', lua, 0, pattern]);
}

export const flushdb = () => redis(['FLUSHDB']);

/**
 * Deletes every key except BullMQ's (`procure:<env>:*`, ADR-0012). Phase 3: the API registers its repeatable jobs
 * (outbox relay every 2 s, workflow-sla every minute, audit-verify nightly) when it boots, which is BEFORE global
 * setup runs; a FLUSHDB there silently removed them, so SLA reminders/escalations never ran during E2E.
 */
export function flushAppKeys() {
  const lua = "local n=0 for _,k in ipairs(redis.call('KEYS', '*')) do if string.sub(k, 1, 8) ~= 'procure:' then redis.call('DEL', k) n=n+1 end end return n";
  return redis(['EVAL', lua, 0]);
}

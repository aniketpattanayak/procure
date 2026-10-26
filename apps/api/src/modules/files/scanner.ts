import { connect } from 'node:net';

export type ScanResult = { status: 'clean' } | { status: 'infected'; signature: string } | { status: 'error'; message: string };

/** Virus scanner seam (ADR-0008). Files are served only once a scanner marked them clean. */
export interface Scanner {
  readonly kind: 'noop' | 'clamav';
  scan(body: Buffer): Promise<ScanResult>;
}

/** Dev/test: everything is clean. */
export class NoopScanner implements Scanner {
  readonly kind = 'noop' as const;
  async scan(): Promise<ScanResult> {
    return { status: 'clean' };
  }
}

/**
 * clamd INSTREAM over TCP: `zINSTREAM\0`, then chunks of <uint32 BE length><bytes>, then a zero-length chunk.
 * clamd answers `stream: OK\0`, `stream: <Signature> FOUND\0` or `... ERROR\0`.
 */
export class ClamAvScanner implements Scanner {
  readonly kind = 'clamav' as const;
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
    private readonly chunkSize = 64 * 1024,
  ) {}

  scan(body: Buffer): Promise<ScanResult> {
    return new Promise(resolvePromise => {
      let settled = false;
      const done = (r: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolvePromise(r);
      };
      const chunks: Buffer[] = [];
      const socket = connect({ host: this.host, port: this.port }, () => {
        socket.write(Buffer.from('zINSTREAM\0', 'latin1'));
        for (let off = 0; off < body.length; off += this.chunkSize) {
          const part = body.subarray(off, Math.min(off + this.chunkSize, body.length));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length, 0);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // end of stream
      });
      socket.setTimeout(this.timeoutMs, () => done({ status: 'error', message: 'clamd timed out' }));
      socket.on('data', d => {
        chunks.push(d);
        if (d.includes(0)) done(parseClamReply(Buffer.concat(chunks).toString('latin1')));
      });
      socket.on('end', () => done(parseClamReply(Buffer.concat(chunks).toString('latin1'))));
      socket.on('error', e => done({ status: 'error', message: e.message }));
    });
  }
}

export function parseClamReply(raw: string): ScanResult {
  const reply = raw.replace(/\0/g, '').trim();
  if (!reply) return { status: 'error', message: 'empty reply from clamd' };
  const body = reply.replace(/^stream:\s*/, '');
  if (body === 'OK') return { status: 'clean' };
  const found = /^(.*)\s+FOUND$/.exec(body);
  if (found) return { status: 'infected', signature: found[1]!.trim() };
  return { status: 'error', message: body };
}

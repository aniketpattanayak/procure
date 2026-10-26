/**
 * Resilience of the DB pools under connection loss (failover, pgbouncer restart, idle-timeout kill, `db:reset`).
 *
 * QA-BUG-001 (fixed): DbService used to create its pg Pools without an 'error' listener. When Postgres terminates an *idle* pooled
 * connection, pg emits 'error' on the Pool and, with no listener, Node throws "Unhandled 'error' event" and the API
 * process exits (seen when running `pnpm db:reset` with the API up). The test runs the real built API (dist/main.js)
 * as a child process, terminates its idle connections, and expects it to stay up.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const apiRoot = resolve(__dirname, '..');
const PORT = 4799;

async function waitHealthy(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return true; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

describe('resilience: DB connection loss', () => {
  let child: ChildProcess | null = null;
  let exitCode: number | null = null;
  let stderr = '';

  afterAll(() => { child?.kill('SIGTERM'); });

  const built = existsSync(resolve(apiRoot, 'dist/main.js'));

  it.skipIf(!built)('[QA-BUG-001] API survives Postgres terminating its idle pool connections', async () => {
    child = spawn(process.execPath, ['dist/main.js'], {
      cwd: apiRoot,
      env: { ...process.env, API_PORT: String(PORT), NODE_ENV: 'development' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr!.on('data', d => { stderr += String(d); });
    child.on('exit', code => { exitCode = code ?? -1; });
    expect(await waitHealthy(15_000)).toBe(true);
    // Warm both pools (health uses the platform pool; a failed login touches it too).
    for (let i = 0; i < 3; i++) await fetch(`http://localhost:${PORT}/health`);

    const admin = new Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
    await admin.connect();
    const r = await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = current_database() and usename in ('app_user', 'platform_user') and pid <> pg_backend_pid() and state = 'idle'`);
    await admin.end();
    expect(r.rowCount).toBeGreaterThan(0);

    await new Promise(res => setTimeout(res, 1_000));
    expect(exitCode, `API exited: ${stderr.split('\n').find(l => l.includes('Error') || l.includes('error:')) ?? ''}`).toBeNull();
    expect(await waitHealthy(5_000)).toBe(true);
  }, 30_000);
});

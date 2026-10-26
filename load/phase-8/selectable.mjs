#!/usr/bin/env node
/**
 * Selectable-lines picker (vendor selection) on tenant `big`. The dataset runs with flow.vendor_selection.enabled =
 * false (POs straight from indents), so this switches the setting ON through the API, measures, and switches it back.
 *   API=… node load/phase-8/selectable.mjs <label> [N=30]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { call, loadAvg, login, ok, stats } from './lib.mjs';

const [label = 'run', nArg] = process.argv.slice(2);
const N = Number(nArg ?? 30);
const admin = await login('big', 'admin@big.test', 'Admin@12345');
await ok('PUT', '/config/settings', { token: admin, body: { 'flow.vendor_selection.enabled': true } });
const out = {};
try {
  for (const [name, path] of [['selectable lines (admin)', '/procurement/selectable-lines?limit=100'], ['selectable lines search', '/procurement/selectable-lines?limit=100&q=Valve'],
    ['selectable lines search (no match)', '/procurement/selectable-lines?limit=100&q=zzqx']]) {
    const ms = [];
    let status;
    for (let i = 0; i < N + 3; i++) { const r = await call('GET', path, { token: admin }); status = r.status; if (i >= 3) ms.push(r.ms); }
    out[name] = { status, ...stats(ms) };
    console.log(name, JSON.stringify(out[name]));
  }
} finally {
  await ok('PUT', '/config/settings', { token: admin, body: { 'flow.vendor_selection.enabled': false } });
}
await mkdir(new URL('../results/phase-8/', import.meta.url), { recursive: true });
await writeFile(new URL(`../results/phase-8/${label}-selectable.json`, import.meta.url), JSON.stringify({ label, loadAvg: await loadAvg(), out }, null, 2));

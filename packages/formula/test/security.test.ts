import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, evaluate, parse } from '../src';
import { SCOPE, TODAY } from './helpers';

const run = (src: string, values: Record<string, unknown> = {}, extra = {}) =>
  evaluate(src, { values, today: TODAY, ...extra });

describe('injection attempts never reach host objects', () => {
  it.each([
    'constructor',
    '__proto__',
    'prototype',
    'this',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'globalThis',
    'window',
    'process',
    'require',
    'constructor.name',
    '__proto__.polluted',
    'values.constructor',
    'lines.constructor',
  ])('%s reads as empty', src => {
    expect(run(src)).toEqual({ value: null });
  });

  it('host names are unknown at design time', () => {
    for (const src of ['constructor', '__proto__', 'this', 'toString']) {
      expect(compile(src, SCOPE).errors[0]!.code).toBe('UNKNOWN_FIELD');
    }
    expect(compile('vendor.constructor', SCOPE).errors[0]!.code).toBe('UNKNOWN_FIELD');
    expect(compile('vendor.__proto__', SCOPE).errors[0]!.code).toBe('UNKNOWN_FIELD');
  });

  it.each([
    'constructor(1)',
    'TOSTRING()',
    'eval("1")',
    'Function("return 1")',
    'require("fs")',
    'HASOWNPROPERTY(1)',
    '__PROTO__(1)',
    'valueOf()',
  ])('%s is an unknown function', src => expect(run(src).error?.code).toBe('UNKNOWN_FUNCTION'));

  it('member-access syntax is not part of the language', () => {
    for (const src of [
      "x['constructor']",
      'x[0]',
      'a.b.c',
      'a.constructor.constructor',
      '`x`',
      'x => 1',
      'x; y',
      '{a: 1}',
      'x = 1; y',
      '$x',
      'a?.b',
    ]) {
      expect(parse(src).errors[0]?.code, src).toBe('SYNTAX');
    }
  });

  it('own-property reads only, even with hostile contexts', () => {
    const values = JSON.parse(
      '{"__proto__": {"secret": "leak"}, "lines": [{"__proto__": {"amount": "999"}}]}',
    ) as Record<string, unknown>;
    expect(run('secret', values).value).toBeNull();
    expect(
      run('lookupx.secret', values, { lookups: JSON.parse('{"lookupx": {"__proto__": {"secret": 1}}}') }).value,
    ).toBeNull();
    expect(run('COUNT(lines)', values).value).toBe('1');
    const inherited = Object.create({ qty: '5' }) as Record<string, unknown>;
    expect(run('qty * 2', inherited).value).toBe('0');
    expect(run('vendor.code', {}, { lookups: { vendor: Object.create({ code: 'x' }) } }).value).toBeNull();
    expect(run('qty', {}, { row: Object.create({ qty: '1' }) }).value).toBeNull();
    expect(({} as Record<string, unknown>).secret).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('strings that look like code stay data', () => {
    expect(run("'); process.exit(1); ('").value).toBe('); process.exit(1); (');
    expect(run('x & "${1+1}"', { x: '<script>' }).value).toBe('<script>${1+1}');
    expect(run('x', { x: 'constructor' }).value).toBe('constructor');
  });
});

describe('hostile input sizes terminate fast', () => {
  const fast = (src: string) => {
    const t0 = performance.now();
    const r = run(src);
    expect(performance.now() - t0).toBeLessThan(200);
    return r;
  };
  it('very long input', () => {
    expect(fast('1+'.repeat(500_000) + '1').error?.code).toBe('LIMIT');
    expect(fast("'" + 'a'.repeat(1_000_000)).error?.code).toBe('LIMIT');
  });
  it('deep nesting cannot overflow the stack', () => {
    expect(fast('('.repeat(1999) + '1').error?.code).toBe('LIMIT');
    expect(fast('-'.repeat(1999) + '1').error?.code).toBe('LIMIT');
    expect(fast('NOT '.repeat(499) + 'TRUE').error?.code).toBe('LIMIT');
  });
  it('max-size expressions evaluate quickly', () => {
    expect(fast(Array.from({ length: 250 }, () => '1').join('*')).value).toBe('1');
    expect(
      fast(Array.from({ length: 49 }, () => 'IF(TRUE, ').join('') + '1' + ')'.repeat(49).replace(/\)/g, ', 0)')).value,
    ).toBe('1');
    expect(fast('9e999 * 9e999 * 9e999').error?.code).toBe('RUNTIME');
    expect(fast('ROUND(1e999, 20)').value).toMatch(/^10{999}$/);
    expect(fast("ADD_DAYS('2026-01-01', 1e900)").error?.code).toBe('RUNTIME');
    expect(fast("LEFT('abc', 1e900)").error?.code).toBe('RUNTIME');
  });
  it('big grids in aggregates', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => ({ amount: String(i) }));
    const t0 = performance.now();
    expect(run('SUM(lines.amount * 2) + COUNTIF(lines.amount > 10)', { lines }).value).toBe('24999989');
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('source hygiene: runs unchanged in Node and the browser', () => {
  const dir = join(__dirname, '..', 'src');
  const files = readdirSync(dir).filter(f => f.endsWith('.ts'));
  it.each(files)('%s has no eval/Function and no Node built-ins', f => {
    const src = readFileSync(join(dir, f), 'utf8');
    expect(src).not.toMatch(/\beval\s*\(/);
    expect(src).not.toMatch(/new\s+Function\b|\bFunction\s*\(/);
    expect(src).not.toMatch(/from\s+'node:|require\(|from\s+'(fs|path|os|crypto|util|vm|child_process)'/);
    expect(src).not.toMatch(/new Date\(/);
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
    for (const i of imports)
      expect(['@procure/schema', 'decimal.js'].includes(i!) || i!.startsWith('./'), `${f}: ${i}`).toBe(true);
  });
});

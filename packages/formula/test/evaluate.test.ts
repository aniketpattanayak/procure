import { describe, expect, it } from 'vitest';
import { evaluate } from '../src';
import { err, TODAY, val } from './helpers';

describe('arithmetic', () => {
  it.each([
    ['1 + 2', '3'],
    ['5 - 7', '-2'],
    ['3 * 4', '12'],
    ['7 / 2', '3.5'],
    ['7 % 3', '1'],
    ['-7 % 3', '-1'],
    ['-(2 + 3)', '-5'],
    ['--4', '4'],
    ['2 + 3 * 4', '14'],
    ['(2 + 3) * 4', '20'],
    ['10 - 4 - 3', '3'],
    ['1e3 + 1', '1001'],
    ['0 * -1', '0'],
  ])('%s = %s', (src, expected) => expect(val(src)).toBe(expected));

  it('is decimal-exact', () => {
    expect(val('0.1 + 0.2')).toBe('0.3');
    expect(val('0.1 + 0.2 = 0.3')).toBe(true);
    expect(val('1.1 * 1.1')).toBe('1.21');
    expect(val('0.3 - 0.1')).toBe('0.2');
    expect(val('123456789012345678901234567890 + 1')).toBe('123456789012345678901234567891');
    expect(val('1 / 3 * 3', {}, { defaultPrecision: 2 })).toBe('1.00');
    expect(val('1 / 3')).toBe('0.3333333333333333333333333333333333333333');
  });

  it('rounds half-up to defaultPrecision', () => {
    expect(val('2.675', {}, { defaultPrecision: 2 })).toBe('2.68');
    expect(val('2.665', {}, { defaultPrecision: 2 })).toBe('2.67');
    expect(val('-2.675', {}, { defaultPrecision: 2 })).toBe('-2.68');
    expect(val('1.005 * 1000 / 1000', {}, { defaultPrecision: 2 })).toBe('1.01');
    expect(val('-0.001', {}, { defaultPrecision: 2 })).toBe('0.00');
    expect(val('5', {}, { defaultPrecision: 0 })).toBe('5');
  });

  it('reads decimal strings and JS numbers from values', () => {
    expect(val('qty * rate', { qty: '3', rate: '2.50' })).toBe('7.5');
    expect(val('qty * rate', { qty: 3, rate: 0.1 })).toBe('0.3');
  });

  it('division by zero is a runtime error, never Infinity', () => {
    expect(err('1 / 0')).toEqual({ code: 'RUNTIME', message: 'Division by zero', start: 0, end: 5 });
    expect(err('qty / rate', { qty: '1' })).toMatchObject({ code: 'RUNTIME', start: 0, end: 10 });
    expect(err('5 % 0')).toMatchObject({ code: 'RUNTIME', message: 'Division by zero' });
    expect(err('2 + 10 / (5 - 5)')).toMatchObject({ start: 4, end: 15 });
  });

  it('overflow is a runtime error', () => {
    expect(err('1e900 * 1e900')).toMatchObject({ code: 'RUNTIME', message: 'Number is too large' });
    expect(err('9e1000 + 9e1000')).toMatchObject({ code: 'RUNTIME' });
    expect(err('SUM(9e1000, 9e1000)')).toMatchObject({ code: 'RUNTIME' });
    expect(val('1e-900 / 1e900 = 0')).toBe(true); // underflow is 0
  });

  it('text in arithmetic is a runtime error when untyped', () => {
    expect(err('name * 2', { name: 'abc' })).toMatchObject({
      code: 'RUNTIME',
      message: "Expected a number but got 'abc'",
      start: 0,
      end: 4,
    });
    expect(err('flag + 1', { flag: true })).toMatchObject({ code: 'RUNTIME' });
    expect(err('-flag', { flag: true })).toMatchObject({ code: 'RUNTIME' });
  });
});

describe('null semantics', () => {
  it('arithmetic treats null as 0', () => {
    expect(val('qty * rate', { qty: '5' })).toBe('0');
    expect(val('qty + rate', { qty: '5', rate: null })).toBe('5');
    expect(val('qty + rate', { qty: '5', rate: '' })).toBe('5');
    expect(val('-x')).toBe('0');
    expect(val('NULL + 1')).toBe('1');
  });
  it('null = null is TRUE; != is TRUE with exactly one null; ordering with null is FALSE', () => {
    expect(val('NULL = NULL')).toBe(true);
    expect(val('a = b')).toBe(true);
    expect(val('a = 1')).toBe(false);
    expect(val('a != 1')).toBe(true);
    expect(val('a <> 1')).toBe(true);
    expect(val("'x' != a")).toBe(true);
    expect(val('1 <> NULL')).toBe(true);
    expect(val('NULL != NULL')).toBe(false);
    expect(val('a <> b')).toBe(false);
    expect(val('a != 1', { a: '1' })).toBe(false);
    expect(val('a > 1')).toBe(false);
    expect(val('1 <= a')).toBe(false);
    expect(val('NULL < NULL')).toBe(false);
    expect(val('NULL >= NULL')).toBe(false);
    expect(val("priority != 'Urgent'")).toBe(true); // empty select is "not Urgent"
    expect(val('a < 1')).toBe(false);
    expect(val('a >= 0')).toBe(false);
    expect(val("a = ''")).toBe(true); // empty text is null
    expect(val("name = ''", { name: '' })).toBe(true);
  });
  it('null in conditions is FALSE', () => {
    expect(val('IF(flag, 1, 2)')).toBe('2');
    expect(val('NOT flag')).toBe(true);
    expect(val('flag AND TRUE')).toBe(false);
    expect(val('flag OR TRUE')).toBe(true);
  });
  it('null in text concatenation is empty', () => {
    expect(val("'a' & x & 'b'")).toBe('ab');
    expect(val('x & y')).toBeNull();
    expect(val("''")).toBeNull();
  });
});

describe('comparison', () => {
  it.each([
    ['1 = 1', true],
    ['1 = 1.0', true],
    ['2 > 1', true],
    ['2 < 1', false],
    ['2 >= 2', true],
    ['2 <= 1.99', false],
    ["'a' = 'a'", true],
    ["'a' = 'A'", false],
    ["'a' < 'b'", true],
    ["'b' > 'a'", true],
    ["'abc' != 'abd'", true],
    ['TRUE = TRUE', true],
    ['TRUE != FALSE', true],
    ['true = FALSE', false],
    ["DATE('2026-01-01') < DATE('2026-01-02')", true],
    ["DATE('2026-01-01') = '2026-01-01'", true],
  ])('%s -> %s', (src, expected) => expect(val(src)).toBe(expected));
  it('dynamic mixed comparisons', () => {
    expect(val("x = '10'", { x: '10' })).toBe(true);
    expect(val("x = '010'", { x: 10 })).toBe(true); // numeric text compares numerically
    expect(val("x = 'abc'", { x: 10 })).toBe(false);
    expect(val("'abc' = x", { x: 10 })).toBe(false);
    expect(val("'5' < x", { x: 10 })).toBe(true);
    expect(val('x = 1', { x: true })).toBe(false);
    expect(val('x != 1', { x: true })).toBe(true);
    expect(val('x = 1', { x: ['a'] })).toBe(false);
    expect(err('x < 1', { x: true })).toMatchObject({ code: 'RUNTIME' });
    expect(err('x > TRUE', { x: true })).toMatchObject({ code: 'RUNTIME' });
  });
});

describe('logic', () => {
  it('operators and functions', () => {
    expect(val('TRUE AND FALSE')).toBe(false);
    expect(val('TRUE && TRUE')).toBe(true);
    expect(val('FALSE OR TRUE')).toBe(true);
    expect(val('FALSE || FALSE')).toBe(false);
    expect(val('NOT TRUE')).toBe(false);
    expect(val('!FALSE')).toBe(true);
    expect(val('AND(TRUE, TRUE, FALSE)')).toBe(false);
    expect(val('OR(FALSE, FALSE, TRUE)')).toBe(true);
    expect(val('NOT(FALSE)')).toBe(true);
  });
  it('is lazy (short-circuit)', () => {
    expect(val('FALSE AND 1/0 = 1')).toBe(false);
    expect(val('TRUE OR 1/0 = 1')).toBe(true);
    expect(val('AND(FALSE, 1/0 = 1)')).toBe(false);
    expect(val('OR(TRUE, 1/0 = 1)')).toBe(true);
    expect(val('IF(TRUE, 1, 1/0)')).toBe('1');
    expect(val('IF(FALSE, 1/0, 2)')).toBe('2');
    expect(val('IFS(TRUE, 1, 1/0 > 0, 2, 3)')).toBe('1');
    expect(val('COALESCE(1, 1/0)')).toBe('1');
  });
  it('non-boolean condition at runtime', () => {
    expect(err('x AND TRUE', { x: 'yes' })).toMatchObject({
      code: 'RUNTIME',
      message: "Expected TRUE/FALSE but got 'yes'",
    });
    expect(err('IF(x, 1, 2)', { x: '2026-01-01' })).toMatchObject({
      code: 'RUNTIME',
      message: 'Expected TRUE/FALSE but got the date 2026-01-01',
    });
    expect(err('NOT x', { x: ['a'] })).toMatchObject({ message: 'Expected TRUE/FALSE but got a list' });
  });
});

describe('text', () => {
  it('& concatenation formats plainly', () => {
    expect(val("'Total: ' & 1250.50")).toBe('Total: 1250.5');
    expect(val("'d=' & DATE('2026-03-01')")).toBe('d=2026-03-01');
    expect(val("'b=' & TRUE")).toBe('b=TRUE');
    expect(val("'' & 0")).toBe('0');
    expect(val("'n=' & -0")).toBe('n=0');
    expect(val("'tags=' & tags", { tags: ['a', 'b'] })).toBe('tags=a, b');
  });
  it('escapes survive evaluation', () => {
    expect(val("'it\\'s'")).toBe("it's");
    expect(val('"say \\"hi\\""')).toBe('say "hi"');
    expect(val("'a\\\\b'")).toBe('a\\b');
  });
});

describe('references in standalone evaluate', () => {
  it('unknown names are empty', () => {
    expect(val('missing')).toBeNull();
    expect(val('missing.attr')).toBeNull();
  });
  it('lookup attributes', () => {
    const lookups = { vendor: { code: 'V1', credit_days: '30' } };
    expect(val('vendor.code', { vendor: 'id-1' }, { lookups })).toBe('V1');
    expect(val('ADD_DAYS(TODAY(), vendor.credit_days)', {}, { lookups })).toBe('2026-11-21');
    expect(val('vendor.missing', {}, { lookups })).toBeNull();
    expect(val('vendor.code', {}, { lookups: { vendor: null } })).toBeNull();
    expect(val('qty.attr', { qty: '1' })).toBeNull();
  });
  it('grid rows and the current row', () => {
    const values = { lines: [{ qty: '2', rate: '5' }, { qty: '3', rate: '1.5' }, null], freight: '10' };
    expect(val('SUM(lines.qty * lines.rate) + freight', values)).toBe('24.5');
    expect(val('COUNT(lines)', values)).toBe('2');
    expect(val('qty * rate + freight', values, { row: { qty: '2', rate: '3' } })).toBe('16');
    expect(val('item.uom', {}, { row: { item: 'x' }, rowLookups: { item: { uom: 'kg' } } })).toBe('kg');
    expect(val('item.uom', {}, { row: {}, rowLookups: { item: null } })).toBeNull();
  });
  it('rounds only when defaultPrecision is given', () => {
    expect(evaluate('10 / 4', { values: {}, today: TODAY })).toEqual({ value: '2.5' });
    expect(evaluate('10 / 4', { values: {}, today: TODAY, defaultPrecision: 0 })).toEqual({ value: '3' });
  });
  it('returns non-number values as-is', () => {
    expect(val('tags', { tags: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(val('tags', { tags: [] })).toBeNull();
    expect(val('d', { d: '2026-02-03' })).toBe('2026-02-03');
    expect(val('o', { o: { from: '2026-01-01' } })).toBeNull();
    expect(val('TRUE')).toBe(true);
  });
  it('compile-level errors come back as the error', () => {
    expect(evaluate('1 +', { values: {}, today: TODAY }).error).toMatchObject({ code: 'SYNTAX' });
    expect(evaluate('NOPE(1)', { values: {}, today: TODAY }).error).toMatchObject({ code: 'UNKNOWN_FUNCTION' });
    expect(evaluate("1 + 'a'", { values: {}, today: TODAY }).error).toMatchObject({ code: 'TYPE' });
  });
});

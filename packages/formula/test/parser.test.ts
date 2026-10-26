import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, MAX_NODES, MAX_SOURCE_LENGTH, parse } from '../src';
import type { Node } from '../src';

/** Compact s-expression of an AST, for precedence assertions. */
function sx(n: Node): string {
  switch (n.type) {
    case 'number':
      return n.value;
    case 'string':
      return JSON.stringify(n.value);
    case 'boolean':
      return n.value ? 'TRUE' : 'FALSE';
    case 'null':
      return 'NULL';
    case 'ref':
      return n.attr === undefined ? n.name : `${n.name}.${n.attr}`;
    case 'unary':
      return `(${n.op} ${sx(n.operand)})`;
    case 'binary':
      return `(${n.op} ${sx(n.left)} ${sx(n.right)})`;
    case 'call':
      return `${n.name}(${n.args.map(sx).join(', ')})`;
  }
}

const p = (src: string): string => {
  const r = parse(src);
  if (!r.ast) throw new Error(`${src}: ${JSON.stringify(r.errors)}`);
  return sx(r.ast);
};
const perr = (src: string) => {
  const r = parse(src);
  expect(r.ast).toBeNull();
  return r.errors[0]!;
};

describe('lexer', () => {
  it('numbers', () => {
    expect(p('12')).toBe('12');
    expect(p('0.5')).toBe('0.5');
    expect(p('1e3')).toBe('1e3');
    expect(p('2.5E-2')).toBe('2.5E-2');
    expect(p('1e+2')).toBe('1e+2');
  });
  it('rejects malformed numbers', () => {
    expect(perr('1.')).toMatchObject({ code: 'SYNTAX', start: 0, end: 2 });
    expect(perr('1e')).toMatchObject({ code: 'SYNTAX', message: "Invalid number '1e'" });
    expect(perr('12abc')).toMatchObject({ code: 'SYNTAX', message: "Invalid number '12abc'", start: 0, end: 5 });
    expect(perr('1.2.3')).toMatchObject({ code: 'SYNTAX' });
    expect(perr('1e5000')).toMatchObject({ code: 'LIMIT' });
  });
  it('strings with both quotes and escapes', () => {
    expect(p("'Urgent'")).toBe('"Urgent"');
    expect(p('"it\'s"')).toBe('"it\'s"');
    expect(p("'it\\'s'")).toBe('"it\'s"');
    expect(p('"say \\"hi\\""')).toBe('"say \\"hi\\""');
    expect(p("'back\\\\slash'")).toBe('"back\\\\slash"');
    expect(p("''")).toBe('""');
  });
  it('rejects bad strings', () => {
    expect(perr("'abc")).toMatchObject({
      code: 'SYNTAX',
      message: 'Text is missing its closing quote',
      start: 0,
      end: 4,
    });
    expect(perr("'a\\nb'")).toMatchObject({ code: 'SYNTAX', start: 2, end: 4 });
    expect(perr("'a\\")).toMatchObject({ code: 'SYNTAX' });
  });
  it('booleans, null and keywords are case-insensitive', () => {
    expect(p('TRUE')).toBe('TRUE');
    expect(p('true')).toBe('TRUE');
    expect(p('False')).toBe('FALSE');
    expect(p('null')).toBe('NULL');
    expect(p('a and b Or c')).toBe('(OR (AND a b) c)');
    expect(p('not a')).toBe('(NOT a)');
  });
  it('references', () => {
    expect(p('qty')).toBe('qty');
    expect(p('vendor.gstin')).toBe('vendor.gstin');
    expect(p('lines.amount')).toBe('lines.amount');
    expect(perr('a.b.c')).toMatchObject({
      code: 'SYNTAX',
      message: "Only one level of '.' is allowed in 'a.b.c'",
      start: 0,
      end: 5,
    });
    expect(perr('a.')).toMatchObject({ code: 'SYNTAX', start: 0, end: 2 });
    expect(perr('a. b')).toMatchObject({ code: 'SYNTAX' });
    expect(perr('vendor.name(1)')).toMatchObject({ code: 'SYNTAX', message: "'vendor.name' is not a function" });
  });
  it('operators and aliases', () => {
    expect(p('a <> b')).toBe('(!= a b)');
    expect(p('a != b')).toBe('(!= a b)');
    expect(p('a && b || !c')).toBe('(OR (AND a b) (NOT c))');
    expect(perr('a == b')).toMatchObject({ code: 'SYNTAX', message: "Use '=' to compare, not '=='" });
    expect(perr('a | b')).toMatchObject({ code: 'SYNTAX', start: 2, end: 3 });
    expect(perr('a $ b')).toMatchObject({ code: 'SYNTAX', message: "Unexpected character '$'", start: 2, end: 3 });
    expect(perr('qty ^ 2')).toMatchObject({ code: 'SYNTAX' });
  });
  it('whitespace incl. newlines and tabs', () => {
    expect(p(' \tqty\r\n*\n2 ')).toBe('(* qty 2)');
  });
});

describe('precedence (low -> high): OR · AND · NOT · comparison · & · + - · * / % · unary - · call', () => {
  it.each([
    ['a OR b AND c', '(OR a (AND b c))'],
    ['a AND b OR c', '(OR (AND a b) c)'],
    ['NOT a AND b', '(AND (NOT a) b)'],
    ['NOT a = b', '(NOT (= a b))'],
    ['NOT a OR b', '(OR (NOT a) b)'],
    ['a = b AND c < d', '(AND (= a b) (< c d))'],
    ["a & b = 'x'", '(= (& a b) "x")'],
    ['a + b & c', '(& (+ a b) c)'],
    ['a & b + c', '(& a (+ b c))'],
    ['a + b * c', '(+ a (* b c))'],
    ['a * b + c', '(+ (* a b) c)'],
    ['a - b - c', '(- (- a b) c)'],
    ['a / b * c % d', '(% (* (/ a b) c) d)'],
    ['-a * b', '(* (- a) b)'],
    ['a * -b', '(* a (- b))'],
    ['--a', '(- (- a))'],
    ['-SUM(x) + 1', '(+ (- SUM(x)) 1)'],
    ['(a + b) * c', '(* (+ a b) c)'],
    ['a < b', '(< a b)'],
    ['a <= b', '(<= a b)'],
    ['a > b', '(> a b)'],
    ['a >= b', '(>= a b)'],
    ['a = NOT b', '(= a (NOT b))'],
    ['!a = b', '(NOT (= a b))'],
    ['NOT(a) = b', '(= NOT(a) b)'],
    ['AND(a, b, c)', 'AND(a, b, c)'],
    ['or(a)', 'OR(a)'],
    ['round(qty, 2)', 'ROUND(qty, 2)'],
    ['TODAY()', 'TODAY()'],
    ['IF(a, f(b, c), (d))', 'IF(a, F(b, c), d)'],
  ])('%s', (src, expected) => expect(p(src)).toBe(expected));
});

describe('syntax errors carry offsets', () => {
  it('empty', () => expect(perr('   ')).toMatchObject({ code: 'SYNTAX', message: 'Formula is empty' }));
  it('trailing operator', () =>
    expect(perr('qty *')).toMatchObject({ code: 'SYNTAX', message: 'Formula ends unexpectedly', start: 5, end: 5 }));
  it('dangling token', () =>
    expect(perr('qty rate')).toMatchObject({ code: 'SYNTAX', message: "Unexpected 'rate'", start: 4, end: 8 }));
  it('missing paren', () => expect(perr('(a + b')).toMatchObject({ code: 'SYNTAX', message: "Missing ')'", start: 0 }));
  it('wrong closer', () => expect(perr('(a + b,')).toMatchObject({ code: 'SYNTAX', message: "Unexpected ','" }));
  it('missing call paren', () => expect(perr('SUM(a, b')).toMatchObject({ code: 'SYNTAX', start: 0, end: 8 }));
  it('bad separator', () =>
    expect(perr('SUM(a b)')).toMatchObject({
      code: 'SYNTAX',
      message: "Expected ',' or ')' but found 'b'",
      start: 6,
      end: 7,
    }));
  it('trailing comma', () =>
    expect(perr('SUM(a,)')).toMatchObject({ code: 'SYNTAX', message: "Unexpected ')'", start: 6 }));
  it('bare AND', () => expect(perr('AND')).toMatchObject({ code: 'SYNTAX', message: "Unexpected 'AND'" }));
  it('unexpected operator', () => expect(perr('* 2')).toMatchObject({ code: 'SYNTAX', start: 0, end: 1 }));
  it('unexpected )', () => expect(perr(')')).toMatchObject({ code: 'SYNTAX' }));
  it('non-string input', () => expect(perr(42 as unknown as string)).toMatchObject({ code: 'SYNTAX' }));
});

describe('limits', () => {
  it(`source > ${MAX_SOURCE_LENGTH} characters`, () => {
    const ok = `'${'x'.repeat(MAX_SOURCE_LENGTH - 2)}'`;
    expect(parse(ok).errors).toEqual([]);
    expect(perr(ok + ' ')).toMatchObject({ code: 'LIMIT', start: MAX_SOURCE_LENGTH, end: MAX_SOURCE_LENGTH + 1 });
  });
  it(`AST > ${MAX_NODES} nodes`, () => {
    expect(parse(Array.from({ length: 250 }, () => '1').join('+')).errors).toEqual([]); // 499 nodes
    expect(perr(Array.from({ length: 251 }, () => '1').join('+'))).toMatchObject({ code: 'LIMIT' });
  });
  it(`nesting > ${MAX_DEPTH}`, () => {
    expect(parse(`${'('.repeat(MAX_DEPTH)}1${')'.repeat(MAX_DEPTH)}`).errors).toEqual([]);
    const e = perr(`${'('.repeat(MAX_DEPTH + 1)}1${')'.repeat(MAX_DEPTH + 1)}`);
    expect(e).toMatchObject({ code: 'LIMIT', start: MAX_DEPTH, end: MAX_DEPTH + 1 });
    expect(perr(`${'-'.repeat(60)}1`)).toMatchObject({ code: 'LIMIT' });
    expect(perr(`${'ABS('.repeat(60)}1${')'.repeat(60)}`)).toMatchObject({ code: 'LIMIT' });
  });
  it('long binary chains are not "nesting"', () => {
    expect(parse(Array.from({ length: 200 }, (_, i) => `f${i}`).join(' + ')).errors).toEqual([]);
  });
});

describe('AST offsets', () => {
  it('spans cover the source', () => {
    const { ast } = parse('ROUND(qty * rate, 2)');
    expect(ast).toMatchObject({ type: 'call', start: 0, end: 20 });
    const call = ast as Extract<Node, { type: 'call' }>;
    expect(call.args[0]).toMatchObject({ type: 'binary', start: 6, end: 16 });
    expect(call.args[1]).toMatchObject({ type: 'number', start: 18, end: 19 });
  });
});

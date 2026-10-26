import type { FormulaError, FormulaType } from '@procure/schema';
import { D, Fail, fail, type Dec } from './util';

/** Source limits (contract): exceeding any of them is a LIMIT error. */
export const MAX_SOURCE_LENGTH = 2000;
export const MAX_NODES = 500;
export const MAX_DEPTH = 50;

// ---------------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------------

export type BinaryOp = 'OR' | 'AND' | '=' | '!=' | '<' | '<=' | '>' | '>=' | '&' | '+' | '-' | '*' | '/' | '%';

/** How the checker resolved a reference. Attached to RefNode by the checker; the parser leaves it unset. */
export interface Binding {
  /** field: header field · row: this grid row's column · lattr: header lookup attribute · rlattr: row lookup
   *  attribute · gcol: grid column inside an aggregate · grid: bare grid (COUNT only) · free: unknown (lenient) */
  kind: 'field' | 'row' | 'lattr' | 'rlattr' | 'gcol' | 'grid' | 'free';
  key: string;
  attr?: string;
  type: FormulaType;
}

interface Span {
  /** Character offsets into the source: [start, end). */
  start: number;
  end: number;
}
export interface NumberNode extends Span {
  type: 'number';
  value: string;
  dec?: Dec;
}
export interface StringNode extends Span {
  type: 'string';
  value: string;
}
export interface BooleanNode extends Span {
  type: 'boolean';
  value: boolean;
}
export interface NullNode extends Span {
  type: 'null';
}
export interface RefNode extends Span {
  type: 'ref';
  name: string;
  attr?: string;
  binding?: Binding;
}
export interface UnaryNode extends Span {
  type: 'unary';
  op: '-' | 'NOT';
  operand: Node;
}
export interface BinaryNode extends Span {
  type: 'binary';
  op: BinaryOp;
  left: Node;
  right: Node;
  /** Static operand types, set by the checker (used to disambiguate null in date arithmetic). */
  leftType?: FormulaType;
  rightType?: FormulaType;
}
export interface CallNode extends Span {
  type: 'call';
  /** Upper-cased function name. */
  name: string;
  args: Node[];
  /** Aggregates: grid iterated by each argument (null = scalar argument). Set by the checker. */
  argGrids?: (string | null)[];
  /** SUMIF / COUNTIF: grid iterated by the whole call. Set by the checker. */
  grid?: string | null;
}
export type Node = NumberNode | StringNode | BooleanNode | NullNode | RefNode | UnaryNode | BinaryNode | CallNode;

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

type TokKind = 'num' | 'str' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';
interface Token {
  kind: TokKind;
  /** num: literal text · str: decoded value · ident: name · op: normalised operator */
  value: string;
  /** Dotted reference attribute (`vendor.gstin` -> value 'vendor', attr 'gstin'). */
  attr?: string;
  start: number;
  end: number;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isIdentStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdentPart = (c: number): boolean => isIdentStart(c) || isDigit(c);

const TWO_CHAR_OPS: Record<string, string> = {
  '<=': '<=',
  '>=': '>=',
  '<>': '!=',
  '!=': '!=',
  '&&': 'AND',
  '||': 'OR',
};
const ONE_CHAR_OPS: Record<string, string> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
  '&': '&',
  '=': '=',
  '<': '<',
  '>': '>',
  '!': 'NOT',
};

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
      continue;
    }
    const s = i;
    if (isDigit(c)) {
      while (i < n && isDigit(src.charCodeAt(i))) i++;
      if (src[i] === '.') {
        if (!isDigit(src.charCodeAt(i + 1))) fail('SYNTAX', "Expected digits after '.' in number", s, i + 1);
        i++;
        while (i < n && isDigit(src.charCodeAt(i))) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (!isDigit(src.charCodeAt(j))) fail('SYNTAX', `Invalid number '${src.slice(s, j)}'`, s, j);
        i = j;
        while (i < n && isDigit(src.charCodeAt(i))) i++;
      }
      if (i < n && (isIdentPart(src.charCodeAt(i)) || src[i] === '.')) {
        let j = i;
        while (j < n && (isIdentPart(src.charCodeAt(j)) || src[j] === '.')) j++;
        fail('SYNTAX', `Invalid number '${src.slice(s, j)}'`, s, j);
      }
      const text = src.slice(s, i);
      if (!new D(text).isFinite()) fail('LIMIT', `Number '${text}' is too large`, s, i);
      toks.push({ kind: 'num', value: text, start: s, end: i });
      continue;
    }
    if (c === 39 || c === 34) {
      const quote = src[i]!;
      i++;
      let out = '';
      for (;;) {
        if (i >= n) fail('SYNTAX', 'Text is missing its closing quote', s, n);
        const ch = src[i]!;
        if (ch === quote) {
          i++;
          break;
        }
        if (ch === '\\') {
          const nx = src[i + 1];
          if (nx === '\\' || nx === "'" || nx === '"') {
            out += nx;
            i += 2;
            continue;
          }
          fail('SYNTAX', `Unknown escape '\\${nx ?? ''}': only \\\\, \\' and \\" are allowed`, i, Math.min(i + 2, n));
        }
        out += ch;
        i++;
      }
      toks.push({ kind: 'str', value: out, start: s, end: i });
      continue;
    }
    if (isIdentStart(c)) {
      while (i < n && isIdentPart(src.charCodeAt(i))) i++;
      const name = src.slice(s, i);
      let attr: string | undefined;
      if (src[i] === '.') {
        const as = i + 1;
        if (!isIdentStart(src.charCodeAt(as))) fail('SYNTAX', `Expected a name after '${name}.'`, s, as);
        i = as;
        while (i < n && isIdentPart(src.charCodeAt(i))) i++;
        attr = src.slice(as, i);
        if (src[i] === '.') {
          let j = i;
          while (j < n && (isIdentPart(src.charCodeAt(j)) || src[j] === '.')) j++;
          fail('SYNTAX', `Only one level of '.' is allowed in '${src.slice(s, j)}'`, s, j);
        }
      }
      toks.push({ kind: 'ident', value: name, attr, start: s, end: i });
      continue;
    }
    if (c === 40) {
      toks.push({ kind: 'lparen', value: '(', start: s, end: ++i });
      continue;
    }
    if (c === 41) {
      toks.push({ kind: 'rparen', value: ')', start: s, end: ++i });
      continue;
    }
    if (c === 44) {
      toks.push({ kind: 'comma', value: ',', start: s, end: ++i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==') fail('SYNTAX', "Use '=' to compare, not '=='", s, s + 2);
    const op2 = Object.prototype.hasOwnProperty.call(TWO_CHAR_OPS, two) ? TWO_CHAR_OPS[two] : undefined;
    if (op2 !== undefined) {
      i += 2;
      toks.push({ kind: 'op', value: op2, start: s, end: i });
      continue;
    }
    const ch = src[i]!;
    const op1 = Object.prototype.hasOwnProperty.call(ONE_CHAR_OPS, ch) ? ONE_CHAR_OPS[ch] : undefined;
    if (op1 !== undefined) {
      i++;
      toks.push({ kind: 'op', value: op1, start: s, end: i });
      continue;
    }
    if (ch === '|') fail('SYNTAX', "Use '||' or OR for 'or'", s, s + 1);
    fail('SYNTAX', `Unexpected character '${ch}'`, s, s + 1);
  }
  toks.push({ kind: 'eof', value: '', start: n, end: n });
  return toks;
}

// ---------------------------------------------------------------------------------------------
// Pratt parser
// ---------------------------------------------------------------------------------------------

/** Binding powers, low -> high: OR · AND · NOT · comparisons · & · + - · * / % · unary - · call/ref. */
const BP: Record<string, number> = {
  OR: 1,
  AND: 2,
  '=': 4,
  '!=': 4,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '&': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};
const NOT_BP = 3;
const NEG_BP = 8;

class Parser {
  private pos = 0;
  private nodes = 0;
  private depth = 0;

  constructor(
    private readonly src: string,
    private readonly toks: Token[],
  ) {}

  private peek(offset = 0): Token {
    return this.toks[Math.min(this.pos + offset, this.toks.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.pos++;
    return t;
  }

  private text(t: Token): string {
    return this.src.slice(t.start, t.end);
  }

  private node<T extends Node>(n: T): T {
    if (++this.nodes > MAX_NODES) fail('LIMIT', `Formula is too large (more than ${MAX_NODES} parts)`, n.start, n.end);
    return n;
  }

  private enter(t: Token): void {
    if (++this.depth > MAX_DEPTH)
      fail('LIMIT', `Formula is nested too deeply (more than ${MAX_DEPTH} levels)`, t.start, t.end);
  }

  private unexpected(t: Token): never {
    if (t.kind === 'eof') fail('SYNTAX', 'Formula ends unexpectedly', t.start, t.end);
    fail('SYNTAX', `Unexpected '${this.text(t)}'`, t.start, t.end);
  }

  parseAll(): Node {
    if (this.peek().kind === 'eof') fail('SYNTAX', 'Formula is empty', 0, this.src.length);
    const n = this.expr(0);
    const t = this.peek();
    if (t.kind !== 'eof') this.unexpected(t);
    return n;
  }

  private infixOp(t: Token): string | undefined {
    if (t.kind === 'op' && t.value !== 'NOT') return t.value;
    if (t.kind === 'ident' && t.attr === undefined) {
      const up = t.value.toUpperCase();
      if (up === 'AND' || up === 'OR') return up;
    }
    return undefined;
  }

  private expr(minBp: number): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      const op = this.infixOp(t);
      if (op === undefined) break;
      const bp = BP[op]!;
      if (bp <= minBp) break;
      this.next();
      const right = this.expr(bp);
      left = this.node({ type: 'binary', op: op as BinaryOp, left, right, start: left.start, end: right.end });
    }
    return left;
  }

  private prefix(): Node {
    const t = this.next();
    switch (t.kind) {
      case 'num':
        return this.node({ type: 'number', value: t.value, start: t.start, end: t.end });
      case 'str':
        return this.node({ type: 'string', value: t.value, start: t.start, end: t.end });
      case 'lparen': {
        this.enter(t);
        const inner = this.expr(0);
        const close = this.next();
        if (close.kind !== 'rparen') {
          if (close.kind === 'eof') fail('SYNTAX', "Missing ')'", t.start, close.end);
          this.unexpected(close);
        }
        this.depth--;
        return inner;
      }
      case 'op':
        if (t.value === '-' || t.value === 'NOT') return this.unary(t, t.value);
        return this.unexpected(t);
      case 'ident':
        return this.ident(t);
      default:
        return this.unexpected(t);
    }
  }

  private unary(t: Token, op: '-' | 'NOT'): Node {
    this.enter(t);
    const operand = this.expr(op === '-' ? NEG_BP : NOT_BP);
    this.depth--;
    return this.node({ type: 'unary', op, operand, start: t.start, end: operand.end });
  }

  private ident(t: Token): Node {
    const callNext = this.peek().kind === 'lparen';
    if (t.attr !== undefined) {
      if (callNext) fail('SYNTAX', `'${t.value}.${t.attr}' is not a function`, t.start, t.end);
      return this.node({ type: 'ref', name: t.value, attr: t.attr, start: t.start, end: t.end });
    }
    const up = t.value.toUpperCase();
    if (up === 'TRUE' || up === 'FALSE')
      return this.node({ type: 'boolean', value: up === 'TRUE', start: t.start, end: t.end });
    if (up === 'NULL') return this.node({ type: 'null', start: t.start, end: t.end });
    if (callNext) return this.call(t, up);
    if (up === 'NOT') return this.unary(t, 'NOT');
    if (up === 'AND' || up === 'OR') this.unexpected(t);
    return this.node({ type: 'ref', name: t.value, start: t.start, end: t.end });
  }

  private call(nameTok: Token, name: string): Node {
    const open = this.next();
    this.enter(open);
    const args: Node[] = [];
    if (this.peek().kind === 'rparen') {
      this.next();
    } else {
      for (;;) {
        args.push(this.expr(0));
        const sep = this.next();
        if (sep.kind === 'rparen') break;
        if (sep.kind === 'comma') continue;
        if (sep.kind === 'eof') fail('SYNTAX', `Missing ')' after the arguments of ${name}`, nameTok.start, sep.end);
        fail('SYNTAX', `Expected ',' or ')' but found '${this.text(sep)}'`, sep.start, sep.end);
      }
    }
    this.depth--;
    const end = this.toks[this.pos - 1]!.end;
    return this.node({ type: 'call', name, args, start: nameTok.start, end });
  }
}

/** Parse into an AST, throwing Fail on the first problem. */
export function parseOrThrow(src: string): Node {
  if (typeof src !== 'string') fail('SYNTAX', 'Formula must be text', 0, 0);
  if (src.length > MAX_SOURCE_LENGTH) {
    fail(
      'LIMIT',
      `Formula is too long (${src.length} characters; the limit is ${MAX_SOURCE_LENGTH})`,
      MAX_SOURCE_LENGTH,
      src.length,
    );
  }
  return new Parser(src, tokenize(src)).parseAll();
}

/** Public: parse a formula. Returns the AST (with source offsets) or the first syntax/limit error. */
export function parse(src: string): { ast: Node | null; errors: FormulaError[] } {
  try {
    return { ast: parseOrThrow(src), errors: [] };
  } catch (e) {
    if (e instanceof Fail) return { ast: null, errors: [e.error] };
    /* v8 ignore next */
    throw e;
  }
}

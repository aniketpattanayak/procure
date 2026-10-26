/** Tiny tokenizer for editor highlighting and dependency hints (the real parser lives in @procure/formula). */
export type TokKind = 'num' | 'str' | 'fn' | 'ref' | 'kw' | 'op' | 'punct' | 'bad';
export interface Tok { kind: TokKind; from: number; to: number; text: string }

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null']);

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      while (i < src.length && /[0-9.]/.test(src[i]!)) i++;
      if (/[eE]/.test(src[i] ?? '') && /[-+0-9]/.test(src[i + 1] ?? '')) { i += 2; while (/[0-9]/.test(src[i] ?? '')) i++; }
      out.push({ kind: 'num', from: start, to: i, text: src.slice(start, i) });
      continue;
    }
    if (ch === '"' || ch === "'") {
      i++;
      while (i < src.length && src[i] !== ch) { if (src[i] === '\\') i++; i++; }
      i = Math.min(i + 1, src.length);
      out.push({ kind: 'str', from: start, to: i, text: src.slice(start, i) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      if (src[i] === '.' && /[A-Za-z_]/.test(src[i + 1] ?? '')) { i++; while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++; }
      const text = src.slice(start, i);
      let j = i;
      while (/\s/.test(src[j] ?? '')) j++;
      const kind: TokKind = src[j] === '(' ? 'fn' : KEYWORDS.has(text.toLowerCase()) ? 'kw' : 'ref';
      out.push({ kind, from: start, to: i, text });
      continue;
    }
    if (/[-+*/%&=<>!|]/.test(ch)) {
      i += ['<=', '>=', '<>', '!=', '&&', '||'].includes(src.slice(i, i + 2)) ? 2 : 1;
      out.push({ kind: 'op', from: start, to: i, text: src.slice(start, i) });
      continue;
    }
    if (/[(),]/.test(ch)) { i++; out.push({ kind: 'punct', from: start, to: i, text: ch }); continue; }
    i++;
    out.push({ kind: 'bad', from: start, to: i, text: ch });
  }
  return out;
}

/** Field references in an expression (`qty`, `vendor.gstin`, `lines.amount`), in order of first use. */
export function referencedNames(src: string): string[] {
  const seen = new Set<string>();
  for (const tk of tokenize(src)) if (tk.kind === 'ref') seen.add(tk.text);
  return [...seen];
}

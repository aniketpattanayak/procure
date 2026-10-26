'use client';
import type { FormDefinition, FormulaScope, FormulaType } from '@procure/schema';
import { Button, Checkbox, Input } from '@procure/ui';
import { Minus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { t } from '@/i18n';
import { compile, evaluate, todayIn } from '@/engines/form-renderer/formula';
import { referencedNames } from './tokens';

interface Input1 { name: string; type: FormulaType }

/** "Test with sample values": one input per referenced field (and a few grid rows) -> result or error. */
export function FormulaTestPanel({ src, scope, rowOf }: { src: string; scope: FormulaScope; definition: FormDefinition; rowOf?: string; selfKey?: string }) {
  const deps = useMemo(() => {
    const c = compile(src, scope);
    const names = c.deps.length ? c.deps : referencedNames(src);
    const header: Input1[] = [];
    const rowCols: Input1[] = [];
    const lookups: Record<string, Input1[]> = {};
    const grids: Record<string, Input1[]> = {};
    for (const n of names) {
      const [a, b] = n.split('.') as [string, string | undefined];
      if (b) {
        if (scope.grids[a]?.[b]) {
          const list = (grids[a] ??= []);
          if (!list.some(x => x.name === b)) list.push({ name: b, type: scope.grids[a]![b]! });
        }
        else if (scope.lookupAttributes[a]) (lookups[a] ??= []).push({ name: b, type: scope.lookupAttributes[a]![b] ?? 'text' });
        continue;
      }
      if (rowOf && scope.grids[rowOf]?.[a]) rowCols.push({ name: a, type: scope.grids[rowOf]![a]! });
      else if (scope.grids[a]) grids[a] ??= [];
      else if (scope.fields[a]) header.push({ name: a, type: scope.fields[a]! });
    }
    return { header, rowCols, lookups, grids };
  }, [src, scope, rowOf]);

  const [vals, setVals] = useState<Record<string, unknown>>({});
  const [row, setRow] = useState<Record<string, unknown>>({});
  const [lk, setLk] = useState<Record<string, Record<string, unknown>>>({});
  const [rows, setRows] = useState<Record<string, Record<string, unknown>[]>>({});
  const gridRows = (g: string) => rows[g] ?? [{}, {}, {}];

  const result = useMemo(() => {
    const values: Record<string, unknown> = { ...vals };
    for (const g of Object.keys(deps.grids)) values[g] = gridRows(g).map((r, i) => ({ _row: String(i), ...r }));
    return evaluate(src, { values, row: rowOf ? row : undefined, lookups: lk, today: todayIn(), defaultPrecision: 2 });
  }, [src, vals, row, lk, rows, deps, rowOf]);

  const nothing = !deps.header.length && !deps.rowCols.length && !Object.keys(deps.lookups).length && !Object.keys(deps.grids).length;

  return (
    <div className="space-y-3 rounded border border-border bg-subtle p-3" data-testid="formula-test-panel">
      {nothing && <p className="text-sm text-fg-muted">{t('fx.test.noInputs')}</p>}
      {(deps.header.length > 0 || deps.rowCols.length > 0) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {deps.rowCols.map(d => <SampleInput key={`row.${d.name}`} label={`${d.name} (${t('fx.thisRow')})`} type={d.type} value={row[d.name]} onChange={v => setRow(r => ({ ...r, [d.name]: v }))} />)}
          {deps.header.map(d => <SampleInput key={d.name} label={d.name} type={d.type} value={vals[d.name]} onChange={v => setVals(s => ({ ...s, [d.name]: v }))} />)}
        </div>
      )}
      {Object.entries(deps.lookups).map(([l, attrs]) => (
        <fieldset key={l} className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-1 text-xs font-medium text-fg-muted">{t('fx.test.lookup', { name: l })}</legend>
          {attrs.map(a => <SampleInput key={a.name} label={`${l}.${a.name}`} type={a.type} value={lk[l]?.[a.name]} onChange={v => setLk(s => ({ ...s, [l]: { ...(s[l] ?? {}), [a.name]: v } }))} />)}
        </fieldset>
      ))}
      {Object.entries(deps.grids).map(([g, cols]) => {
        const list = gridRows(g);
        return (
          <div key={g} className="space-y-1.5">
            <p className="text-xs font-medium text-fg-muted">{t('fx.test.grid', { name: g })}</p>
            {cols.length > 0 && (
              <div className="overflow-x-auto">
                <table className="text-sm">
                  <thead><tr>{cols.map(c => <th key={c.name} className="px-1 pb-1 text-left font-medium text-fg-muted">{c.name}</th>)}</tr></thead>
                  <tbody>
                    {list.map((r, i) => (
                      <tr key={i}>
                        {cols.map(c => (
                          <td key={c.name} className="px-1 pb-1">
                            <SampleInput bare label={`${g}.${c.name} ${i + 1}`} type={c.type} value={r[c.name]}
                              onChange={v => setRows(s => ({ ...s, [g]: gridRows(g).map((x, j) => (j === i ? { ...x, [c.name]: v } : x)) }))} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setRows(s => ({ ...s, [g]: [...gridRows(g), {}] }))}><Plus aria-hidden />{t('fx.test.addRow')}</Button>
              <Button size="sm" variant="ghost" disabled={list.length === 0} onClick={() => setRows(s => ({ ...s, [g]: gridRows(g).slice(0, -1) }))}><Minus aria-hidden />{t('fx.test.removeRow')}</Button>
            </div>
          </div>
        );
      })}
      <div className="flex items-baseline gap-2 border-t border-border pt-2" aria-live="polite" data-testid="formula-test-result">
        <span className="text-sm text-fg-muted">{t('fx.test.result')}</span>
        {result.error ? (
          <span className="text-sm font-medium text-danger">{result.error.message}</span>
        ) : (
          <span className="font-semibold tabular-nums">{result.value === null || result.value === undefined ? t('fx.test.empty') : String(result.value)}</span>
        )}
      </div>
    </div>
  );
}

function SampleInput({ label, type, value, onChange, bare }: { label: string; type: FormulaType; value: unknown; onChange: (v: unknown) => void; bare?: boolean }) {
  const control = type === 'boolean' ? (
    <Checkbox checked={value === true} onCheckedChange={c => onChange(c === true)} aria-label={label} />
  ) : (
    <Input
      className="h-8"
      aria-label={label}
      type={type === 'date' ? 'date' : 'text'}
      inputMode={type === 'number' ? 'decimal' : undefined}
      value={(value as string) ?? ''}
      onChange={e => onChange(e.target.value === '' ? null : e.target.value)}
      placeholder={type === 'number' ? '0' : undefined}
    />
  );
  if (bare) return <div className="w-28">{control}</div>;
  return (
    <label className="flex flex-col gap-1 text-xs text-fg-muted">
      <span className="font-mono">{label}</span>
      {control}
    </label>
  );
}

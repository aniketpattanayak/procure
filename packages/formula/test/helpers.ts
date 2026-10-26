import type { FormulaContext, FormulaScope } from '@procure/schema';
import { compile, evaluate } from '../src';

export const TODAY = '2026-10-22';

/** Evaluate and return the value; fails the test on error. */
export function val(src: string, values: Record<string, unknown> = {}, extra: Partial<FormulaContext> = {}): unknown {
  const r = evaluate(src, { values, today: TODAY, ...extra });
  if (r.error) throw new Error(`${src}: ${r.error.code} ${r.error.message}`);
  return r.value;
}

/** Evaluate and return the error (fails the test if there is none). */
export function err(src: string, values: Record<string, unknown> = {}, extra: Partial<FormulaContext> = {}) {
  const r = evaluate(src, { values, today: TODAY, ...extra });
  if (!r.error) throw new Error(`${src}: expected an error, got ${JSON.stringify(r.value)}`);
  return r.error;
}

export const SCOPE: FormulaScope = {
  fields: {
    qty: 'number',
    rate: 'number',
    freight: 'number',
    discount: 'number',
    total: 'number',
    name: 'text',
    priority: 'text',
    remarks: 'text',
    code: 'text',
    order_date: 'date',
    due_date: 'date',
    is_imported: 'boolean',
    tags: 'list',
    vendor: 'text',
    warehouse: 'text',
  },
  grids: {
    lines: {
      item: 'text',
      qty: 'number',
      rate: 'number',
      amount: 'number',
      taxable: 'boolean',
      status: 'text',
      delivery: 'date',
    },
    charges: { label: 'text', value: 'number' },
  },
  lookupAttributes: {
    vendor: { code: 'text', name: 'text', gstin: 'text', credit_days: 'number' },
    warehouse: { code: 'text', name: 'text', '*': 'any' },
    'lines.item': { code: 'text', name: 'text', uom: 'text', weight: 'number' },
  },
};

export const ROW_SCOPE: FormulaScope = { ...SCOPE, rowOf: 'lines' };

export function check(src: string, scope: FormulaScope = SCOPE, expected?: Parameters<typeof compile>[2]) {
  return compile(src, scope, expected);
}

export function checkErr(src: string, scope: FormulaScope = SCOPE, expected?: Parameters<typeof compile>[2]) {
  const c = compile(src, scope, expected);
  if (c.ok) throw new Error(`${src}: expected a compile error`);
  return c.errors[0]!;
}

import { describe, expect, it } from 'vitest';
import type { FormDefinition } from '@procure/schema';
import { checkDefinition, evaluateForm, scopeFromDefinition } from '../src';
import { TODAY } from './helpers';

type F = Record<string, unknown>;
const form = (fields: F[], validations: F[] = []): FormDefinition =>
  ({ version: 1, fields, validations }) as unknown as FormDefinition;

const options = [
  { value: 'Normal', label: 'Normal' },
  { value: 'Urgent', label: 'Urgent' },
];

/** The brief's purchase order: amount = qty * rate, discount = IF(...), total = SUM(lines.amount) + freight - discount. */
const PO = form(
  [
    { key: 'main', type: 'tab', label: 'Main' }, // 0
    { key: 'vendor', type: 'lookup', label: 'Vendor', source: { kind: 'master', masterKey: 'vendor' } }, // 1
    { key: 'order_date', type: 'date', label: 'Order date', minDate: 'TODAY() - 30', maxDate: "'2026-12-31'" }, // 2
    { key: 'priority', type: 'select', label: 'Priority', options }, // 3
    {
      key: 'justification',
      type: 'textarea',
      label: 'Justification',
      required: true,
      visibleWhen: "priority = 'Urgent'",
    }, // 4
    {
      key: 'lines',
      type: 'grid',
      label: 'Lines', // 5
      columns: [
        { key: 'item', type: 'lookup', label: 'Item', source: { kind: 'master', masterKey: 'item' } }, // 0
        { key: 'qty', type: 'number', label: 'Qty', requiredWhen: "priority = 'Urgent'" }, // 1
        { key: 'rate', type: 'currency', label: 'Rate' }, // 2
        { key: 'amount', type: 'formula', label: 'Amount', expr: 'qty * rate' }, // 3
        { key: 'weight', type: 'formula', label: 'Weight', expr: 'item.weight * qty', precision: 3 }, // 4
        { key: 'share', type: 'formula', label: 'Share %', expr: 'IF(total = 0, 0, amount / total * 100)' }, // 5
        { key: 'remarks', type: 'text', label: 'Remarks', visibleWhen: 'is_capex' }, // 6
      ],
    },
    { key: 'freight', type: 'currency', label: 'Freight' }, // 6
    {
      key: 'discount',
      type: 'formula',
      label: 'Discount',
      expr: 'IF(SUM(lines.qty) >= 1000, SUM(lines.amount) * 0.10, 0)',
    }, // 7
    { key: 'total', type: 'formula', label: 'Total', expr: 'SUM(lines.amount) + freight - discount' }, // 8
    {
      key: 'due_on',
      type: 'formula',
      label: 'Due on',
      expr: 'ADD_DAYS(TODAY(), vendor.credit_days)',
      resultType: 'date',
    }, // 9
    { key: 'is_capex', type: 'checkbox', label: 'Capex' }, // 10
    { key: 'note', type: 'help', label: 'n', text: 'Capex needs approval' }, // 11
    { key: 'extra', type: 'tab', label: 'Approvals', visibleWhen: 'total > 100000' }, // 12
    { key: 'approver', type: 'text', label: 'Approver', required: true }, // 13
    { key: 'capex', type: 'section', label: 'Capex', visibleWhen: 'is_capex' }, // 14
    { key: 'asset_code', type: 'text', label: 'Asset code', requiredWhen: 'total > 0', readOnlyWhen: 'NOT is_capex' }, // 15
    { key: 'sep', type: 'divider', label: 'x' }, // 16
  ],
  [{ key: 'positive', expr: 'total > 0', message: 'Total must be positive' }],
);

const lookups = { vendor: { code: 'V001', name: 'Acme', credit_days: '45' } };

describe('scopeFromDefinition', () => {
  it('maps field types, grids and lookups', () => {
    const s = scopeFromDefinition(PO, { vendor: { gstin: 'text', credit_days: 'number' } });
    expect(s.fields).toMatchObject({
      vendor: 'text',
      order_date: 'date',
      priority: 'text',
      freight: 'number',
      total: 'number',
      due_on: 'date',
      is_capex: 'boolean',
    });
    expect(s.fields).not.toHaveProperty('main');
    expect(s.fields).not.toHaveProperty('lines');
    expect(s.grids.lines).toMatchObject({ item: 'text', qty: 'number', rate: 'number', amount: 'number' });
    expect(s.lookupAttributes.vendor).toEqual({ gstin: 'text', credit_days: 'number', code: 'text', name: 'text' });
    expect(s.lookupAttributes['lines.item']).toEqual({ code: 'text', name: 'text', '*': 'any' });
  });
  it('covers every data type', () => {
    const all = form([
      ...[
        'text',
        'textarea',
        'email',
        'phone',
        'url',
        'gstin',
        'pan',
        'regex',
        'select',
        'radio',
        'time',
        'datetime',
        'file',
        'image',
        'signature',
      ].map(t => ({ key: `f_${t}`, type: t, label: t })),
      ...['number', 'decimal', 'currency', 'percentage'].map(t => ({ key: `n_${t}`, type: t, label: t })),
      ...['checkbox', 'toggle'].map(t => ({ key: `b_${t}`, type: t, label: t })),
      ...['multiselect', 'multilookup', 'files'].map(t => ({ key: `l_${t}`, type: t, label: t })),
      { key: 'period', type: 'daterange', label: 'p' },
      { key: 'gone', type: 'number', label: 'g', removed: true },
      { key: 'f_bool', type: 'formula', label: 'x', expr: 'TRUE', resultType: 'boolean' },
    ]);
    const s = scopeFromDefinition(all);
    expect(s.fields.f_signature).toBe('text');
    expect(s.fields.n_percentage).toBe('number');
    expect(s.fields.b_toggle).toBe('boolean');
    expect(s.fields.l_files).toBe('list');
    expect(s.fields.f_bool).toBe('boolean');
    expect(s.fields).not.toHaveProperty('period');
    expect(s.fields).not.toHaveProperty('gone');
  });
  it('tolerates junk', () => {
    expect(scopeFromDefinition({} as FormDefinition)).toEqual({ fields: {}, grids: {}, lookupAttributes: {} });
    expect(scopeFromDefinition(form([{ key: 'g', type: 'grid', label: 'g' }, null as unknown as F])).grids).toEqual({
      g: {},
    });
  });
});

describe('checkDefinition', () => {
  it('the purchase order is clean', () => {
    expect(checkDefinition(PO)).toEqual([]);
  });
  it('reports every expression kind with its path', () => {
    const def = form(
      [
        { key: 'a', type: 'number', label: 'a', visibleWhen: 'qtyy > 1', requiredWhen: 'a', readOnlyWhen: 'a +' },
        { key: 'd', type: 'date', label: 'd', minDate: 'a', maxDate: 'TODAY()' },
        { key: 'f', type: 'formula', label: 'f', expr: "a & 'x'", resultType: 'number' },
        { key: 't', type: 'tab', label: 't', visibleWhen: 'NOPE()' },
        { key: 's', type: 'section', label: 's', visibleWhen: 'ROUND(1,2,3) = 1' },
        {
          key: 'g',
          type: 'grid',
          label: 'g',
          columns: [
            { key: 'c', type: 'number', label: 'c' },
            { key: 'x', type: 'formula', label: 'x', expr: 'cc * 2', visibleWhen: 'c > 1' },
          ],
        },
        { key: 'h', type: 'formula', label: 'h', expr: 'g.c' },
        { key: 'e', type: 'formula', label: 'e', expr: '' },
      ],
      [{ key: 'v', expr: 'a', message: 'm' }],
    );
    const issues = checkDefinition(def);
    expect(issues).toEqual([
      { path: 'fields.0.visibleWhen', code: 'UNKNOWN_FIELD_REF', message: "Unknown field 'qtyy'." },
      {
        path: 'fields.0.requiredWhen',
        code: 'FORMULA_TYPE',
        message: 'This formula returns a number but TRUE/FALSE is expected',
      },
      { path: 'fields.0.readOnlyWhen', code: 'FORMULA_SYNTAX', message: 'Formula ends unexpectedly' },
      {
        path: 'fields.1.minDate',
        code: 'FORMULA_TYPE',
        message: 'This formula returns a number but a date is expected',
      },
      { path: 'fields.2.expr', code: 'FORMULA_TYPE', message: 'This formula returns text but a number is expected' },
      { path: 'fields.3.visibleWhen', code: 'FORMULA_SYNTAX', message: "Unknown function 'NOPE'. Did you mean 'NOT'?" },
      { path: 'fields.4.visibleWhen', code: 'FORMULA_TYPE', message: 'ROUND expects 1 to 2 arguments but got 3' },
      { path: 'fields.5.columns.1.expr', code: 'UNKNOWN_FIELD_REF', message: "Unknown field 'cc'. Did you mean 'c'?" },
      {
        path: 'fields.5.columns.1.visibleWhen',
        code: 'UNKNOWN_FIELD_REF',
        message: "Unknown field 'c'. Did you mean 'a'?",
      },
      {
        path: 'fields.6.expr',
        code: 'FORMULA_TYPE',
        message: "'g.c' reads every row of grid 'g'; wrap it in SUM, AVG, MIN, MAX or COUNT, e.g. SUM(g.c)",
      },
      { path: 'fields.7.expr', code: 'FORMULA_SYNTAX', message: 'Formula is empty' },
      {
        path: 'validations.0.expr',
        code: 'FORMULA_TYPE',
        message: 'This formula returns a number but TRUE/FALSE is expected',
      },
    ]);
  });
  it('layout elements, removed fields and date ranges cannot be referenced', () => {
    const def = form([
      { key: 'intro', type: 'help', label: 'h', text: 'x' },
      { key: 'old', type: 'number', label: 'o', removed: true, visibleWhen: 'garbage +' },
      { key: 'period', type: 'daterange', label: 'p' },
      {
        key: 'g',
        type: 'grid',
        label: 'g',
        columns: [
          { key: 'gone', type: 'number', label: 'x', removed: true, expr: 'zzz' },
          { key: 'f', type: 'formula', label: 'f', expr: 'gone + 1' },
        ],
      },
      { key: 'a', type: 'formula', label: 'a', expr: 'intro + old' },
      { key: 'b', type: 'formula', label: 'b', expr: 'period' },
      { key: 'c', type: 'formula', label: 'c', expr: 'old.x' },
    ]);
    expect(checkDefinition(def)).toEqual([
      {
        path: 'fields.3.columns.1.expr',
        code: 'UNKNOWN_FIELD_REF',
        message: "'gone' was removed from this grid and cannot be used in formulas",
      },
      {
        path: 'fields.4.expr',
        code: 'UNKNOWN_FIELD_REF',
        message: "'intro' is a help (layout element) and holds no value",
      },
      {
        path: 'fields.4.expr',
        code: 'UNKNOWN_FIELD_REF',
        message: "'old' was removed from this form and cannot be used in formulas",
      },
      {
        path: 'fields.5.expr',
        code: 'UNKNOWN_FIELD_REF',
        message: "'period' is a date range; date ranges cannot be used in formulas",
      },
      {
        path: 'fields.6.expr',
        code: 'UNKNOWN_FIELD_REF',
        message: "'old' was removed from this form and cannot be used in formulas",
      },
    ]);
  });
  it('uses supplied lookup attributes', () => {
    const def = form([
      { key: 'vendor', type: 'lookup', label: 'v', source: { kind: 'master', masterKey: 'vendor' } },
      { key: 'x', type: 'formula', label: 'x', expr: 'vendor.gstn', resultType: 'text' },
    ]);
    expect(checkDefinition(def)).toEqual([]);
    expect(checkDefinition(def, { vendor: { gstin: 'text' } })).toEqual([
      {
        path: 'fields.1.expr',
        code: 'UNKNOWN_FIELD_REF',
        message: "Lookup 'vendor' has no attribute 'gstn'. Did you mean 'gstin'?",
      },
    ]);
  });

  describe('cycles name the loop', () => {
    it('direct (self reference)', () => {
      const def = form([{ key: 'total', type: 'formula', label: 't', expr: 'total + 1' }]);
      expect(checkDefinition(def)).toEqual([
        {
          path: 'fields.0.expr',
          code: 'FORMULA_CYCLE',
          message: "Circular reference: total → total ('total' refers to itself)",
        },
      ]);
    });
    it('indirect', () => {
      const def = form([
        { key: 'freight', type: 'currency', label: 'f' },
        { key: 'discount', type: 'formula', label: 'd', expr: 'total * 0.1' },
        { key: 'total', type: 'formula', label: 't', expr: 'freight - discount' },
        { key: 'tax', type: 'formula', label: 'x', expr: 'total * 0.18' },
      ]);
      expect(checkDefinition(def)).toEqual([
        { path: 'fields.1.expr', code: 'FORMULA_CYCLE', message: 'Circular reference: discount → total → discount' },
        { path: 'fields.2.expr', code: 'FORMULA_CYCLE', message: 'Circular reference: total → discount → total' },
      ]);
    });
    it('three-step loop', () => {
      const def = form([
        { key: 'a', type: 'formula', label: 'a', expr: 'b' },
        { key: 'b', type: 'formula', label: 'b', expr: 'c' },
        { key: 'c', type: 'formula', label: 'c', expr: 'a' },
      ]);
      expect(checkDefinition(def).map(i => i.message)).toEqual([
        'Circular reference: a → b → c → a',
        'Circular reference: b → c → a → b',
        'Circular reference: c → a → b → c',
      ]);
    });
    it('through grid aggregates', () => {
      const def = form([
        { key: 'factor', type: 'formula', label: 'f', expr: 'SUM(lines.amount) / 100' },
        {
          key: 'lines',
          type: 'grid',
          label: 'l',
          columns: [
            { key: 'qty', type: 'number', label: 'q' },
            { key: 'amount', type: 'formula', label: 'a', expr: 'qty * factor' },
          ],
        },
      ]);
      expect(checkDefinition(def)).toEqual([
        { path: 'fields.0.expr', code: 'FORMULA_CYCLE', message: 'Circular reference: factor → lines.amount → factor' },
        {
          path: 'fields.1.columns.1.expr',
          code: 'FORMULA_CYCLE',
          message: 'Circular reference: lines.amount → factor → lines.amount',
        },
      ]);
    });
    it('within a grid row', () => {
      const def = form([
        {
          key: 'lines',
          type: 'grid',
          label: 'l',
          columns: [
            { key: 'a', type: 'formula', label: 'a', expr: 'b + 1' },
            { key: 'b', type: 'formula', label: 'b', expr: 'a + 1' },
          ],
        },
      ]);
      expect(checkDefinition(def).map(i => [i.path, i.message])).toEqual([
        ['fields.0.columns.0.expr', 'Circular reference: lines.a → lines.b → lines.a'],
        ['fields.0.columns.1.expr', 'Circular reference: lines.b → lines.a → lines.b'],
      ]);
    });
    it('a grid column may aggregate a sibling column and read header formulas', () => {
      expect(checkDefinition(PO)).toEqual([]);
    });
  });
});

describe('evaluateForm', () => {
  const lines = [
    { _row: 'r1', item: 'i1', qty: '600', rate: '10.005' },
    { _row: 'r2', item: 'i2', qty: '500', rate: '2' },
  ];
  const rowLookups = { lines: { r1: { item: { weight: '0.25' } }, r2: { item: null } } };

  it("computes the brief's example", () => {
    const r = evaluateForm(PO, {
      values: { vendor: 'v1', freight: '100', priority: 'Normal', lines },
      lookups,
      rowLookups,
      today: TODAY,
    });
    expect(r.errors).toEqual({});
    const out = r.values.lines as Record<string, unknown>[];
    expect(out.map(l => l.amount)).toEqual(['6003.00', '1000.00']);
    expect(out.map(l => l.weight)).toEqual(['150.000', '0.000']);
    expect(r.values.discount).toBe('700.30'); // SUM(qty) = 1100 >= 1000
    expect(r.values.total).toBe('6402.70');
    expect(out.map(l => l.share)).toEqual(['93.76', '15.62']);
    expect(r.values.due_on).toBe('2026-12-06');
    expect(r.validations).toEqual([{ key: 'positive', message: 'Total must be positive', ok: true }]);
    expect(r.dateBounds).toEqual({ order_date: { min: '2026-09-22', max: '2026-12-31' } });
    // input untouched
    expect(lines[0]).not.toHaveProperty('amount');
  });

  it('no discount below the threshold; currency rounding half-up', () => {
    const r = evaluateForm(PO, {
      values: {
        lines: [
          { qty: '1', rate: '2.675' },
          { qty: '3', rate: '0.335' },
        ],
      },
      today: TODAY,
    });
    const out = r.values.lines as Record<string, unknown>[];
    expect(out.map(l => l.amount)).toEqual(['2.68', '1.01']);
    expect(r.values.discount).toBe('0.00');
    expect(r.values.total).toBe('3.69'); // freight empty = 0
    expect(r.values.due_on).toBe(TODAY); // credit_days empty = 0 days
  });

  it('visibility, required and read-only incl. tabs and sections', () => {
    const base = { values: { freight: '0', lines }, lookups, today: TODAY };
    const urgent = evaluateForm(PO, { ...base, values: { ...base.values, priority: 'Urgent', is_capex: true } });
    expect(urgent.state.justification).toEqual({ visible: true, required: true, readOnly: false });
    expect(urgent.state['lines.qty']).toEqual({ visible: true, required: true, readOnly: false });
    expect(urgent.state['lines.amount']).toEqual({ visible: true, required: false, readOnly: true });
    expect(urgent.state['lines.remarks']!.visible).toBe(true);
    expect(urgent.state.main).toEqual({ visible: true, required: false, readOnly: false });
    expect(urgent.state.note!.visible).toBe(true);
    expect(urgent.state.extra!.visible).toBe(false); // total 7003 <= 100000
    expect(urgent.state.approver).toEqual({ visible: false, required: false, readOnly: false }); // hidden ⇒ not required
    expect(urgent.state.capex!.visible).toBe(false);
    expect(urgent.state.asset_code).toEqual({ visible: false, required: false, readOnly: false });
    expect(urgent.state.sep!.visible).toBe(false);

    const normal = evaluateForm(PO, {
      ...base,
      values: { ...base.values, priority: 'Normal', lines: [{ qty: '1000', rate: '200' }] },
    });
    expect(normal.state.justification).toEqual({ visible: false, required: false, readOnly: false });
    expect(normal.state['lines.qty']!.required).toBe(false);
    expect(normal.state['lines.remarks']!.visible).toBe(false);
    expect(normal.values.total).toBe('180000.00');
    expect(normal.state.extra!.visible).toBe(true);
    expect(normal.state.approver).toEqual({ visible: true, required: true, readOnly: false });
    expect(normal.state.capex!.visible).toBe(false);
    expect(normal.state.asset_code!.readOnly).toBe(true);

    const capex = evaluateForm(PO, { ...base, values: { lines: [{ qty: '1000', rate: '200' }], is_capex: true } });
    expect(capex.state.capex!.visible).toBe(true);
    expect(capex.state.asset_code).toEqual({ visible: true, required: true, readOnly: false });
  });

  it('hidden flag, removed fields and static required/readOnly', () => {
    const def = form([
      { key: 'a', type: 'text', label: 'a', hidden: true, required: true },
      { key: 'b', type: 'text', label: 'b', readOnly: true, required: true },
      { key: 'old', type: 'formula', label: 'o', expr: 'nonsense +', removed: true },
      { key: 'gone', type: 'tab', label: 'g', removed: true, visibleWhen: 'FALSE' },
      {
        key: 'g',
        type: 'grid',
        label: 'g',
        hidden: true,
        columns: [
          { key: 'c', type: 'text', label: 'c', required: true },
          { key: 'd', type: 'text', label: 'd', removed: true },
        ],
      },
    ]);
    const r = evaluateForm(def, { values: { old: 'kept', a: 'x' }, today: TODAY });
    expect(r.state.a).toEqual({ visible: false, required: false, readOnly: false });
    expect(r.state.b).toEqual({ visible: true, required: true, readOnly: true });
    expect(r.state).not.toHaveProperty('old');
    expect(r.state).not.toHaveProperty('gone');
    expect(r.state).not.toHaveProperty('g.d');
    expect(r.state['g.c']).toEqual({ visible: false, required: false, readOnly: false });
    expect(r.values.old).toBe('kept');
    expect(r.errors).toEqual({});
  });

  it('runtime errors are keyed by field (grid cells by row) and leave the value null', () => {
    const def = form([
      { key: 'n', type: 'number', label: 'n' },
      { key: 'ratio', type: 'formula', label: 'r', expr: '100 / n' },
      { key: 'after', type: 'formula', label: 'a', expr: 'COALESCE(ratio, -1)' },
      {
        key: 'g',
        type: 'grid',
        label: 'g',
        columns: [
          { key: 'q', type: 'number', label: 'q' },
          { key: 'inv', type: 'formula', label: 'i', expr: '1 / q' },
        ],
      },
    ]);
    const r = evaluateForm(def, {
      values: { n: '0', g: [{ _row: 'a', q: '4' }, { _row: 'b', q: '0' }, { q: 'abc' }] },
      today: TODAY,
    });
    expect(r.values.ratio).toBeNull();
    expect(r.errors.ratio).toEqual({ code: 'RUNTIME', message: 'Division by zero', start: 0, end: 7 });
    expect(r.values.after).toBe('-1.00');
    expect((r.values.g as F[]).map(x => x.inv)).toEqual(['0.25', null, null]);
    expect(r.errors['g.b.inv']).toMatchObject({ code: 'RUNTIME', message: 'Division by zero' });
    expect(r.errors['g.2.inv']).toMatchObject({
      code: 'RUNTIME',
      message: "'q' does not hold a number",
      start: 4,
      end: 5,
    });
  });

  it('cycles and compile errors at runtime', () => {
    const def = form(
      [
        { key: 'a', type: 'formula', label: 'a', expr: 'b + 1' },
        { key: 'b', type: 'formula', label: 'b', expr: 'a + 1' },
        { key: 'c', type: 'formula', label: 'c', expr: 'a * 2' },
        { key: 'bad', type: 'formula', label: 'x', expr: '1 +' },
        {
          key: 'g',
          type: 'grid',
          label: 'g',
          columns: [
            { key: 'x', type: 'formula', label: 'x', expr: 'y' },
            { key: 'z', type: 'formula', label: 'z', expr: 'SUM(g.x) + z' },
          ],
        },
        { key: 'v', type: 'text', label: 'v', visibleWhen: 'nope = 1', requiredWhen: '1 / 0 = 1' },
      ],
      [
        { key: 'chk', expr: '1/0 > 0', message: 'm' },
        { key: 'nul', expr: 'NULL', message: 'n' },
      ],
    );
    const r = evaluateForm(def, { values: { g: [{ x: 'stale', z: 'stale' }] }, today: TODAY });
    expect(r.values).toMatchObject({ a: null, b: null, c: null, bad: null });
    expect(r.errors.a).toEqual({ code: 'CYCLE', message: 'Circular reference: a → b → a' });
    expect(r.errors.c).toEqual({ code: 'CYCLE', message: "'c' depends on a circular reference" });
    expect(r.errors.bad).toMatchObject({ code: 'SYNTAX' });
    expect(r.errors['g.x']).toMatchObject({ code: 'UNKNOWN_FIELD' });
    expect(r.errors['g.z']).toMatchObject({ code: 'CYCLE' });
    expect(r.values.g).toEqual([{ x: null, z: null }]);
    expect(r.state.v).toEqual({ visible: true, required: false, readOnly: false }); // fail-open visible, not required
    expect(r.errors['v.visibleWhen']).toMatchObject({ code: 'UNKNOWN_FIELD' });
    expect(r.errors['v.requiredWhen']).toMatchObject({ code: 'RUNTIME' });
    expect(r.validations).toEqual([
      {
        key: 'chk',
        message: 'm',
        ok: false,
        error: { code: 'RUNTIME', message: 'Division by zero', start: 0, end: 3 },
      },
      { key: 'nul', message: 'n', ok: false },
    ]);
  });

  it('converts results to the declared result type and precision', () => {
    const def = form([
      { key: 'w', type: 'lookup', label: 'w', source: { kind: 'master', masterKey: 'w' } },
      { key: 'n', type: 'formula', label: 'n', expr: 'w.num' },
      { key: 'p0', type: 'formula', label: 'p0', expr: '2.5', precision: 0 },
      { key: 'dp', type: 'formula', label: 'dp', expr: '1 / 3' },
      { key: 't', type: 'formula', label: 't', expr: "w.code & '-' & TEXT(1, 1)", resultType: 'text' },
      { key: 'e', type: 'formula', label: 'e', expr: "w.missing & ''", resultType: 'text' },
      { key: 'd', type: 'formula', label: 'd', expr: 'w.since', resultType: 'date' },
      { key: 'ds', type: 'formula', label: 'ds', expr: "'2026-01-05'", resultType: 'date' },
      { key: 'b', type: 'formula', label: 'b', expr: 'w.flag', resultType: 'boolean' },
      { key: 'bad_n', type: 'formula', label: 'x', expr: 'w.label' },
      { key: 'bad_d', type: 'formula', label: 'x', expr: 'w.label', resultType: 'date' },
      { key: 'bad_b', type: 'formula', label: 'x', expr: 'w.label', resultType: 'boolean' },
      { key: 'static', type: 'formula', label: 'x', expr: 'w.code' },
      { key: 'txt_n', type: 'formula', label: 'x', expr: 'w.numtext' },
    ]);
    const r = evaluateForm(def, {
      values: {},
      lookups: { w: { code: 'W1', label: 'W1', num: 12.345, since: '2020-02-29', flag: true, numtext: '7.125' } },
      today: TODAY,
      defaultPrecision: 3,
    });
    expect(r.values).toMatchObject({
      n: '12.345',
      p0: '3',
      dp: '0.333',
      t: 'W1-1.0',
      e: null,
      d: '2020-02-29',
      ds: '2026-01-05',
      b: true,
      txt_n: '7.125',
    });
    expect(r.errors.bad_n).toMatchObject({ code: 'RUNTIME', message: 'Formula produced W1 but a number is expected' });
    expect(r.errors.bad_d).toMatchObject({ message: 'Formula produced W1 but a date is expected' });
    expect(r.errors.bad_b).toMatchObject({ message: 'Formula produced W1 but TRUE/FALSE is expected' });
    expect(r.errors.static).toMatchObject({
      code: 'TYPE',
      message: 'This formula returns text but a number is expected',
    });
  });

  it('typed values: empty dates, bad stored values, odd input shapes', () => {
    const def = form([
      { key: 'start', type: 'date', label: 's' },
      { key: 'end', type: 'date', label: 'e', minDate: 'start', maxDate: 'start + 1' },
      { key: 'only', type: 'date', label: 'o', maxDate: 'TODAY()' },
      { key: 'days', type: 'formula', label: 'd', expr: 'end - start' },
      { key: 'next', type: 'formula', label: 'n', expr: 'start + 7', resultType: 'date' },
      { key: 'flag', type: 'checkbox', label: 'f' },
      { key: 'tags', type: 'multiselect', label: 't', options },
      { key: 'fb', type: 'formula', label: 'fb', expr: "flag AND CONTAINS(tags, 'Urgent')", resultType: 'boolean' },
      { key: 'g', type: 'grid', label: 'g', columns: [{ key: 'v', type: 'formula', label: 'v', expr: '1' }] },
    ]);
    const empty = evaluateForm(def, { values: { end: '2026-03-01' }, today: TODAY });
    expect(empty.values).toMatchObject({ days: null, next: null, fb: false, g: [] });
    expect(empty.dateBounds.end).toEqual({ min: null, max: null });
    expect(empty.dateBounds.only).toEqual({ min: null, max: TODAY });
    const full = evaluateForm(def, {
      values: { start: '2026-02-27', end: '2026-03-01', flag: 'true', tags: ['Urgent'], g: 'oops' },
      today: TODAY,
    });
    expect(full.values).toMatchObject({ days: '2.00', next: '2026-03-06', fb: true });
    expect(full.dateBounds.end).toEqual({ min: '2026-02-27', max: '2026-02-28' });
    const bad = evaluateForm(def, { values: { start: '27/02/2026', flag: 'yes', tags: { a: 1 } }, today: TODAY });
    expect(bad.errors.days).toMatchObject({ code: 'RUNTIME', message: "'start' does not hold a date ('YYYY-MM-DD')" });
    expect(bad.errors.fb).toMatchObject({ message: "'flag' does not hold TRUE/FALSE" });
    const other = evaluateForm(def, { values: { flag: 'FALSE', tags: 'Urgent' }, today: TODAY });
    expect(other.values.fb).toBe(false);
  });

  it('text and list conversions from stored values', () => {
    const def = form([
      { key: 'code', type: 'text', label: 'c' },
      { key: 'tags', type: 'multiselect', label: 't', options },
      { key: 'x', type: 'formula', label: 'x', expr: "code & '/' & COUNT(tags)", resultType: 'text' },
    ]);
    expect(evaluateForm(def, { values: { code: 12, tags: ['a', 1, null] }, today: TODAY }).values.x).toBe('12/2');
    expect(evaluateForm(def, { values: { code: true }, today: TODAY }).values.x).toBe('true/0');
    expect(evaluateForm(def, { values: { code: { a: 1 } }, today: TODAY }).errors.x).toMatchObject({
      message: "'code' does not hold text",
    });
    expect(evaluateForm(def, { values: { code: '123' }, today: TODAY }).values.x).toBe('123/0'); // text stays text
  });

  it('never triggers the __proto__ setter on copies', () => {
    const values = JSON.parse(
      '{"__proto__": {"polluted": 1}, "n": "2", "g": [{"__proto__": {"x": 1}, "q": "3"}]}',
    ) as F;
    const def = form([
      { key: 'n', type: 'number', label: 'n' },
      {
        key: 'g',
        type: 'grid',
        label: 'g',
        columns: [
          { key: 'q', type: 'number', label: 'q' },
          { key: 'd', type: 'formula', label: 'd', expr: 'q * n' },
        ],
      },
    ]);
    const r = evaluateForm(def, { values, today: TODAY });
    expect((r.values.g as F[])[0]!.d).toBe('6.00');
    expect(Object.getPrototypeOf(r.values)).toBe(Object.prototype);
    expect(({} as F).polluted).toBeUndefined();
  });

  it('tolerates a definition without validations', () => {
    const def = {
      version: 1,
      fields: [{ key: 'x', type: 'formula', label: 'x', expr: '1' }],
    } as unknown as FormDefinition;
    expect(evaluateForm(def, { values: {}, today: TODAY }).validations).toEqual([]);
    expect(checkDefinition(def)).toEqual([]);
  });
});

describe('performance', () => {
  it('200 grid rows × 3 formula columns + 5 header formulas in < 50 ms', () => {
    const def = form([
      { key: 'freight', type: 'currency', label: 'f' },
      { key: 'tax_rate', type: 'percentage', label: 't' },
      {
        key: 'lines',
        type: 'grid',
        label: 'l',
        columns: [
          { key: 'qty', type: 'number', label: 'q' },
          { key: 'rate', type: 'currency', label: 'r' },
          { key: 'amount', type: 'formula', label: 'a', expr: 'qty * rate' },
          { key: 'tax', type: 'formula', label: 't', expr: 'ROUND(amount * tax_rate / 100, 2)' },
          { key: 'gross', type: 'formula', label: 'g', expr: 'IF(qty > 0, amount + tax, 0)' },
        ],
      },
      { key: 'subtotal', type: 'formula', label: 's', expr: 'SUM(lines.amount)' },
      { key: 'tax_total', type: 'formula', label: 't', expr: 'SUM(lines.tax)' },
      {
        key: 'discount',
        type: 'formula',
        label: 'd',
        expr: 'IFS(subtotal > 100000, subtotal * 0.05, subtotal > 50000, subtotal * 0.03, 0)',
      },
      { key: 'total', type: 'formula', label: 't', expr: 'subtotal + tax_total + freight - discount' },
      { key: 'avg_rate', type: 'formula', label: 'a', expr: 'AVG(lines.rate)' },
    ]);
    const rows = Array.from({ length: 200 }, (_, i) => ({ _row: `r${i}`, qty: String(i + 1), rate: `${i}.75` }));
    const input = { values: { freight: '250', tax_rate: '18', lines: rows }, today: TODAY };
    evaluateForm(def, input); // warm-up (JIT)
    const t0 = performance.now();
    const r = evaluateForm(def, input);
    const ms = performance.now() - t0;
    expect(r.errors).toEqual({});
    expect((r.values.lines as F[])[199]).toMatchObject({ amount: '39950.00', tax: '7191.00', gross: '47141.00' });
    expect(ms).toBeLessThan(50);
  });
});

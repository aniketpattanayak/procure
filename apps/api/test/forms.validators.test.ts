/** Unit tests (no app): value validators, structural checks, publish merge, helpers. */
import { FormDefinition } from '@procure/schema';
import { describe, expect, it } from 'vitest';
import { emptyMasterDefinition, formulaTypeOf, jsonEqual, masterAttributes } from '../src/modules/forms/definition';
import { evaluateForm, formulaAvailable } from '../src/modules/forms/formula.adapter';
import { expandCodePattern, filterValue, prefixQuery } from '../src/modules/forms/records.service';
import { checkStructure, MasterInfo, mergeForPublish } from '../src/modules/forms/structure';
import {
  canonicalDecimal, defaultValue, gstinCheckChar, isValidDateTime, isValidGstin, isValidPan, isValidUrl, normalizePhone, validateValue,
} from '../src/modules/forms/validators';

const f = (o: Record<string, unknown>) => FormDefinition.parse({ fields: [o] }).fields[0] as never;
const ok = (field: never, v: unknown) => validateValue(field, v, 'x');

describe('value validators (table-driven, every data type)', () => {
  const cases: [string, Record<string, unknown>, unknown, unknown | 'ERR'][] = [
    ['text ok', { type: 'text' }, '  hi ', 'hi'],
    ['text not string', { type: 'text' }, 5, 'ERR'],
    ['text minLength', { type: 'text', minLength: 3 }, 'ab', 'ERR'],
    ['text maxLength', { type: 'text', maxLength: 3 }, 'abcd', 'ERR'],
    ['text default cap', { type: 'text' }, 'a'.repeat(1001), 'ERR'],
    ['textarea keeps whitespace', { type: 'textarea' }, ' a\nb ', ' a\nb '],
    ['regex match', { type: 'regex', pattern: '[A-Z]{3}-\\d+' }, 'ABC-12', 'ABC-12'],
    ['regex full match only', { type: 'regex', pattern: '[A-Z]{3}' }, 'ABCD', 'ERR'],
    ['regex bad pattern', { type: 'regex', pattern: '(' }, 'x', 'ERR'],
    ['number int', { type: 'number' }, '0042', '42'],
    ['number from js number', { type: 'number' }, 7, '7'],
    ['number fraction rejected', { type: 'number' }, '1.5', 'ERR'],
    ['number min', { type: 'number', min: 1 }, '0', 'ERR'],
    ['number max', { type: 'number', max: 10 }, '11', 'ERR'],
    ['number exponent rejected', { type: 'number' }, '1e3', 'ERR'],
    ['decimal normalised to 2dp', { type: 'decimal' }, '12.5', '12.50'],
    ['decimal integer padded', { type: 'currency' }, 100, '100.00'],
    ['decimal too many dp', { type: 'decimal' }, '1.234', 'ERR'],
    ['decimal precision 3', { type: 'decimal', precision: 3 }, '1.234', '1.234'],
    ['currency negative', { type: 'currency' }, '-10.25', '-10.25'],
    ['currency text', { type: 'currency' }, 'ten', 'ERR'],
    ['percentage', { type: 'percentage', min: 0, max: 100 }, '101', 'ERR'],
    ['date ok', { type: 'date' }, '2024-02-29', '2024-02-29'],
    ['date invalid day', { type: 'date' }, '2023-02-29', 'ERR'],
    ['date format', { type: 'date' }, '29/02/2024', 'ERR'],
    ['time ok', { type: 'time' }, '23:59', '23:59'],
    ['time bad', { type: 'time' }, '24:00', 'ERR'],
    ['datetime ok', { type: 'datetime' }, '2024-05-01T10:00:00+05:30', '2024-05-01T10:00:00+05:30'],
    ['datetime needs zone', { type: 'datetime' }, '2024-05-01T10:00:00', 'ERR'],
    ['daterange ok', { type: 'daterange' }, { from: '2024-01-01', to: '2024-01-31' }, { from: '2024-01-01', to: '2024-01-31' }],
    ['daterange reversed', { type: 'daterange' }, { from: '2024-02-01', to: '2024-01-31' }, 'ERR'],
    ['daterange shape', { type: 'daterange' }, '2024-01-01', 'ERR'],
    ['select ok', { type: 'select', options: [{ value: 'a', label: 'A' }] }, 'a', 'a'],
    ['select unknown', { type: 'select', options: [{ value: 'a', label: 'A' }] }, 'b', 'ERR'],
    ['select inactive', { type: 'select', options: [{ value: 'a', label: 'A', inactive: true }] }, 'a', 'ERR'],
    ['radio ok', { type: 'radio', options: [{ value: 'y', label: 'Y' }] }, 'y', 'y'],
    ['multiselect dedupe', { type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }, ['a', 'a', 'b'], ['a', 'b']],
    ['multiselect max', { type: 'multiselect', maxSelected: 1, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }, ['a', 'b'], 'ERR'],
    ['multiselect not list', { type: 'multiselect', options: [{ value: 'a', label: 'A' }] }, 'a', 'ERR'],
    ['checkbox', { type: 'checkbox' }, true, true],
    ['toggle string rejected', { type: 'toggle' }, 'true', 'ERR'],
    ['lookup uuid', { type: 'lookup', source: { kind: 'master', masterKey: 'uom' } }, '0190F3D2-1111-7000-8000-000000000001', '0190f3d2-1111-7000-8000-000000000001'],
    ['lookup not uuid', { type: 'lookup', source: { kind: 'master', masterKey: 'uom' } }, 'KG', 'ERR'],
    ['multilookup max', { type: 'multilookup', maxSelected: 1, source: { kind: 'user' } }, ['0190f3d2-1111-7000-8000-000000000001', '0190f3d2-1111-7000-8000-000000000002'], 'ERR'],
    ['file uuid', { type: 'file' }, '0190f3d2-1111-7000-8000-000000000001', '0190f3d2-1111-7000-8000-000000000001'],
    ['image bad', { type: 'image' }, 'x', 'ERR'],
    ['signature', { type: 'signature' }, '0190f3d2-1111-7000-8000-000000000001', '0190f3d2-1111-7000-8000-000000000001'],
    ['files max', { type: 'files', maxFiles: 1 }, ['0190f3d2-1111-7000-8000-000000000001', '0190f3d2-1111-7000-8000-000000000002'], 'ERR'],
    ['email ok', { type: 'email' }, ' a.b@example.com ', 'a.b@example.com'],
    ['email bad', { type: 'email' }, 'a@b', 'ERR'],
    ['phone national IN', { type: 'phone' }, '98765 43210', '+919876543210'],
    ['phone e164', { type: 'phone' }, '+1 (415) 555-0100', '+14155550100'],
    ['phone garbage', { type: 'phone' }, 'call me', 'ERR'],
    ['url https', { type: 'url' }, 'https://example.com/x', 'https://example.com/x'],
    ['url javascript', { type: 'url' }, 'javascript:alert(1)', 'ERR'],
    ['url ftp', { type: 'url' }, 'ftp://example.com', 'ERR'],
    ['gstin ok', { type: 'gstin' }, '27aapfu0939f1zv', '27AAPFU0939F1ZV'],
    ['gstin check digit', { type: 'gstin' }, '27AAPFU0939F1ZW', 'ERR'],
    ['pan ok', { type: 'pan' }, 'aapfu0939f', 'AAPFU0939F'],
    ['pan bad holder type', { type: 'pan' }, 'AAPXU0939F', 'ERR'],
    ['formula ignored', { type: 'formula', expr: '1' }, '999', undefined],
    ['empty string = empty', { type: 'text' }, '', undefined],
    ['null = empty', { type: 'number' }, null, undefined],
  ];
  it.each(cases)('%s', (_n, def, input, want) => {
    const r = ok(f({ key: 'x', label: 'X', ...def }), input);
    if (want === 'ERR') expect(r.errors.length).toBeGreaterThan(0);
    else {
      expect(r.errors).toEqual([]);
      expect(r.value).toEqual(want);
    }
  });

  it('keeps an inactive option on a record that already had it', () => {
    const field = f({ key: 'x', label: 'X', type: 'select', options: [{ value: 'a', label: 'A', inactive: true }] });
    expect(validateValue(field, 'a', 'x', { previous: 'a' }).errors).toEqual([]);
    const multi = f({ key: 'x', label: 'X', type: 'multiselect', options: [{ value: 'a', label: 'A', inactive: true }] });
    expect(validateValue(multi, ['a'], 'x', { previous: ['a'] }).errors).toEqual([]);
  });

  it('date bounds use the evaluator', () => {
    const field = f({ key: 'd', label: 'D', type: 'date', minDate: 'TODAY()', maxDate: 'TODAY()' });
    const evalDate = () => '2024-06-01';
    expect(validateValue(field, '2024-05-31', 'd', { evalDate }).errors[0]!.message).toMatch(/on or after/);
    expect(validateValue(field, '2024-06-02', 'd', { evalDate }).errors[0]!.message).toMatch(/on or before/);
    expect(validateValue(field, '2024-06-01', 'd', { evalDate }).errors).toEqual([]);
  });

  it('grids: rows get ids, columns validate with row paths, min/max rows', () => {
    const grid = f({
      key: 'lines', label: 'Lines', type: 'grid', minRows: 1, maxRows: 2,
      columns: [{ key: 'qty', label: 'Qty', type: 'number', required: true }, { key: 'old', label: 'Old', type: 'text', removed: true }],
    });
    const r = validateValue(grid, [{ qty: '2' }, { qty: 'x' }], 'lines');
    expect(r.errors).toEqual([{ path: 'lines.1.qty', message: 'Qty must be a number.' }]);
    const rows = r.value as { _row: string; qty: string }[];
    expect(rows[0]!._row).toMatch(/^[0-9a-f-]{36}$/);
    expect(validateValue(grid, [], 'lines').errors[0]!.message).toMatch(/at least 1/);
    expect(validateValue(grid, [{}, {}, {}], 'lines').errors.some(e => /at most 2/.test(e.message))).toBe(true);
    expect(validateValue(grid, 'nope', 'lines').errors).toHaveLength(1);
    const prev = [{ _row: '0190f3d2-1111-7000-8000-000000000009', qty: '1', old: 'kept' }];
    const again = validateValue(grid, [{ _row: '0190f3d2-1111-7000-8000-000000000009', qty: '3' }], 'lines', { previous: prev });
    expect(again.value).toEqual([{ _row: '0190f3d2-1111-7000-8000-000000000009', qty: '3', old: 'kept' }]);
  });

  it('helpers', () => {
    expect(canonicalDecimal('-0.0')).toBe('0');
    expect(canonicalDecimal('.5')).toBe('0.5');
    expect(canonicalDecimal(Infinity)).toBeNull();
    expect(canonicalDecimal({})).toBeNull();
    expect(isValidDateTime('2024-01-01T00:00Z')).toBe(true);
    expect(isValidUrl('http://user:pw@x.com')).toBe(false);
    expect(isValidPan('AAACI1681G')).toBe(true);
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
    expect(isValidGstin('00AAPFU0939F1ZV')).toBe(false);
    expect(normalizePhone('0091 98765 43210')).toBe('+919876543210');
    expect(normalizePhone('12', 'IN')).toBeNull();
    expect(defaultValue(f({ key: 'd', label: 'D', type: 'date', default: 'today' }), '2024-01-02')).toBe('2024-01-02');
    expect(defaultValue(f({ key: 'n', label: 'N', type: 'decimal', default: 1.5 }), '2024-01-02')).toBe('1.50');
    expect(defaultValue(f({ key: 'n', label: 'N', type: 'text' }), '2024-01-02')).toBeUndefined();
    expect(jsonEqual({ a: 1, b: [1] }, { b: [1], a: 1 })).toBe(true);
    expect(jsonEqual(null, '')).toBe(true);
    expect(formulaTypeOf({ type: 'formula', resultType: 'date' })).toBe('date');
    expect(formulaTypeOf({ type: 'multilookup' })).toBe('list');
    expect(masterAttributes(null)).toEqual({ code: 'text', name: 'text' });
    expect(prefixQuery('RM-001 steel')).toBe('rm:* & 001:* & steel:*');
    expect(prefixQuery('!!')).toBeNull();
    expect(expandCodePattern('PO/{YY}{MM}/{SEQ:3}', '2025-04-09')).toEqual({ prefix: 'PO/2504/', suffix: '', width: 3 });
    expect(expandCodePattern('X', '2025-04-09')).toEqual({ prefix: 'X', suffix: '', width: 4 });
    expect(filterValue(f({ key: 't', label: 'T', type: 'toggle' }), 'true')).toBe(true);
    expect(filterValue(f({ key: 'm', label: 'M', type: 'multiselect', options: [{ value: 'a', label: 'A' }] }), 'a')).toEqual(['a']);
    expect(filterValue(f({ key: 'n', label: 'N', type: 'decimal' }), '1.5')).toBe('1.50');
    expect(filterValue(f({ key: 'n', label: 'N', type: 'number' }), '1.5')).toBe('1.5');
  });
});

describe('structural checks (every issue code)', () => {
  const masters = new Map<string, MasterInfo>([
    ['cat', { active: true, def: FormDefinition.parse({ fields: [{ key: 'group', label: 'Group', type: 'text' }] }) }],
    ['old', { active: false, def: null }],
  ]);
  const check = (fields: unknown[], published: unknown[] | null = null, kind: 'master' | 'system' = 'master') =>
    checkStructure(FormDefinition.parse({ fields }), { kind, published: published ? FormDefinition.parse({ fields: published }) : null, masters, selfMasterKey: 'me' })
      .map(i => i.code);

  it('DUPLICATE_KEY incl. grid columns, RESERVED_KEY incl. code/name on masters', () => {
    expect(check([{ key: 'a', label: 'A', type: 'text' }, { key: 'g', label: 'G', type: 'grid', columns: [{ key: 'a', label: 'A', type: 'text' }] }])).toContain('DUPLICATE_KEY');
    expect(check([{ key: 'status', label: 'S', type: 'text' }])).toContain('RESERVED_KEY');
    expect(check([{ key: 'code', label: 'C', type: 'text' }])).toContain('RESERVED_KEY');
    expect(check([{ key: 'name', label: 'N', type: 'text' }], null, 'system')).toEqual([]);
  });

  it('SYSTEM_FIELD_REMOVED / SYSTEM_FIELD_RETYPED / FIELD_RETYPED', () => {
    const pub = [{ key: 's', label: 'S', type: 'text', system: true }, { key: 'n', label: 'N', type: 'number' }];
    expect(check([{ key: 'n', label: 'N', type: 'number' }], pub)).toContain('SYSTEM_FIELD_REMOVED');
    expect(check([{ key: 's', label: 'S', type: 'text', system: true, removed: true }, { key: 'n', label: 'N', type: 'number' }], pub)).toContain('SYSTEM_FIELD_REMOVED');
    expect(check([{ key: 's', label: 'S', type: 'text', system: false }, { key: 'n', label: 'N', type: 'number' }], pub)).toContain('SYSTEM_FIELD_REMOVED');
    expect(check([{ key: 's', label: 'S', type: 'textarea', system: true }, { key: 'n', label: 'N', type: 'number' }], pub)).toContain('SYSTEM_FIELD_RETYPED');
    expect(check([{ key: 's', label: 'S2', type: 'text', system: true }, { key: 'n', label: 'N', type: 'decimal' }], pub)).toEqual(['FIELD_RETYPED']);
    // label/order changes and removing a non-system field are fine
    expect(check([{ key: 's', label: 'Renamed', type: 'text', system: true }], pub)).toEqual([]);
  });

  it('UNKNOWN_MASTER for missing or inactive masters; self lookups allowed', () => {
    expect(check([{ key: 'l', label: 'L', type: 'lookup', source: { kind: 'master', masterKey: 'nope' } }])).toEqual(['UNKNOWN_MASTER']);
    expect(check([{ key: 'l', label: 'L', type: 'lookup', source: { kind: 'master', masterKey: 'old' } }])).toEqual(['UNKNOWN_MASTER']);
    expect(check([{ key: 'parent', label: 'P', type: 'lookup', source: { kind: 'master', masterKey: 'me' } }])).toEqual([]);
  });

  it('BAD_FILTER and BAD_AUTOFILL', () => {
    const lookup = (extra: Record<string, unknown>) => ({ key: 'l', label: 'L', type: 'lookup', source: { kind: 'master', masterKey: 'cat' }, ...extra });
    expect(check([lookup({ filterBy: [{ field: 'missing', targetField: 'group' }] })])).toEqual(['BAD_FILTER']);
    expect(check([{ key: 'p', label: 'P', type: 'text' }, lookup({ filterBy: [{ field: 'p', targetField: 'nofield' }] })])).toEqual(['BAD_FILTER']);
    expect(check([{ key: 'p', label: 'P', type: 'text' }, lookup({ filterBy: [{ field: 'p', targetField: 'group' }] })])).toEqual([]);
    expect(check([{ key: 'p', label: 'P', type: 'text' }, { key: 'u', label: 'U', type: 'lookup', source: { kind: 'user' }, filterBy: [{ field: 'p', targetField: 'name' }] }])).toEqual(['BAD_FILTER']);
    expect(check([lookup({ autofill: [{ from: 'nope', to: 'l' }] })])).toEqual(['BAD_AUTOFILL', 'BAD_AUTOFILL']);
    expect(check([{ key: 't', label: 'T', type: 'text' }, lookup({ autofill: [{ from: 'group', to: 't' }] })])).toEqual([]);
    expect(check([{ key: 't', label: 'T', type: 'formula', expr: '1' }, lookup({ autofill: [{ from: 'group', to: 't' }] })])).toContain('BAD_AUTOFILL');
    // grid: sibling column filter
    expect(check([{ key: 'lines', label: 'Lines', type: 'grid', columns: [
      { key: 'p', label: 'P', type: 'text' }, { key: 'l', label: 'L', type: 'lookup', source: { kind: 'master', masterKey: 'cat' }, filterBy: [{ field: 'p', targetField: 'group' }] },
    ] }])).toEqual([]);
  });

  it('BAD_REGEX, MIN_GT_MAX, LAYOUT_ORDER', () => {
    expect(check([{ key: 'r', label: 'R', type: 'regex', pattern: '([a-z' }])).toEqual(['BAD_REGEX']);
    expect(check([{ key: 'n', label: 'N', type: 'number', min: 5, max: 1 }])).toEqual(['MIN_GT_MAX']);
    expect(check([{ key: 't', label: 'T', type: 'text', minLength: 5, maxLength: 1 }])).toEqual(['MIN_GT_MAX']);
    expect(check([{ key: 'g', label: 'G', type: 'grid', minRows: 5, maxRows: 1, columns: [{ key: 'c', label: 'C', type: 'text' }] }])).toEqual(['MIN_GT_MAX']);
    expect(check([{ key: 'a', label: 'A', type: 'text' }, { key: 't1', type: 'tab', label: 'T1' }, { key: 'b', label: 'B', type: 'text' }])).toEqual(['LAYOUT_ORDER']);
    expect(check([{ key: 't1', type: 'tab', label: 'T1' }, { key: 't2', type: 'tab', label: 'T2' }, { key: 'b', label: 'B', type: 'text' }])).toEqual(['LAYOUT_ORDER']);
    expect(check([{ key: 't1', type: 'tab', label: 'T1' }, { key: 'b', label: 'B', type: 'text' }])).toEqual([]);
  });

  it('mergeForPublish carries removed fields and columns forward', () => {
    const pub = FormDefinition.parse({ fields: [
      { key: 'a', label: 'A', type: 'text' }, { key: 'g', label: 'G', type: 'grid', columns: [{ key: 'c1', label: 'C1', type: 'text' }, { key: 'c2', label: 'C2', type: 'text' }] },
    ] });
    const draft = FormDefinition.parse({ fields: [{ key: 'g', label: 'G', type: 'grid', columns: [{ key: 'c1', label: 'C1', type: 'text' }] }] });
    const m = mergeForPublish(draft, pub, 3);
    expect(m.version).toBe(3);
    expect(m.fields.map(x => [x.key, x.removed])).toEqual([['g', false], ['a', true]]);
    expect((m.fields[0] as { columns: { key: string; removed: boolean }[] }).columns.map(c => [c.key, c.removed])).toEqual([['c1', false], ['c2', true]]);
    expect(mergeForPublish(draft, null, 1).fields).toHaveLength(1);
    expect(emptyMasterDefinition().fields[0]!.type).toBe('section');
  });

  it('formula adapter evaluates through @procure/formula', () => {
    expect(formulaAvailable()).toBe(true);
    const def = FormDefinition.parse({ fields: [
      { key: 'a', label: 'A', type: 'decimal' }, { key: 'b', label: 'B', type: 'decimal' }, { key: 't', label: 'T', type: 'formula', expr: 'a * b', precision: 2 },
      { key: 'why', label: 'Why', type: 'text', requiredWhen: 'a > 10' },
    ] });
    const r = evaluateForm(def, { values: { a: '12', b: '1.5' }, today: '2024-01-01' });
    expect(r.values.t).toBe('18.00');
    expect(r.state.why!.required).toBe(true);
  });
});

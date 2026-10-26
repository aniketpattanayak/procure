import { describe, expect, it } from 'vitest';
import { compile } from '../src';
import { check, checkErr, ROW_SCOPE, SCOPE } from './helpers';

describe('result types', () => {
  it.each([
    ['qty * rate', 'number'],
    ["name & ' x'", 'text'],
    ['order_date + 5', 'date'],
    ['5 + order_date', 'date'],
    ['order_date - 5', 'date'],
    ['due_date - order_date', 'number'],
    ['qty > 5', 'boolean'],
    ['NULL', 'null'],
    ['IF(is_imported, qty, NULL)', 'number'],
    ['IF(is_imported, NULL, NULL)', 'null'],
    ['COALESCE(name, vendor.name)', 'text'],
    ['MIN(order_date, due_date)', 'date'],
    ['MAX(lines.rate)', 'number'],
    ['MIN(NULL)', 'number'],
    ['warehouse.anything', 'any'],
    ['warehouse.anything + 1', 'any'],
    ['order_date - warehouse.x', 'any'],
    ['warehouse.x - order_date', 'any'],
    ['NULL - order_date', 'any'],
    ['TODAY()', 'date'],
    ["DATE('2026-01-01')", 'date'],
    ['DATE(2026, 1, 1)', 'date'],
    ['TEXT(qty, 2)', 'text'],
    ['LEN(name)', 'number'],
    ['ISBLANK(tags)', 'boolean'],
    ['COUNT(tags)', 'number'],
    ['IFS(qty > 1, 1, qty > 0, 2)', 'number'],
  ])('%s : %s', (src, t) => {
    const c = check(src);
    expect(c.errors).toEqual([]);
    expect(c.resultType).toBe(t);
  });
});

describe('deps', () => {
  it('records header fields, lookup attributes and grid columns once each', () => {
    expect(check('SUM(lines.amount) + freight - discount + freight').deps).toEqual([
      'lines.amount',
      'freight',
      'discount',
    ]);
    expect(check('ADD_DAYS(TODAY(), vendor.credit_days)').deps).toEqual(['vendor.credit_days']);
    expect(check('COUNT(lines)').deps).toEqual(['lines']);
  });
  it('grid column formulas qualify row columns', () => {
    const c = check('qty * rate + freight + item.weight', ROW_SCOPE);
    expect(c.errors).toEqual([]);
    expect(c.deps).toEqual(['lines.qty', 'lines.rate', 'freight', 'lines.item']);
  });
});

describe('UNKNOWN_FIELD with suggestions', () => {
  it('header fields', () => {
    expect(checkErr('qtyy * 2')).toEqual({
      code: 'UNKNOWN_FIELD',
      message: "Unknown field 'qtyy'. Did you mean 'qty'?",
      start: 0,
      end: 4,
    });
    expect(checkErr('1 + Qty')).toMatchObject({
      message: "Unknown field 'Qty'. Did you mean 'qty'?",
      start: 4,
      end: 7,
    });
    expect(checkErr('zzzzzz')).toMatchObject({ message: "Unknown field 'zzzzzz'." });
    expect(checkErr('linez')).toMatchObject({ message: "Unknown field 'linez'. Did you mean 'lines'?" });
  });
  it('grid columns', () => {
    expect(checkErr('SUM(lines.amt)')).toMatchObject({
      code: 'UNKNOWN_FIELD',
      message: "Grid 'lines' has no column 'amt'.",
      start: 4,
      end: 13,
    });
    expect(checkErr('SUM(lines.amont)')).toMatchObject({
      message: "Grid 'lines' has no column 'amont'. Did you mean 'amount'?",
    });
  });
  it('lookup attributes', () => {
    expect(checkErr('vendor.gstn')).toMatchObject({
      code: 'UNKNOWN_FIELD',
      message: "Lookup 'vendor' has no attribute 'gstn'. Did you mean 'gstin'?",
    });
    expect(checkErr('qty.code')).toMatchObject({
      code: 'UNKNOWN_FIELD',
      message: "'qty' is not a lookup field, so 'qty.code' is not valid",
    });
    expect(checkErr('nope.code')).toMatchObject({
      code: 'UNKNOWN_FIELD',
      message: "Unknown field 'nope'. Did you mean 'name'?",
    });
    expect(check('vendor.gstin').resultType).toBe('text');
    expect(check('vendor.credit_days').resultType).toBe('number');
  });
  it('row scope', () => {
    expect(checkErr('item.colour', ROW_SCOPE)).toMatchObject({ message: "Lookup 'item' has no attribute 'colour'." });
    expect(checkErr('rate.x', ROW_SCOPE)).toMatchObject({
      message: "'rate' is not a lookup field, so 'rate.x' is not valid",
    });
    expect(checkErr('amout', ROW_SCOPE)).toMatchObject({ message: "Unknown field 'amout'. Did you mean 'amount'?" });
  });
  it('row lookup falls back to the bare key when the header has no such field', () => {
    const scope = {
      fields: {},
      grids: { g: { item: 'text' as const } },
      lookupAttributes: { item: { uom: 'text' as const } },
      rowOf: 'g',
    };
    expect(compile('item.uom', scope).ok).toBe(true);
    const shadowed = {
      fields: { item: 'text' as const },
      grids: { g: { item: 'text' as const } },
      lookupAttributes: { item: { uom: 'text' as const } },
      rowOf: 'g',
    };
    expect(compile('item.uom', shadowed).errors[0]!.message).toContain('is not a lookup');
  });
  it('unknown function', () => {
    expect(checkErr('SUMM(1)')).toEqual({
      code: 'UNKNOWN_FUNCTION',
      message: "Unknown function 'SUMM'. Did you mean 'SUM'?",
      start: 0,
      end: 4,
    });
    expect(checkErr('FOOBAR(qtyy)')).toMatchObject({ code: 'UNKNOWN_FUNCTION', message: "Unknown function 'FOOBAR'." });
    expect(compile('FOOBAR(qtyy)', SCOPE).errors).toHaveLength(2);
  });
});

describe('ARITY', () => {
  it.each([
    ['ROUND(1, 2, 3)', 'ROUND expects 1 to 2 arguments but got 3'],
    ['ABS()', 'ABS expects 1 argument but got 0'],
    ['TODAY(1)', 'TODAY expects 0 arguments but got 1'],
    ['SUMIF(lines.amount)', 'SUMIF expects 2 arguments but got 1'],
    ['IF(TRUE)', 'IF expects 2 to 3 arguments but got 1'],
    ['AND()', 'AND expects at least 1 argument but got 0'],
    ['IFS(TRUE)', 'IFS expects at least 2 arguments but got 1'],
    ['DATE(2026, 1)', 'DATE expects 1 or 3 arguments but got 2'],
    ['DAYS_BETWEEN(order_date)', 'DAYS_BETWEEN expects 2 arguments but got 1'],
  ])('%s', (src, message) => {
    expect(checkErr(src)).toMatchObject({ code: 'ARITY', message, start: 0, end: src.length });
  });
});

describe('TYPE errors', () => {
  it.each([
    ['name + 1', 'Cannot add text; use & to join text'],
    ['1 - name', 'Cannot subtract text'],
    ['is_imported + 1', "Cannot use TRUE/FALSE with '+'"],
    ['order_date + due_date', 'Cannot add two dates; use DAYS_BETWEEN or date - date'],
    ['qty - order_date', 'Cannot subtract a date from a number'],
    ['name * 2', "'*' needs a number but got text"],
    ['order_date / 2', "'/' needs a number but got a date"],
    ['-name', 'Minus needs a number but got text'],
    ['NOT qty', 'Expected TRUE/FALSE here but got a number'],
    ['qty AND is_imported', 'Expected TRUE/FALSE here but got a number'],
    ["qty = 'x'", 'Cannot compare a number with text'],
    ['is_imported > FALSE', 'TRUE/FALSE values can only be compared with = or !='],
    ["IF(qty > 1, 'a', 2)", 'IF branches return different types: text and a number'],
    ["IFS(qty > 1, 'a', 2)", 'IFS values return different types: text and a number'],
    ['IF(qty, 1, 2)', 'IF needs TRUE/FALSE here but got a number'],
    ['ROUND(name)', 'ROUND needs a number here but got text'],
    ['ADD_DAYS(qty, 1)', 'ADD_DAYS needs a date here but got a number'],
    ['YEAR(name)', 'YEAR needs a date here but got text'],
    ['UPPER(qty)', 'UPPER needs text here but got a number'],
    ['LEFT(name, name)', 'LEFT needs a number here but got text'],
    ["CONTAINS(qty, 'a')", 'CONTAINS needs text here but got a number'],
    ['TEXT(qty, name)', 'TEXT needs a number here but got text'],
    ['SUM(name)', 'SUM needs a number here but got text'],
    ['MIN(name)', 'MIN needs numbers or dates but got text'],
    ['MIN(qty, order_date)', 'MIN arguments return different types: a number and a date'],
    ['SUMIF(lines.status, lines.taxable)', 'SUMIF needs a number here but got text'],
    ['SUMIF(lines.amount, lines.qty)', 'SUMIF needs TRUE/FALSE here but got a number'],
    ['COUNTIF(lines.qty)', 'COUNTIF needs TRUE/FALSE here but got a number'],
    ['SUMIF(qty, is_imported)', 'SUMIF must refer to a grid column, e.g. SUMIF(lines.amount, lines.taxable = TRUE)'],
    ['COUNTIF(is_imported)', "COUNTIF must refer to a grid column, e.g. COUNTIF(lines.status = 'Open')"],
    ['SUM(lines.amount * charges.value)', "One aggregate can only read one grid, but this reads 'lines' and 'charges'"],
    ['DATE(name)', null],
    ['DATE(qty)', 'DATE needs text here but got a number'],
    ['DATE(name, 1, 1)', 'DATE needs a number here but got text'],
    ["DAYS_BETWEEN('soon', order_date)", 'DAYS_BETWEEN needs a date here but got text'],
  ])('%s', (src, message) => {
    const c = compile(src, SCOPE);
    if (message === null) {
      expect(c.errors).toEqual([]);
      return;
    }
    expect(c.errors[0]).toMatchObject({ code: 'TYPE', message });
  });

  it('multi-select lists only in COUNT / CONTAINS / ISBLANK', () => {
    const msg = 'Multi-select values can only be used with COUNT(…), CONTAINS(…) or ISBLANK(…)';
    for (const src of [
      "tags = 'a'",
      'tags + 1',
      "tags & 'x'",
      'tags * 2',
      'UPPER(tags)',
      'SUM(tags)',
      'MIN(tags)',
      'IF(TRUE, tags, NULL)',
      'CONCAT(tags)',
      '-tags',
      "COALESCE(tags, 'x')",
    ]) {
      expect(compile(src, SCOPE).errors[0], src).toMatchObject({ code: 'TYPE', message: msg });
    }
    expect(check("CONTAINS(tags, 'a')").ok).toBe(true);
  });

  it('date/text comparisons and ISO literals are allowed', () => {
    expect(check("order_date >= '2026-01-01'").ok).toBe(true);
    expect(check("ADD_DAYS('2026-01-01', 3)").ok).toBe(true);
    expect(check("'2026-01-31'", SCOPE, 'date').ok).toBe(true);
    expect(check("'2026-02-31'", SCOPE, 'date').ok).toBe(false);
  });
});

describe('AGGREGATE_REQUIRED', () => {
  it('grid columns outside an aggregate', () => {
    expect(checkErr('lines.amount * 2')).toEqual({
      code: 'AGGREGATE_REQUIRED',
      message:
        "'lines.amount' reads every row of grid 'lines'; wrap it in SUM, AVG, MIN, MAX or COUNT, e.g. SUM(lines.amount)",
      start: 0,
      end: 12,
    });
    expect(checkErr('ROUND(lines.amount)')).toMatchObject({ code: 'AGGREGATE_REQUIRED', start: 6, end: 18 });
    expect(checkErr('lines')).toMatchObject({
      code: 'AGGREGATE_REQUIRED',
      message: "Grid 'lines' holds many rows; use COUNT(lines) or an aggregate such as SUM(lines.column)",
    });
    expect(checkErr('SUM(lines)')).toMatchObject({ code: 'AGGREGATE_REQUIRED' });
  });
  it('allowed inside aggregates and row expressions', () => {
    for (const src of [
      'SUM(lines.amount)',
      'AVG(lines.rate)',
      'MIN(lines.rate)',
      'MAX(lines.delivery)',
      'COUNT(lines.qty)',
      'COUNT(lines)',
      'SUM(IF(lines.taxable, lines.amount, 0))',
      'SUM(lines.qty * lines.rate) + SUM(charges.value)',
      'SUM(lines.amount * SUM(charges.value))',
    ]) {
      expect(check(src).errors, src).toEqual([]);
    }
  });
  it('a grid column formula may aggregate its own grid', () => {
    const c = check('amount / SUM(lines.amount) * 100', ROW_SCOPE);
    expect(c.errors).toEqual([]);
    expect(c.deps).toEqual(['lines.amount']);
    expect(checkErr('lines.amount', ROW_SCOPE)).toMatchObject({ code: 'AGGREGATE_REQUIRED' });
  });
});

describe('expected result type', () => {
  it('matches', () => {
    expect(check('qty > 1', SCOPE, 'boolean').ok).toBe(true);
    expect(check('NULL', SCOPE, 'boolean').ok).toBe(true);
    expect(check('warehouse.x', SCOPE, 'date').ok).toBe(true);
    expect(check('qty', SCOPE, 'any').ok).toBe(true);
    expect(check('qty', SCOPE).ok).toBe(true);
  });
  it('mismatches', () => {
    expect(checkErr('qty', SCOPE, 'boolean')).toEqual({
      code: 'TYPE',
      message: 'This formula returns a number but TRUE/FALSE is expected',
      start: 0,
      end: 3,
    });
    expect(checkErr("'x'", SCOPE, 'number')).toMatchObject({
      message: 'This formula returns text but a number is expected',
    });
    expect(checkErr('order_date', SCOPE, 'text')).toMatchObject({
      message: 'This formula returns a date but text is expected',
    });
  });
});

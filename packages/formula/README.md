# @procure/formula

The safe expression language behind formula fields, `visibleWhen` / `requiredWhen` / `readOnlyWhen`, `minDate` /
`maxDate`, form `validations` and (Phase 3) workflow conditions. The same code runs in the browser and the API.

- Contract: [`docs/contracts/formula-language.md`](../../docs/contracts/formula-language.md), types in
  [`packages/schema/src/formula.ts`](../schema/src/formula.ts).
- A hand-written tokenizer and Pratt parser produce an AST with source offsets. There is no `eval`, no `Function`,
  no regex-based evaluation and no third-party expression library. Values are only read through own-property checks,
  so `constructor`, `__proto__` and similar names can never reach host objects.
- Numbers use decimal.js at 40 significant digits. Results are rounded half-up to the field's precision and returned
  as decimal strings. Dates are pure calendar arithmetic on `'YYYY-MM-DD'`, with no `Date` objects and no timezone.
- No Node built-ins. The only runtime dependency is `decimal.js` (`@procure/schema` is imported for types only).

## API

```ts
import { parse, compile, evaluate, scopeFromDefinition, checkDefinition, evaluateForm, FUNCTIONS } from '@procure/formula';
```

### `parse(src): { ast: Node | null; errors: FormulaError[] }`
Syntax only. The result is either an AST or the first `SYNTAX` / `LIMIT` error with `start`/`end` offsets.

```ts
parse('qty *');   // { ast: null, errors: [{ code: 'SYNTAX', message: 'Formula ends unexpectedly', start: 5, end: 5 }] }
```

### `compile(src, scope, expected?): CompiledFormula`
Design-time check against a `FormulaScope`. It covers unknown fields and functions (with a "did you mean" suggestion
at Levenshtein distance ≤ 2), arity, types, the aggregate rule, and whether the result matches `expected`.

```ts
const scope = {
  fields: { qty: 'number', freight: 'number', vendor: 'text' },
  grids: { lines: { qty: 'number', rate: 'number', amount: 'number' } },
  lookupAttributes: { vendor: { code: 'text', name: 'text', credit_days: 'number' } },
};
compile('SUM(lines.amount) + freight', scope, 'number');
// { ok: true, errors: [], resultType: 'number', deps: ['lines.amount', 'freight'] }
compile('qtyy * 2', scope);
// errors: [{ code: 'UNKNOWN_FIELD', message: "Unknown field 'qtyy'. Did you mean 'qty'?", start: 0, end: 4 }]
compile('lines.amount * 2', scope);   // AGGREGATE_REQUIRED
compile('qty * rate', { ...scope, rowOf: 'lines' }).deps;   // ['lines.qty', 'lines.rate'] (a grid column formula)
```

### `evaluate(src, ctx): { value; error? }`
Evaluates one formula against raw values. No scope is needed: decimal strings and JS numbers are numbers, valid
`'YYYY-MM-DD'` strings are dates, arrays of rows are grids, and unknown names are empty. Numbers are rounded to
`ctx.defaultPrecision` when it is set; otherwise you get full precision.

```ts
evaluate('0.1 + 0.2', { values: {}, today: '2026-10-22' });                        // { value: '0.3' }
evaluate('ROUND(2.675, 2)', { values: {}, today: '2026-10-22' });                  // { value: '2.68' }
evaluate('ADD_DAYS(TODAY(), vendor.credit_days)', { values: {}, lookups: { vendor: { credit_days: '45' } }, today: '2026-10-22' });
// { value: '2026-12-06' }
evaluate('qty * rate', { values: {}, row: { qty: '3', rate: '2.5' }, today: '2026-10-22' }); // { value: '7.5' }
evaluate('1 / 0', { values: {}, today: '2026-10-22' });
// { value: null, error: { code: 'RUNTIME', message: 'Division by zero', start: 0, end: 5 } }
```

### `scopeFromDefinition(def, lookupAttributes?): FormulaScope`
Builds the scope for a form. Each field type maps to a formula type: number/decimal/currency/percentage → number;
date → date; checkbox/toggle → boolean; multiselect/multilookup/files → list; formula → its `resultType`; everything
else that stores a value → text. Grids go into `grids`. Layout elements, removed fields and date ranges are left out.
Keys in `lookupAttributes` are the header lookup key (`vendor`) or `<grid>.<column>` for a lookup column
(`lines.item`). `code` and `name` are always text. A lookup with no supplied attributes accepts any attribute, typed
`any` (stored in the scope as `'*': 'any'`).

### `checkDefinition(def, lookupAttributes?): FormDefinitionIssue[]`
Checks every expression on the form:
- formula `expr`, for header fields and grid columns
- `visibleWhen`, `requiredWhen` and `readOnlyWhen` on fields, columns, tabs and sections (must be boolean)
- `minDate` and `maxDate` (must be dates)
- `validations[].expr` (must be boolean)

It also finds cycles across header and grid formulas. Error codes map to issue codes as follows:

| Formula error | Issue code |
| --- | --- |
| SYNTAX, LIMIT, UNKNOWN_FUNCTION | `FORMULA_SYNTAX` |
| UNKNOWN_FIELD | `UNKNOWN_FIELD_REF` |
| TYPE, ARITY, AGGREGATE_REQUIRED | `FORMULA_TYPE` |
| CYCLE | `FORMULA_CYCLE` |

```ts
checkDefinition(def);
// [{ path: 'fields.7.expr', code: 'FORMULA_CYCLE', message: 'Circular reference: total → discount → total' },
//  { path: 'fields.5.columns.2.expr', code: 'UNKNOWN_FIELD_REF', message: "Unknown field 'qtyy'. Did you mean 'qty'?" },
//  { path: 'fields.4.visibleWhen', code: 'FORMULA_TYPE', message: 'This formula returns a number but TRUE/FALSE is expected' }]
```

### `evaluateForm(def, input): FormEvaluation`
`input = { values, lookups?, rowLookups?, today, defaultPrecision? }`. `rowLookups[grid][rowId][column]` holds the
attributes of the record chosen in that row (`rowId` is the row's `_row`).

The function works in three steps:
1. It computes every formula in dependency order, across header fields and grid columns. A grid column is filled for
   every row at once.
2. It works out `visible`, `required` and `readOnly` for every non-removed field, tab, section, divider/help and grid
   column (`'<grid>.<col>'`). A field is hidden when its tab or section is hidden, or when it has `hidden: true`.
   Hidden fields are never required. Formula fields are always read-only.
3. It evaluates `validations`.

The input is never mutated.

```ts
const r = evaluateForm(poDefinition, {
  values: { freight: '100', lines: [{ _row: 'r1', qty: '600', rate: '10.005' }, { _row: 'r2', qty: '500', rate: '2' }] },
  today: '2026-10-22',
});
// amount = qty * rate                                   -> lines: [{ ..., amount: '6003.00' }, { ..., amount: '1000.00' }]
// discount = IF(SUM(lines.qty) >= 1000, SUM(lines.amount) * 0.10, 0)   -> '700.30'
// total = SUM(lines.amount) + freight - discount       -> '6402.70'
r.state.justification; // { visible: false, required: false, readOnly: false } when priority != 'Urgent'
r.errors;              // { ratio: { code: 'RUNTIME', message: 'Division by zero', start, end }, 'lines.r2.inv': {...} }
r.validations;         // [{ key: 'positive', message: 'Total must be positive', ok: true }]
r.dateBounds;          // { order_date: { min: '2026-09-22', max: '2026-12-31' } }
```

### `FUNCTIONS`
A frozen list of `{ name, signature, description, example }` for editor autocomplete. Every example is checked by a
test to make sure it parses.

## Language summary

| | |
| --- | --- |
| Literals | `12`, `0.5`, `1e3`, `'text'`, `"it's"`, `TRUE`, `false`, `NULL` |
| Escapes | `\\`, `\'` and `\"` only |
| References | `qty`, `vendor.gstin` (lookup attribute), `lines.amount` (inside aggregates only), `COUNT(lines)` |
| Operators (low → high) | `OR \|\|` · `AND &&` · `NOT !` · `= != <> < <= > >=` · `&` · `+ -` · `* / %` · unary `-` · call/ref |
| Limits | 2,000 characters · 500 AST nodes · nesting depth 50 → `LIMIT` |

Functions:
- Logic: `IF`, `IFS`, `AND`, `OR`, `NOT`, `COALESCE`, `ISBLANK`
- Numbers: `ROUND`, `FLOOR`, `CEIL`, `ABS`
- Aggregates: `MIN`, `MAX`, `SUM`, `AVG`, `COUNT`, `SUMIF`, `COUNTIF`
- Dates: `TODAY`, `DATE`, `DAYS_BETWEEN`, `ADD_DAYS`, `YEAR`, `MONTH`, `DAY`
- Text: `CONCAT`, `UPPER`, `LOWER`, `TRIM`, `LEN`, `LEFT`, `RIGHT`, `CONTAINS`, `TEXT`

An aggregate argument is evaluated once per grid row, so expressions like `SUM(lines.qty * lines.rate)` and
`SUM(IF(lines.taxable, lines.amount, 0))` work. Slab pricing:
`IFS(total > 100000, total * 0.05, total > 50000, total * 0.03, 0)`.

## Development

```
pnpm --filter @procure/formula build | typecheck | test     # test prints v8 coverage; thresholds 90% in vitest.config.mts
```

There are 350+ tests, including fast-check property tests and a benchmark. The benchmark evaluates 200 rows × 3
formula columns plus 5 header formulas and must finish in under 50 ms; it typically takes about 3 ms.

## Decisions

The contract is silent or ambiguous on the points below. Each entry records the reading this package implements.
The lead reviewed these after the Phase 2 build; items marked **(accepted)** were confirmed then.

1. **Nesting limit.** Depth counts syntactic nesting only: parentheses, function-call arguments and unary operators.
   Long left-associative chains such as `a + b + c + …` are limited by the 500-node cap instead. Otherwise, adding up
   51 fields would fail.
2. **Escapes.** Only `\\`, `\'` and `\"` are recognised. Any other backslash escape is a `SYNTAX` error. A literal
   newline inside a string is allowed.
3. **Keyword names called with brackets.** `NOT(…)`, `AND(…)` and `OR(…)` written with brackets are function calls,
   which bind tighter than any operator. So `NOT(a) = b` means `(NOT a) = b`, while `NOT a = b` means `NOT (a = b)`.
4. **Keywords are reserved field keys (amended contract).** `and`, `or`, `not`, `true`, `false` and `null` are in
   `RESERVED_FIELD_KEYS`, so they cannot be used as field keys. The `RESERVED_KEY` issue is raised by the forms
   service (`apps/api/src/modules/forms/structure.ts`) and by the builder's local checks, for both fields and grid
   columns. `checkDefinition` does not repeat it, so issues are never reported twice.
5. **Empty text is null everywhere.** This includes the literal `''` and any function that returns `''`. As a
   result, `name = ''` is TRUE when `name` is empty, and `&` treats null as `''`.
6. **Null in a boolean position is FALSE.** This applies to `IF`/`IFS` conditions, `AND`/`OR`/`NOT`, `*When`
   expressions and validations. A validation that evaluates to empty therefore blocks the save.
7. **Null comparisons (amended contract).** `null = null` is TRUE. `x != y` / `x <> y` is TRUE when exactly one
   side is null, because an empty value is "not equal" to any value, and `NULL != NULL` is FALSE. `<`, `<=`, `>`
   and `>=` are FALSE whenever either side is null.
8. **Empty dates in arithmetic.** If either operand is an empty value whose type is date, the result is empty. An
   empty number added to a date counts as 0 days, so `ADD_DAYS(d, NULL)` returns `d`.
9. **Text comparison is case-sensitive.** `=` compares exactly, ordering uses code units (no locale), and `CONTAINS`
   is case-sensitive for both text and lists.
10. **ISO date literals.** A string such as `'2026-03-31'` is accepted wherever a date is expected, including as the
    whole of a `minDate` expression. Dates can be compared with text, which compares the ISO strings.
11. **Additions beyond the minimum function set:**
    - `DATE('YYYY-MM-DD')` and `DATE(y, m, d)` (strict: an invalid date is a runtime error)
    - `IF` with 2 arguments returns empty for the missing else
    - `IFS` without a default returns empty
    - `LEFT`/`RIGHT` take `n = 1` by default
    - `TEXT(x)` with no places gives plain text
    - `ROUND`/`FLOOR`/`CEIL` accept negative places (`ROUND(1250, -2)` = 1300); places must be within ±20
    - `SUM`, `AVG`, `MIN` and `MAX` also accept scalar arguments
    - `MIN`/`MAX` work on dates
12. **`COUNTIF` takes one argument:** `COUNTIF(condition)`. `SUMIF` and `COUNTIF` must refer to a grid column. Each
    aggregate may read only one grid.
13. **Half-up rounding** is half away from zero for negative numbers (`-2.675` → `-2.68`). Results never read `-0`.
14. **Evaluation order.** Formulas run in one topological order across header and grid formulas, rather than
    "all grid columns, then the header". This lets a grid column read a header formula, as in
    `share = amount / total * 100`, and gives the same results as the contract's order whenever that order works.
    Downstream formulas read upstream formula values after rounding (as stored), so line amounts always add up to
    the total.
15. **Formula precision** is `field.precision ?? defaultPrecision ?? 2`. The contract lists defaults only for the
    numeric input types.
16. **Grid-column `*When` / `minDate` / `maxDate` run in header scope (accepted).** `state` holds one entry
    per column, not per row, so these expressions cannot see row values. Per-row `requiredWhen` would need a change
    to the contract.
17. **Error keys (accepted).** The contract keys `errors` by field. This package uses:
    - `<field>` for header formulas
    - `<grid>.<rowId>.<col>` for a runtime error in a grid cell (`rowId` is `_row`, or the row index if `_row` is
      missing)
    - `<grid>.<col>` for a compile error or cycle in a grid column formula
    - `<key>.visibleWhen`, `<key>.requiredWhen`, `<key>.readOnlyWhen`, `<key>.minDate` and `<key>.maxDate` for
      failures in those expressions
18. **Fallbacks when a `*When` expression fails:** `visible = true` (fail open, so the user can still see the
    field), `required = false`, `readOnly = false`. The error is still reported.
19. **Extra result fields (accepted into the contract).** `evaluateForm` always fills the optional `validations`
    and `dateBounds` fields of `FormEvaluationResult`. A bound that isn't set is `null`.
20. **`deps` for a row lookup attribute** is `<grid>.<column>`, for example `lines.item` rather than
    `lines.item.uom`. Header lookup attributes stay `vendor.gstin`, as the contract specifies.
21. **Field types that cannot be referenced.** A date range cannot be referenced and gets a clear error message.
    `time` and `datetime` are text. `file`, `image` and `signature` are text (the id). `files` is a list. A field
    with the static `hidden: true` flag is treated as not visible.
22. **Removed fields and layout elements.** Removed fields, tabs and sections are ignored: they get no state and do
    not start a container, and their stored values are kept. Referring to a removed field or a layout element gives
    `UNKNOWN_FIELD_REF` with an explanation.
23. **Standalone `evaluate()` is dynamically typed** (see the API section above). Text that looks like a number is
    treated as a number there; `evaluateForm` uses the declared field types instead.
24. **Very large numbers.** Exponents are capped at ±1000. A result that overflows is a `RUNTIME` error ("Number is
    too large"), and one that underflows becomes 0. A numeric literal too large to represent is a `LIMIT` error.
25. **Spans and issue counts.** AST spans do not include surrounding parentheses. `checkDefinition` can report
    several issues for one expression. Each field on a cycle gets its own `FORMULA_CYCLE` issue, with the loop
    rotated so that it starts at that field.
26. **`==` is rejected** with the hint "Use '=' to compare".

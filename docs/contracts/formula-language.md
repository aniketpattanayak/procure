# Formula language (FROZEN, Phase 2)

Safe expression language for formula fields, conditional visibility/required/read-only, form validations and
(Phase 3) workflow routing conditions. Implemented once in `packages/formula` and run identically in the browser and
on the server. **No `eval`, no `Function`, no property access on host objects.** Types in `packages/schema/src/formula.ts`.

## Lexical
| Token | Examples | Notes |
| --- | --- | --- |
| Number | `12`, `0.5`, `1e3` | Parsed into decimal.js, never JS float |
| String | `'Urgent'`, `"it's"` | Single or double quotes; `\\` escapes the quote and backslash |
| Boolean / null | `TRUE`, `FALSE`, `true`, `NULL` | Case-insensitive |
| Field ref | `qty`, `vendor.gstin`, `lines.amount` | Field keys are `[a-z][a-z0-9_]*`; one dot level only |
| Function | `ROUND(x, 2)` | Names case-insensitive |
| Operators | `+ - * / %` `&` (text concat) `= != <> < <= > >=` `AND OR NOT` `&& \|\| !` | |
| Grouping | `( )` and `,` | |

Precedence (low → high): `OR ||` · `AND &&` · `NOT !` · comparisons · `&` · `+ -` · `* / %` · unary `-` · call/ref.

Limits: source ≤ 2,000 characters; AST ≤ 500 nodes; nesting ≤ 50. Exceeding → `LIMIT` error at design time.

## References
- **Header formula**: bare `qty` = header field. `vendor.gstin` = attribute of the record chosen in lookup `vendor`
  (`code`, `name`, or any data key of that master). `lines.amount` is only valid **inside an aggregate**
  (`SUM`, `AVG`, `MIN`, `MAX`, `COUNT`) and means "column `amount` of every row of grid `lines`"; otherwise
  `AGGREGATE_REQUIRED`.
- **Grid column formula** (`rowOf = 'lines'`): bare `qty` = this row's column if the grid has one, else the header
  field. `item.uom` = attribute of this row's lookup `item`.
- Referencing a layout element, a removed field, or itself → error. Unknown names → `UNKNOWN_FIELD` with a
  "did you mean" suggestion (Levenshtein ≤ 2).

## Types and coercion
`number | text | date | boolean | null`. Empty values are `null`.
- Arithmetic on `null` treats it as 0 (`qty * rate` with empty rate = 0). Comparisons with `null`: `null = null` is
  TRUE; `x != y` / `x <> y` is TRUE when exactly one side is null (empty is "not equal" to any value); `<`, `<=`,
  `>`, `>=` with a null on either side are FALSE. (Amended Phase 2 review.)
- Field keys `and`, `or`, `not`, `true`, `false`, `null` are reserved (`RESERVED_FIELD_KEYS`).
- Grid column `visibleWhen`/`requiredWhen`/`readOnlyWhen`/`minDate`/`maxDate` see header fields only (state is per
  column, not per row). Per-row conditions are a possible later extension.
- Evaluation runs in a single dependency order across header and grid, so a column may read a header formula
  (`share = amount / total * 100`); downstream formulas read upstream values after rounding.
- `text + number` is a `TYPE` error at design time; use `&` for concatenation (numbers format plainly, dates ISO).
- `date + number` / `date - number` = days added (same as `ADD_DAYS`); `date - date` = number of days.
- Select/radio values are text; checkbox/toggle are boolean; lookups compare by id (text); multiselect/multilookup
  support only `COUNT(field)` and `CONTAINS(field, 'value')`.
- Division by zero → runtime error for that field (value null, error shown next to the field); never Infinity.
- Results: `number` rounded to the field's `precision` (default 2 for decimal/currency/percentage, 0 for number) with
  half-up rounding; returned as a decimal string.

## Functions (minimum set)
| Function | Signature | Notes |
| --- | --- | --- |
| IF | `IF(cond, then, else)` | Lazy: only the chosen branch is evaluated |
| IFS | `IFS(c1, v1, c2, v2, …, default)` | |
| AND / OR / NOT | `AND(a, b, …)` | Also operators |
| ROUND / FLOOR / CEIL | `ROUND(n, places=0)` | Half-up |
| ABS, MIN, MAX | `MIN(a, b, …)` or `MIN(lines.rate)` | |
| SUM, AVG, COUNT | `SUM(lines.amount)` | Over grid columns; `COUNT(lines)` = row count |
| SUMIF, COUNTIF | `SUMIF(lines.amount, lines.taxable = TRUE)` | Condition over the same grid |
| COALESCE | `COALESCE(a, b, …)` | First non-null |
| ISBLANK | `ISBLANK(x)` | null or '' |
| TODAY | `TODAY()` | Tenant-timezone date injected via context |
| DAYS_BETWEEN | `DAYS_BETWEEN(start, end)` | end − start in days |
| ADD_DAYS | `ADD_DAYS(date, n)` | |
| YEAR, MONTH, DAY | `MONTH(d)` | |
| CONCAT | `CONCAT(a, b, …)` | Same as `&` |
| UPPER, LOWER, TRIM, LEN | | |
| LEFT, RIGHT | `LEFT(text, n)` | |
| CONTAINS | `CONTAINS(text_or_list, needle)` | |
| TEXT | `TEXT(n, places)` | Number → text with fixed places |

## Design-time checks (`checkDefinition`)
Syntax, unknown fields/functions, arity, types (including `visibleWhen` etc. must be boolean and formula
`resultType` must match), aggregate rule, and **cycles** across all formula fields and grid columns (topological sort;
the error names the loop: `total → discount → total`).

## Evaluation order (`evaluateForm`)
1–2. All formula fields (header and grid columns, row by row) in one topological order; aggregates see computed
column values. 3. `visibleWhen` / `requiredWhen` / `readOnlyWhen` for every field, tab and section.
Hidden fields keep their stored values but are not required.

## Examples
```
amount   = qty * rate                                        (grid column)
discount = IF(SUM(lines.qty) >= 1000, SUM(lines.amount) * 0.10, 0)
total    = SUM(lines.amount) + freight - discount
due_on   = ADD_DAYS(TODAY(), vendor.credit_days)
visibleWhen on 'justification': priority = 'Urgent'
```

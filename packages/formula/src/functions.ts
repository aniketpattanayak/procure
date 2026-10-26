export interface FunctionInfo {
  name: string;
  signature: string;
  description: string;
  example: string;
}

interface Spec extends FunctionInfo {
  min: number;
  max: number;
  /** Arguments may be grid-column row expressions (SUM(lines.amount)). */
  aggregate?: boolean;
}

const V = Infinity;

const SPECS: Spec[] = [
  // Logic
  {
    name: 'IF',
    min: 2,
    max: 3,
    signature: 'IF(condition, then, else)',
    description:
      'Returns `then` when the condition is TRUE, otherwise `else` (empty when omitted). Only the chosen branch is evaluated.',
    example: 'IF(qty >= 1000, amount * 0.10, 0)',
  },
  {
    name: 'IFS',
    min: 2,
    max: V,
    signature: 'IFS(cond1, value1, cond2, value2, …, default)',
    description: 'Returns the value of the first TRUE condition; the optional last argument is the default.',
    example: 'IFS(total > 100000, 0.05, total > 50000, 0.03, 0)',
  },
  {
    name: 'AND',
    min: 1,
    max: V,
    signature: 'AND(a, b, …)',
    description: 'TRUE when every argument is TRUE. Stops at the first FALSE.',
    example: "AND(qty > 0, status = 'Open')",
  },
  {
    name: 'OR',
    min: 1,
    max: V,
    signature: 'OR(a, b, …)',
    description: 'TRUE when any argument is TRUE. Stops at the first TRUE.',
    example: "OR(priority = 'Urgent', total > 50000)",
  },
  {
    name: 'NOT',
    min: 1,
    max: 1,
    signature: 'NOT(a)',
    description: 'Reverses TRUE and FALSE.',
    example: 'NOT(is_imported)',
  },
  {
    name: 'COALESCE',
    min: 1,
    max: V,
    signature: 'COALESCE(a, b, …)',
    description: 'The first argument that is not empty.',
    example: 'COALESCE(discount, 0)',
  },
  {
    name: 'ISBLANK',
    min: 1,
    max: 1,
    signature: 'ISBLANK(value)',
    description: 'TRUE when the value is empty.',
    example: 'ISBLANK(remarks)',
  },
  // Numbers
  {
    name: 'ROUND',
    min: 1,
    max: 2,
    signature: 'ROUND(number, places=0)',
    description: 'Rounds half-up (away from zero) to the given decimal places.',
    example: 'ROUND(amount * 0.18, 2)',
  },
  {
    name: 'FLOOR',
    min: 1,
    max: 2,
    signature: 'FLOOR(number, places=0)',
    description: 'Rounds down (towards negative infinity).',
    example: 'FLOOR(qty / 12)',
  },
  {
    name: 'CEIL',
    min: 1,
    max: 2,
    signature: 'CEIL(number, places=0)',
    description: 'Rounds up (towards positive infinity).',
    example: 'CEIL(qty / pack_size)',
  },
  { name: 'ABS', min: 1, max: 1, signature: 'ABS(number)', description: 'Absolute value.', example: 'ABS(variance)' },
  {
    name: 'MIN',
    min: 1,
    max: V,
    aggregate: true,
    signature: 'MIN(a, b, …) or MIN(grid.column)',
    description: 'Smallest number or earliest date; empty values are skipped.',
    example: 'MIN(lines.rate)',
  },
  {
    name: 'MAX',
    min: 1,
    max: V,
    aggregate: true,
    signature: 'MAX(a, b, …) or MAX(grid.column)',
    description: 'Largest number or latest date; empty values are skipped.',
    example: 'MAX(lines.delivery_date)',
  },
  {
    name: 'SUM',
    min: 1,
    max: V,
    aggregate: true,
    signature: 'SUM(grid.column) or SUM(a, b, …)',
    description: 'Adds numbers; over a grid column it adds every row.',
    example: 'SUM(lines.amount)',
  },
  {
    name: 'AVG',
    min: 1,
    max: V,
    aggregate: true,
    signature: 'AVG(grid.column) or AVG(a, b, …)',
    description: 'Average of the non-empty numbers.',
    example: 'AVG(lines.rate)',
  },
  {
    name: 'COUNT',
    min: 1,
    max: V,
    aggregate: true,
    signature: 'COUNT(grid) or COUNT(grid.column) or COUNT(multiselect)',
    description: 'Row count of a grid, non-empty values of a column, or number of selected items.',
    example: 'COUNT(lines)',
  },
  {
    name: 'SUMIF',
    min: 2,
    max: 2,
    signature: 'SUMIF(grid.column, condition)',
    description: 'Adds the column for rows where the condition (over the same grid) is TRUE.',
    example: 'SUMIF(lines.amount, lines.taxable = TRUE)',
  },
  {
    name: 'COUNTIF',
    min: 1,
    max: 1,
    signature: 'COUNTIF(condition)',
    description: 'Number of grid rows where the condition is TRUE.',
    example: "COUNTIF(lines.status = 'Rejected')",
  },
  // Dates
  {
    name: 'TODAY',
    min: 0,
    max: 0,
    signature: 'TODAY()',
    description: "Today's date in the organisation's timezone.",
    example: 'TODAY()',
  },
  {
    name: 'DATE',
    min: 1,
    max: 3,
    signature: "DATE('YYYY-MM-DD') or DATE(year, month, day)",
    description: 'Builds a date from text or from year, month and day.',
    example: 'DATE(2026, 3, 31)',
  },
  {
    name: 'DAYS_BETWEEN',
    min: 2,
    max: 2,
    signature: 'DAYS_BETWEEN(start, end)',
    description: 'Number of days from start to end (end − start).',
    example: 'DAYS_BETWEEN(order_date, due_date)',
  },
  {
    name: 'ADD_DAYS',
    min: 2,
    max: 2,
    signature: 'ADD_DAYS(date, days)',
    description: 'Date plus a number of days (negative to go back).',
    example: 'ADD_DAYS(TODAY(), vendor.credit_days)',
  },
  {
    name: 'YEAR',
    min: 1,
    max: 1,
    signature: 'YEAR(date)',
    description: 'Year of a date.',
    example: 'YEAR(order_date)',
  },
  {
    name: 'MONTH',
    min: 1,
    max: 1,
    signature: 'MONTH(date)',
    description: 'Month (1–12) of a date.',
    example: 'MONTH(order_date)',
  },
  {
    name: 'DAY',
    min: 1,
    max: 1,
    signature: 'DAY(date)',
    description: 'Day of the month (1–31).',
    example: 'DAY(order_date)',
  },
  // Text
  {
    name: 'CONCAT',
    min: 1,
    max: V,
    signature: 'CONCAT(a, b, …)',
    description: 'Joins values as text (same as &).',
    example: "CONCAT(vendor.code, ' - ', vendor.name)",
  },
  { name: 'UPPER', min: 1, max: 1, signature: 'UPPER(text)', description: 'Upper-case text.', example: 'UPPER(code)' },
  { name: 'LOWER', min: 1, max: 1, signature: 'LOWER(text)', description: 'Lower-case text.', example: 'LOWER(email)' },
  {
    name: 'TRIM',
    min: 1,
    max: 1,
    signature: 'TRIM(text)',
    description: 'Removes leading and trailing spaces.',
    example: 'TRIM(name)',
  },
  {
    name: 'LEN',
    min: 1,
    max: 1,
    signature: 'LEN(text)',
    description: 'Number of characters.',
    example: 'LEN(remarks) > 10',
  },
  {
    name: 'LEFT',
    min: 1,
    max: 2,
    signature: 'LEFT(text, n=1)',
    description: 'First n characters.',
    example: 'LEFT(gstin, 2)',
  },
  {
    name: 'RIGHT',
    min: 1,
    max: 2,
    signature: 'RIGHT(text, n=1)',
    description: 'Last n characters.',
    example: 'RIGHT(code, 4)',
  },
  {
    name: 'CONTAINS',
    min: 2,
    max: 2,
    signature: 'CONTAINS(text_or_list, needle)',
    description: 'TRUE when the text contains the needle, or the multi-select list includes it (case-sensitive).',
    example: "CONTAINS(tags, 'urgent')",
  },
  {
    name: 'TEXT',
    min: 1,
    max: 2,
    signature: 'TEXT(number, places)',
    description: 'Number as text with a fixed number of decimal places.',
    example: "'Total: ' & TEXT(total, 2)",
  },
];

/** Editor autocomplete metadata. */
export const FUNCTIONS: readonly FunctionInfo[] = Object.freeze(
  SPECS.map(({ name, signature, description, example }) => Object.freeze({ name, signature, description, example })),
);

export const FN_SPECS: ReadonlyMap<string, Spec> = new Map(SPECS.map(s => [s.name, s]));
export const FN_NAMES: readonly string[] = SPECS.map(s => s.name);

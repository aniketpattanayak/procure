import { z } from 'zod';

/**
 * FORM DEFINITION CONTRACT (Phase 2, frozen).
 * One JSON document drives the builder, the browser renderer and server-side validation of every form:
 * masters, the user form and (Phase 4+) transaction headers and lines.
 *
 * Layout is inline: `fields` is the render order. A `tab` element starts a new tab, a `section` element starts a
 * section (until the next section/tab). `divider` and `help` are decorative. Layout elements store no data.
 */

export const FieldKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'Use lowercase letters, digits and _ ; start with a letter');

/** Expression in the formula language (packages/formula). Max 2,000 characters. */
export const Expr = z.string().min(1).max(2000);

export const DATA_FIELD_TYPES = [
  'text', 'textarea', 'number', 'decimal', 'currency', 'percentage',
  'date', 'time', 'datetime', 'daterange',
  'select', 'multiselect', 'radio', 'checkbox', 'toggle',
  'lookup', 'multilookup',
  'formula',
  'file', 'image', 'files', 'signature',
  'email', 'phone', 'url', 'gstin', 'pan', 'regex',
  'grid',
] as const;
export const LAYOUT_FIELD_TYPES = ['tab', 'section', 'divider', 'help'] as const;
export const FieldType = z.enum([...DATA_FIELD_TYPES, ...LAYOUT_FIELD_TYPES]);
export type FieldType = z.infer<typeof FieldType>;

export const isLayoutType = (t: FieldType) => (LAYOUT_FIELD_TYPES as readonly string[]).includes(t);

export const SelectOption = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  color: z.enum(['neutral', 'blue', 'green', 'amber', 'red']).optional(),
  inactive: z.boolean().optional(), // kept for old records, not offered for new ones
});

/** Where a lookup gets its options. */
export const LookupSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('master'), masterKey: FieldKey }),
  z.object({ kind: z.literal('location'), activeOnly: z.boolean().default(true), withinScope: z.boolean().default(true) }),
  z.object({ kind: z.literal('user'), activeOnly: z.boolean().default(true) }),
]);

/**
 * Cascading filter: show only target records whose `targetField` equals the current value of `field` on this form.
 * `field` may be a header field, or a sibling column inside the same grid row. Chains of any depth are just
 * several lookups each filtering by the previous one.
 */
export const LookupFilter = z.object({ field: FieldKey, targetField: FieldKey });

/** Copy `from` (a field on the chosen record: 'code' | 'name' | data key) into `to` (a field on this form). */
export const LookupAutofill = z.object({ from: FieldKey, to: FieldKey, overwrite: z.enum(['always', 'if_empty']).default('always') });

const base = {
  key: FieldKey,
  label: z.string().min(1).max(120),
  /** Engine-required field: cannot be removed or retyped; label/help/order/width may change. */
  system: z.boolean().default(false),
  help: z.string().max(500).optional(),
  placeholder: z.string().max(120).optional(),
  required: z.boolean().default(false),
  readOnly: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /** Column span in a 12-column grid (desktop); mobile is always full width. */
  width: z.number().int().min(1).max(12).default(12),
  /** Boolean expressions; evaluated live in the browser and again on the server. */
  visibleWhen: Expr.optional(),
  requiredWhen: Expr.optional(),
  readOnlyWhen: Expr.optional(),
  /** Masters only: value must be unique among non-deleted records of this master. */
  unique: z.boolean().default(false),
  /** Set by the engine when a field is removed in a later version: hidden everywhere, data kept. */
  removed: z.boolean().default(false),
};

const textual = {
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).max(10000).optional(),
  default: z.string().optional(),
};
const numeric = {
  min: z.number().optional(),
  max: z.number().optional(),
  /** Decimal places (number = 0 always; decimal/currency/percentage default 2). */
  precision: z.number().int().min(0).max(6).optional(),
  default: z.number().optional(),
};
const fileCfg = {
  /** MIME types or extensions, e.g. ['image/png', 'application/pdf', '.xlsx']. Empty = platform default allow-list. */
  accept: z.array(z.string().max(100)).default([]),
  maxSizeMb: z.number().min(0.1).max(100).default(10),
  maxFiles: z.number().int().min(1).max(50).default(1),
};

const Text = z.object({ ...base, type: z.literal('text'), ...textual });
const TextArea = z.object({ ...base, type: z.literal('textarea'), ...textual, rows: z.number().int().min(2).max(20).default(4) });
const NumberF = z.object({ ...base, type: z.literal('number'), ...numeric });
const DecimalF = z.object({ ...base, type: z.literal('decimal'), ...numeric });
const CurrencyF = z.object({ ...base, type: z.literal('currency'), ...numeric, currency: z.string().length(3).optional() /* default: tenant currency */ });
const PercentF = z.object({ ...base, type: z.literal('percentage'), ...numeric });
const DateF = z.object({ ...base, type: z.literal('date'), minDate: Expr.optional(), maxDate: Expr.optional(), default: z.string().optional() /* ISO date or 'today' */ });
const TimeF = z.object({ ...base, type: z.literal('time'), default: z.string().optional() });
const DateTimeF = z.object({ ...base, type: z.literal('datetime'), default: z.string().optional() });
const DateRangeF = z.object({ ...base, type: z.literal('daterange') });
const SelectF = z.object({ ...base, type: z.literal('select'), options: z.array(SelectOption).min(1).max(500), default: z.string().optional() });
const MultiSelectF = z.object({ ...base, type: z.literal('multiselect'), options: z.array(SelectOption).min(1).max(500), default: z.array(z.string()).optional(), maxSelected: z.number().int().min(1).optional() });
const RadioF = z.object({ ...base, type: z.literal('radio'), options: z.array(SelectOption).min(1).max(50), default: z.string().optional() });
const CheckboxF = z.object({ ...base, type: z.literal('checkbox'), default: z.boolean().optional() });
const ToggleF = z.object({ ...base, type: z.literal('toggle'), default: z.boolean().optional() });
const lookupCfg = {
  source: LookupSource,
  /** Fields of the target shown in the dropdown, e.g. ['code', 'name']. */
  display: z.array(FieldKey).min(1).max(4).default(['code', 'name']),
  filterBy: z.array(LookupFilter).max(5).default([]),
  autofill: z.array(LookupAutofill).max(20).default([]),
  /** Show inactive targets (only for viewing old records; new selections always exclude inactive). */
};
const LookupF = z.object({ ...base, type: z.literal('lookup'), ...lookupCfg });
const MultiLookupF = z.object({ ...base, type: z.literal('multilookup'), ...lookupCfg, maxSelected: z.number().int().min(1).optional() });
const FormulaF = z.object({
  ...base,
  type: z.literal('formula'),
  expr: Expr,
  resultType: z.enum(['number', 'text', 'date', 'boolean']).default('number'),
  precision: z.number().int().min(0).max(6).optional(),
  /** Formula fields are always read-only; `required`/`readOnly` are ignored. */
});
const FileF = z.object({ ...base, type: z.literal('file'), ...fileCfg });
const ImageF = z.object({ ...base, type: z.literal('image'), ...fileCfg, accept: z.array(z.string()).default(['image/png', 'image/jpeg', 'image/webp']) });
const FilesF = z.object({ ...base, type: z.literal('files'), ...fileCfg, maxFiles: z.number().int().min(1).max(50).default(10) });
const SignatureF = z.object({ ...base, type: z.literal('signature') });
const EmailF = z.object({ ...base, type: z.literal('email'), default: z.string().optional() });
const PhoneF = z.object({ ...base, type: z.literal('phone'), defaultCountry: z.string().length(2).default('IN'), default: z.string().optional() });
const UrlF = z.object({ ...base, type: z.literal('url'), default: z.string().optional() });
const GstinF = z.object({ ...base, type: z.literal('gstin') });
const PanF = z.object({ ...base, type: z.literal('pan') });
const RegexF = z.object({ ...base, type: z.literal('regex'), pattern: z.string().min(1).max(500), patternMessage: z.string().max(200).default('Invalid format'), ...textual });

/** Columns allowed inside a grid: any data type except grid itself. */
export const GridColumn = z.discriminatedUnion('type', [
  Text, TextArea, NumberF, DecimalF, CurrencyF, PercentF, DateF, TimeF, DateTimeF, DateRangeF,
  SelectF, MultiSelectF, RadioF, CheckboxF, ToggleF, LookupF, MultiLookupF, FormulaF,
  FileF, ImageF, FilesF, SignatureF, EmailF, PhoneF, UrlF, GstinF, PanF, RegexF,
]);
export type GridColumn = z.infer<typeof GridColumn>;

const GridF = z.object({
  ...base,
  type: z.literal('grid'),
  columns: z.array(GridColumn).min(1).max(60),
  minRows: z.number().int().min(0).default(0),
  maxRows: z.number().int().min(1).max(5000).default(1000),
});

const TabL = z.object({ key: FieldKey, type: z.literal('tab'), label: z.string().min(1).max(80), visibleWhen: Expr.optional(), removed: z.boolean().default(false) });
const SectionL = z.object({ key: FieldKey, type: z.literal('section'), label: z.string().max(120).default(''), columns: z.number().int().min(1).max(4).default(2), collapsible: z.boolean().default(false), visibleWhen: Expr.optional(), removed: z.boolean().default(false) });
const DividerL = z.object({ key: FieldKey, type: z.literal('divider'), removed: z.boolean().default(false) });
const HelpL = z.object({ key: FieldKey, type: z.literal('help'), text: z.string().min(1).max(2000), tone: z.enum(['info', 'warning']).default('info'), removed: z.boolean().default(false) });

export const Field = z.discriminatedUnion('type', [
  Text, TextArea, NumberF, DecimalF, CurrencyF, PercentF, DateF, TimeF, DateTimeF, DateRangeF,
  SelectF, MultiSelectF, RadioF, CheckboxF, ToggleF, LookupF, MultiLookupF, FormulaF,
  FileF, ImageF, FilesF, SignatureF, EmailF, PhoneF, UrlF, GstinF, PanF, RegexF,
  GridF, TabL, SectionL, DividerL, HelpL,
]);
export type Field = z.infer<typeof Field>;
export type DataField = Exclude<Field, { type: 'tab' | 'section' | 'divider' | 'help' }>;

export const FormDefinition = z
  .object({
    /** Bumped by the engine on publish; the draft carries the version it will become. */
    version: z.number().int().min(1).default(1),
    fields: z.array(Field).min(1).max(400),
    /** Form-level rules evaluated on save; any that evaluate false block the save with `message`. */
    validations: z.array(z.object({ key: FieldKey, expr: Expr, message: z.string().min(1).max(200) })).max(50).default([]),
  });
export type FormDefinition = z.infer<typeof FormDefinition>;

/**
 * Structural rules the Zod shape cannot express. The forms service runs these on every draft save and publish
 * (and the builder runs them live). Formula-level checks (unknown refs, types, cycles) come from packages/formula.
 */
export interface FormDefinitionIssue {
  path: string;          // e.g. 'fields.3.expr', 'fields.5.columns.2.key'
  code:
    | 'DUPLICATE_KEY' | 'RESERVED_KEY' | 'SYSTEM_FIELD_REMOVED' | 'SYSTEM_FIELD_RETYPED' | 'FIELD_RETYPED'
    | 'UNKNOWN_FIELD_REF' | 'UNKNOWN_MASTER' | 'BAD_FILTER' | 'BAD_AUTOFILL' | 'BAD_REGEX' | 'MIN_GT_MAX'
    | 'FORMULA_SYNTAX' | 'FORMULA_TYPE' | 'FORMULA_CYCLE' | 'LAYOUT_ORDER';
  message: string;
}

/** Keys the engine owns on every record; forms may not declare them as fields. */
export const RESERVED_FIELD_KEYS = ['id', 'tenant_id', 'is_active', 'is_deleted', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by', 'form_version_id', 'status',
  // formula-language keywords (cannot be referenced in expressions)
  'and', 'or', 'not', 'true', 'false', 'null'] as const;

/**
 * Value shapes stored in `data` per type (and sent/received by the API):
 *  text/textarea/email/phone/url/gstin/pan/regex/select/radio : string
 *  number/decimal/currency/percentage                          : string (decimal string, e.g. "1250.50") — never float
 *  checkbox/toggle                                             : boolean
 *  date: 'YYYY-MM-DD'   time: 'HH:mm'   datetime: ISO 8601 with offset   daterange: { from, to } (dates)
 *  multiselect                                                 : string[]
 *  lookup                                                      : uuid string     multilookup: uuid[]
 *  formula                                                     : computed by the server; client value ignored
 *  file/image/signature                                        : file id (uuid)  files: uuid[]
 *  grid                                                        : { _row: uuid, ...column values }[]
 * Empty = key absent or null.
 */
export type FieldValue = string | number | boolean | null | string[] | { from: string; to: string } | Record<string, unknown>[];

// ---------------------------------------------------------------------------------------------
// Form API shapes
// ---------------------------------------------------------------------------------------------

export interface FormSummary {
  id: string;
  key: string;
  name: string;
  kind: 'master' | 'system' | 'transaction';
  isSystem: boolean;
  currentVersion: number | null;
  hasDraft: boolean;
  updatedAt: string;
}

export interface FormDetail extends FormSummary {
  published: FormDefinition | null;
  draft: FormDefinition | null;
  /** Issues in the draft (empty = publishable). */
  draftIssues: FormDefinitionIssue[];
  version: number; // row version for optimistic locking of draft saves
}

export const FormDraftSave = z.object({ definition: FormDefinition, version: z.number().int() });
export const FormPublish = z.object({ changeNote: z.string().max(500).optional(), version: z.number().int() });

export interface FormVersionRow {
  id: string; version: number; publishedAt: string; publishedBy: string | null; changeNote: string | null;
  /** Display name of the publisher (null for engine/system publishes). */
  publishedByName?: string | null;
}

/**
 * What the renderer needs for one form for the current user: the definition plus the user's field access
 * (hidden fields are already removed by the server; readOnly lists fields the user may see but not edit).
 */
export interface RenderableForm {
  formKey: string;
  formVersionId: string;
  definition: FormDefinition;
  readOnlyFields: string[];
}

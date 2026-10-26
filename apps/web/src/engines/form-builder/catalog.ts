import type { Field, FieldType, FormDefinition, GridColumn } from '@procure/schema';
import { RESERVED_FIELD_KEYS } from '@procure/schema';
import {
  AlignLeft, AtSign, Calendar, CalendarClock, CalendarRange, CheckSquare, CircleDot, Clock, FileText, Files, Fingerprint,
  Hash, Heading, Image, Info, Link2, List, ListChecks, Minus, PanelTop, Percent, PenLine, Phone, Regex, Search, SearchCheck,
  Sigma, Table2, ToggleRight, Type, Wallet, Binary, IdCard, type LucideIcon,
} from 'lucide-react';
import type { MessageKey } from '@/i18n';

export interface PaletteItem { type: FieldType; icon: LucideIcon; label: MessageKey }
export interface PaletteGroup { id: string; label: MessageKey; items: PaletteItem[] }

export const PALETTE: PaletteGroup[] = [
  { id: 'basic', label: 'fb.group.basic', items: [
    { type: 'text', icon: Type, label: 'fb.type.text' },
    { type: 'textarea', icon: AlignLeft, label: 'fb.type.textarea' },
    { type: 'email', icon: AtSign, label: 'fb.type.email' },
    { type: 'phone', icon: Phone, label: 'fb.type.phone' },
    { type: 'url', icon: Link2, label: 'fb.type.url' },
    { type: 'date', icon: Calendar, label: 'fb.type.date' },
    { type: 'time', icon: Clock, label: 'fb.type.time' },
    { type: 'datetime', icon: CalendarClock, label: 'fb.type.datetime' },
    { type: 'daterange', icon: CalendarRange, label: 'fb.type.daterange' },
  ] },
  { id: 'numbers', label: 'fb.group.numbers', items: [
    { type: 'number', icon: Hash, label: 'fb.type.number' },
    { type: 'decimal', icon: Binary, label: 'fb.type.decimal' },
    { type: 'currency', icon: Wallet, label: 'fb.type.currency' },
    { type: 'percentage', icon: Percent, label: 'fb.type.percentage' },
  ] },
  { id: 'choice', label: 'fb.group.choice', items: [
    { type: 'select', icon: List, label: 'fb.type.select' },
    { type: 'multiselect', icon: ListChecks, label: 'fb.type.multiselect' },
    { type: 'radio', icon: CircleDot, label: 'fb.type.radio' },
    { type: 'checkbox', icon: CheckSquare, label: 'fb.type.checkbox' },
    { type: 'toggle', icon: ToggleRight, label: 'fb.type.toggle' },
  ] },
  { id: 'lookup', label: 'fb.group.lookup', items: [
    { type: 'lookup', icon: Search, label: 'fb.type.lookup' },
    { type: 'multilookup', icon: SearchCheck, label: 'fb.type.multilookup' },
  ] },
  { id: 'files', label: 'fb.group.files', items: [
    { type: 'image', icon: Image, label: 'fb.type.image' },
    { type: 'file', icon: FileText, label: 'fb.type.file' },
    { type: 'files', icon: Files, label: 'fb.type.files' },
    { type: 'signature', icon: PenLine, label: 'fb.type.signature' },
  ] },
  { id: 'layout', label: 'fb.group.layout', items: [
    { type: 'section', icon: Heading, label: 'fb.type.section' },
    { type: 'tab', icon: PanelTop, label: 'fb.type.tab' },
    { type: 'divider', icon: Minus, label: 'fb.type.divider' },
    { type: 'help', icon: Info, label: 'fb.type.help' },
  ] },
  { id: 'advanced', label: 'fb.group.advanced', items: [
    { type: 'formula', icon: Sigma, label: 'fb.type.formula' },
    { type: 'grid', icon: Table2, label: 'fb.type.grid' },
    { type: 'gstin', icon: Fingerprint, label: 'fb.type.gstin' },
    { type: 'pan', icon: IdCard, label: 'fb.type.pan' },
    { type: 'regex', icon: Regex, label: 'fb.type.regex' },
  ] },
];

const BY_TYPE = new Map(PALETTE.flatMap(g => g.items).map(i => [i.type, i]));
export const typeInfo = (type: FieldType) => BY_TYPE.get(type) ?? { type, icon: Type, label: 'fb.type.text' as MessageKey };

/** Column types allowed inside a grid. */
export const GRID_COLUMN_TYPES: FieldType[] = PALETTE.flatMap(g => g.items.map(i => i.type)).filter(
  t => !['grid', 'tab', 'section', 'divider', 'help'].includes(t),
);

/** `Unit price (₹)` -> `unit_price`. */
export function keyFromLabel(label: string): string {
  let k = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!k) k = 'field';
  if (!/^[a-z]/.test(k)) k = `f_${k}`;
  return k.slice(0, 63);
}

/** Every key used in a definition, including grid columns (keys are unique across the whole form). */
export function allKeys(def: FormDefinition): Set<string> {
  const s = new Set<string>();
  for (const f of def.fields) {
    s.add(f.key);
    if (f.type === 'grid') for (const c of f.columns) s.add(c.key);
  }
  return s;
}

export function uniqueKey(base: string, taken: Set<string>): string {
  const reserved = new Set<string>(RESERVED_FIELD_KEYS);
  let k = base;
  if (reserved.has(k)) k = `${k}_field`;
  if (!taken.has(k)) return k;
  for (let i = 2; ; i++) {
    const c = `${k.slice(0, 58)}_${i}`;
    if (!taken.has(c)) return c;
  }
}

const base = { system: false, required: false, readOnly: false, hidden: false, width: 12, unique: false, removed: false };

/** A new field of `type` with sensible defaults and a unique key. */
export function createField(type: FieldType, label: string, taken: Set<string>): Field {
  const key = uniqueKey(keyFromLabel(label), taken);
  switch (type) {
    case 'tab': return { key, type, label, removed: false };
    case 'section': return { key, type, label, columns: 2, collapsible: false, removed: false };
    case 'divider': return { key, type, removed: false };
    case 'help': return { key, type, text: label, tone: 'info', removed: false };
    case 'grid': {
      const used = new Set(taken).add(key);
      const desc = uniqueKey('description', used); used.add(desc);
      const qty = uniqueKey('qty', used); used.add(qty);
      return {
        ...base, key, type, label, minRows: 0, maxRows: 1000,
        columns: [
          { ...base, key: desc, type: 'text', label: 'Description' },
          { ...base, key: qty, type: 'decimal', label: 'Qty', precision: 2 },
        ],
      } as Field;
    }
    default: return createDataField(type, label, key) as Field;
  }
}

export function createDataField(type: FieldType, label: string, key: string): GridColumn {
  const b = { ...base, key, label };
  switch (type) {
    case 'textarea': return { ...b, type, rows: 4 };
    case 'decimal': case 'currency': case 'percentage': return { ...b, type, precision: 2 };
    case 'number': return { ...b, type };
    case 'select': case 'radio': return { ...b, type, options: [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }] };
    case 'multiselect': return { ...b, type, options: [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }] };
    case 'lookup': case 'multilookup': return { ...b, type, source: { kind: 'master', masterKey: 'item' }, display: ['code', 'name'], filterBy: [], autofill: [] };
    case 'formula': return { ...b, type, expr: '0', resultType: 'number', precision: 2 };
    case 'file': return { ...b, type, accept: [], maxSizeMb: 10, maxFiles: 1 };
    case 'image': return { ...b, type, accept: ['image/png', 'image/jpeg', 'image/webp'], maxSizeMb: 5, maxFiles: 1 };
    case 'files': return { ...b, type, accept: [], maxSizeMb: 10, maxFiles: 10 };
    case 'phone': return { ...b, type, defaultCountry: 'IN' };
    case 'regex': return { ...b, type, pattern: '^[A-Z0-9-]+$', patternMessage: 'Invalid format' };
    default: return { ...b, type } as GridColumn;
  }
}

/** Copy of a field with fresh keys (grid columns too); never copies the `system` flag. */
export function duplicateField(f: Field, taken: Set<string>): Field {
  const used = new Set(taken);
  const key = uniqueKey(`${f.key}_copy`, used);
  used.add(key);
  const copy = { ...structuredClone(f), key } as Field & { system?: boolean; label?: string };
  if ('system' in copy) copy.system = false;
  if ('label' in copy && copy.label) copy.label = `${copy.label} (copy)`;
  if (copy.type === 'grid') {
    copy.columns = copy.columns.map(c => {
      const k = uniqueKey(c.key, used);
      used.add(k);
      return { ...c, key: k, system: false };
    });
  }
  return copy;
}

export const isLayout = (t: FieldType) => t === 'tab' || t === 'section' || t === 'divider' || t === 'help';

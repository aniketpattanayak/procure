import { DataField, ErrorCode, Field, FormDefinition, HEADER_SYSTEM_FIELDS, LINE_SYSTEM_FIELDS } from '@procure/schema';
import { AppError } from '../../core/errors';

/**
 * System fields of document type forms (contract "Document types & numbering"). A field whose key is in
 * HEADER_SYSTEM_FIELDS / LINE_SYSTEM_FIELDS and that is marked `system: true` is stored in the real column.
 */
export type HeaderSystemKey = keyof typeof HEADER_SYSTEM_FIELDS;
export type LineSystemKey = keyof typeof LINE_SYSTEM_FIELDS;
export const HEADER_SYSTEM_KEYS = Object.keys(HEADER_SYSTEM_FIELDS) as HeaderSystemKey[];
export const LINE_SYSTEM_KEYS = Object.keys(LINE_SYSTEM_FIELDS) as LineSystemKey[];

export function headerSystemFields(hasLines: boolean): Field[] {
  return [
    { key: 'location', type: 'lookup', label: 'Location', system: true, required: true, width: 6, source: { kind: 'location', activeOnly: true, withinScope: true }, display: ['code', 'name'], filterBy: [], autofill: [] },
    { key: 'doc_date', type: 'date', label: 'Date', system: true, required: true, width: 3, default: 'today' },
    { key: 'required_by', type: 'date', label: 'Required by', system: true, width: 3 },
    hasLines
      ? { key: 'total_amount', type: 'formula', label: 'Total amount', system: true, width: 4, expr: 'SUM(lines.amount)', resultType: 'number', precision: 2 }
      : { key: 'total_amount', type: 'currency', label: 'Total amount', system: true, width: 4, min: 0 },
  ] as unknown as Field[];
}

export function lineSystemFields(itemLines: boolean): Field[] {
  const item = itemLines ? [
    { key: 'item', type: 'lookup', label: 'Item', system: true, required: true, width: 4, source: { kind: 'master', masterKey: 'item' }, display: ['code', 'name'], filterBy: [], autofill: [{ from: 'uom', to: 'uom', overwrite: 'if_empty' }] },
    { key: 'uom', type: 'lookup', label: 'Unit', system: true, width: 2, source: { kind: 'master', masterKey: 'uom' }, display: ['code'], filterBy: [], autofill: [] },
  ] : [];
  return [
    ...item,
    { key: 'qty', type: 'decimal', label: 'Quantity', system: true, required: true, width: 2, precision: 3, min: 0 },
    { key: 'rate', type: 'currency', label: 'Rate', system: true, width: 2, min: 0 },
    { key: 'amount', type: 'formula', label: 'Amount', system: true, width: 2, expr: 'qty * rate', resultType: 'number', precision: 2 },
    { key: 'required_date', type: 'date', label: 'Required date', system: true, width: 2 },
  ] as unknown as Field[];
}

/** Allowed field types per system key (HEADER/LINE_SYSTEM_FIELDS `type`), plus the lookup source they need. */
function systemTypeOk(key: string, f: Field, part: 'header' | 'line'): string | null {
  const spec = (part === 'header' ? HEADER_SYSTEM_FIELDS : LINE_SYSTEM_FIELDS)[key as never] as { type: string } | undefined;
  if (!spec) return null;
  const types = spec.type.split('|').map(t => (t === 'decimal' ? ['decimal', 'number'] : [t])).flat();
  if (!types.includes(f.type)) return `"${key}" is a system field and must be of type ${spec.type.replace('|', ' or ')}.`;
  if (f.type === 'lookup') {
    const src = (f as Extract<Field, { type: 'lookup' }>).source;
    if (key === 'location' && src.kind !== 'location') return '"location" must look up locations.';
    if (key === 'item' && !(src.kind === 'master' && src.masterKey === 'item')) return '"item" must look up the Item master.';
    if (key === 'uom' && !(src.kind === 'master' && src.masterKey === 'uom')) return '"uom" must look up the Unit of Measure master.';
    if (key === 'party' && src.kind !== 'master') return '"party" must look up a master (vendor, customer …).';
  }
  return null;
}

/**
 * Initial definition of a document form: the system fields (unless the caller declared them, in which case its
 * version is used with `system: true` forced) followed by the caller's custom fields. Custom fields cannot claim
 * `system: true`. Throws 400 listing every problem.
 */
export function buildDocForm(part: 'header' | 'line', system: Field[], given: FormDefinition | undefined): FormDefinition {
  const errors: { path: string; message: string }[] = [];
  const systemKeys = new Set<string>(part === 'header' ? HEADER_SYSTEM_KEYS : LINE_SYSTEM_KEYS);
  const provided = (given?.fields ?? []).map((f, i) => {
    if (systemKeys.has(f.key)) {
      const problem = systemTypeOk(f.key, f, part);
      if (problem) errors.push({ path: `${part}Definition.fields.${i}.type`, message: problem });
      return { ...f, system: true } as Field;
    }
    if (f.key === 'lines' && part === 'header') errors.push({ path: `${part}Definition.fields.${i}.key`, message: '"lines" is reserved for the document lines.' });
    if (part === 'line' && f.type === 'grid') errors.push({ path: `${part}Definition.fields.${i}.type`, message: 'Line forms cannot contain grids.' });
    return 'system' in f ? ({ ...f, system: false } as Field) : f;
  });
  if (errors.length) throw new AppError(400, ErrorCode.VALIDATION, 'The document form has problems.', undefined, errors);
  const declared = new Set(provided.map(f => f.key));
  const fields = [...system.filter(f => !declared.has(f.key)), ...provided];
  return { version: 1, fields, validations: given?.validations ?? [] };
}

/** Data field keys of a definition that map to columns (declared with system: true). */
export function systemKeysOf(def: FormDefinition, part: 'header' | 'line'): Set<string> {
  const keys = new Set<string>(part === 'header' ? HEADER_SYSTEM_KEYS : LINE_SYSTEM_KEYS);
  return new Set(def.fields.filter(f => keys.has(f.key) && (f as DataField).system && !f.removed).map(f => f.key));
}

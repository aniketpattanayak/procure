import { Field, FormDefinition, FormDefinitionIssue, RESERVED_FIELD_KEYS } from '@procure/schema';
import { formulaTypeOf, isDataField, isGrid, isLookup, masterAttributes } from './definition';

export interface MasterInfo {
  active: boolean;
  /** Current published definition (null if none yet). */
  def: FormDefinition | null;
}

export interface StructureContext {
  /** 'master' forms also reserve `code` and `name` (row columns). */
  kind: 'master' | 'system' | 'transaction';
  /** Currently published definition, or null before the first publish. */
  published: FormDefinition | null;
  /** All masters of the tenant by key. */
  masters: Map<string, MasterInfo>;
  /** Key of the master that owns this form (self-lookups allowed; uses the definition being checked). */
  selfMasterKey?: string;
}

const USER_ATTRS = ['name', 'email', 'phone'];
const LOCATION_ATTRS = ['code', 'name'];

type Issue = FormDefinitionIssue;

/** Structural rules the Zod shape cannot express (contract "Publish rules"). Formula checks come from @procure/formula. */
export function checkStructure(def: FormDefinition, ctx: StructureContext): Issue[] {
  const issues: Issue[] = [];
  const add = (path: string, code: Issue['code'], message: string) => issues.push({ path, code, message });
  const reserved = new Set<string>([...RESERVED_FIELD_KEYS, ...(ctx.kind === 'master' ? ['code', 'name'] : [])]);

  // ---- keys: unique across the whole form, including grid columns and layout elements
  const seen = new Map<string, string>();
  const claim = (key: string, path: string) => {
    if (reserved.has(key)) add(path, 'RESERVED_KEY', `"${key}" is reserved by the system. Choose another key.`);
    const prev = seen.get(key);
    if (prev) add(path, 'DUPLICATE_KEY', `The key "${key}" is already used (${prev}). Keys must be unique in the form.`);
    else seen.set(key, path);
  };
  def.fields.forEach((f, i) => {
    claim(f.key, `fields.${i}.key`);
    if (isGrid(f)) f.columns.forEach((c, j) => claim(c.key, `fields.${i}.columns.${j}.key`));
  });

  // ---- published fields: system fields kept + not retyped, nothing retyped
  if (ctx.published) {
    const now = indexFields(def);
    for (const [key, old] of indexFields(ctx.published)) {
      const cur = now.get(key);
      const where = cur?.path ?? 'fields';
      if (old.field.system && !old.field.removed) {
        if (!cur || cur.field.removed) {
          add(where, 'SYSTEM_FIELD_REMOVED', `"${old.field.label ?? key}" is a system field and cannot be removed.`);
          continue;
        }
        if (!cur.field.system) add(`${cur.path}.system`, 'SYSTEM_FIELD_REMOVED', `"${key}" is a system field; its system flag cannot be cleared.`);
        if (cur.field.type !== old.field.type) {
          add(`${cur.path}.type`, 'SYSTEM_FIELD_RETYPED', `"${key}" is a system field; its type (${old.field.type}) cannot change.`);
          continue;
        }
      }
      if (cur && cur.field.type !== old.field.type) {
        add(`${cur.path}.type`, 'FIELD_RETYPED',
          `"${key}" was published as ${old.field.type}; its type cannot change. Add a new field instead.`);
      }
    }
  }

  // ---- per-field rules
  const headerData = new Map<string, Field>();
  for (const f of def.fields) if (isDataField(f) && !f.removed) headerData.set(f.key, f);

  def.fields.forEach((f, i) => {
    if (f.removed) return;
    const path = `fields.${i}`;
    checkFieldRules(f as AnyField, path, add);
    if (isLookup(f)) checkLookup(f, path, null, headerData, ctx, def, add);
    if (isGrid(f)) {
      const siblings = new Map<string, Field>();
      for (const c of f.columns) if (!c.removed) siblings.set(c.key, c as Field);
      f.columns.forEach((c, j) => {
        if (c.removed) return;
        const cp = `${path}.columns.${j}`;
        checkFieldRules(c as AnyField, cp, add);
        if (isLookup(c)) checkLookup(c, cp, siblings, headerData, ctx, def, add);
      });
    }
  });

  // ---- layout order
  const live = def.fields.map((f, i) => ({ f, i })).filter(x => !x.f.removed);
  if (live.some(x => x.f.type === 'tab')) {
    const first = live[0];
    if (first && first.f.type !== 'tab') {
      add(`fields.${first.i}`, 'LAYOUT_ORDER', 'When a form has tabs, it must start with a tab. Move this field into a tab.');
    }
    live.forEach((x, n) => {
      const next = live[n + 1];
      if (x.f.type === 'tab' && (!next || next.f.type === 'tab')) {
        add(`fields.${x.i}`, 'LAYOUT_ORDER', `The tab "${x.f.type === 'tab' ? x.f.label : ''}" is empty.`);
      }
    });
  }
  return issues;
}

type AnyField = Field & {
  min?: number; max?: number; minLength?: number; maxLength?: number; minRows?: number; maxRows?: number; pattern?: string;
};

function checkFieldRules(f: AnyField, path: string, add: (p: string, c: Issue['code'], m: string) => void) {
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) add(`${path}.min`, 'MIN_GT_MAX', `Minimum (${f.min}) is greater than maximum (${f.max}).`);
  if (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength) {
    add(`${path}.minLength`, 'MIN_GT_MAX', `Minimum length (${f.minLength}) is greater than maximum length (${f.maxLength}).`);
  }
  if (f.minRows !== undefined && f.maxRows !== undefined && f.minRows > f.maxRows) {
    add(`${path}.minRows`, 'MIN_GT_MAX', `Minimum rows (${f.minRows}) is greater than maximum rows (${f.maxRows}).`);
  }
  if (f.type === 'regex' && f.pattern !== undefined) {
    try {
      new RegExp(f.pattern);
    } catch (e) {
      add(`${path}.pattern`, 'BAD_REGEX', `The pattern is not a valid regular expression: ${(e as Error).message}`);
    }
  }
}

function checkLookup(
  f: Extract<Field, { type: 'lookup' | 'multilookup' }>,
  path: string,
  siblings: Map<string, Field> | null,
  header: Map<string, Field>,
  ctx: StructureContext,
  def: FormDefinition,
  add: (p: string, c: Issue['code'], m: string) => void,
) {
  let targetAttrs: Record<string, string> | null = null;
  const src = f.source;
  if (src.kind === 'master') {
    if (src.masterKey === ctx.selfMasterKey) {
      targetAttrs = masterAttributes(def);
    } else {
      const m = ctx.masters.get(src.masterKey);
      if (!m) add(`${path}.source.masterKey`, 'UNKNOWN_MASTER', `There is no master "${src.masterKey}".`);
      else if (!m.active) add(`${path}.source.masterKey`, 'UNKNOWN_MASTER', `The master "${src.masterKey}" is inactive.`);
      else targetAttrs = masterAttributes(m.def);
    }
  } else {
    const attrs = src.kind === 'user' ? USER_ATTRS : LOCATION_ATTRS;
    targetAttrs = Object.fromEntries(attrs.map(a => [a, 'text']));
  }

  f.filterBy.forEach((flt, k) => {
    const fp = `${path}.filterBy.${k}`;
    const local = siblings?.get(flt.field) ?? header.get(flt.field);
    if (!local || local.type === 'grid' || flt.field === f.key) {
      add(`${fp}.field`, 'BAD_FILTER', `Filter field "${flt.field}" is not a field on this form${siblings ? ' or in this grid row' : ''}.`);
    }
    if (src.kind !== 'master') {
      add(`${fp}.targetField`, 'BAD_FILTER', 'Only lookups to masters can be filtered by another field.');
    } else if (targetAttrs && !(flt.targetField in targetAttrs)) {
      add(`${fp}.targetField`, 'BAD_FILTER', `"${src.masterKey}" has no field "${flt.targetField}".`);
    }
  });

  f.autofill.forEach((a, k) => {
    const ap = `${path}.autofill.${k}`;
    if (targetAttrs && !(a.from in targetAttrs)) add(`${ap}.from`, 'BAD_AUTOFILL', `The chosen record has no field "${a.from}".`);
    const to = siblings?.get(a.to) ?? header.get(a.to);
    if (!to || to.type === 'grid' || a.to === f.key) add(`${ap}.to`, 'BAD_AUTOFILL', `Autofill target "${a.to}" is not a field on this form.`);
    else if (to.type === 'formula') add(`${ap}.to`, 'BAD_AUTOFILL', `"${a.to}" is a formula; it cannot be autofilled.`);
    else if (targetAttrs && a.from in targetAttrs && formulaTypeOf(to) === 'list') {
      // copying a scalar into a list field (or vice versa) is allowed only for the same type
      if (targetAttrs[a.from] !== 'list') add(`${ap}.to`, 'BAD_AUTOFILL', `"${a.to}" holds several values; it cannot be autofilled from "${a.from}".`);
    }
  });
}

/** key -> field + path, including grid columns as `<grid>.<col>`. */
function indexFields(def: FormDefinition): Map<string, { field: Field & { system?: boolean; label?: string }; path: string }> {
  const m = new Map<string, { field: Field & { system?: boolean; label?: string }; path: string }>();
  def.fields.forEach((f, i) => {
    m.set(f.key, { field: f, path: `fields.${i}` });
    if (isGrid(f)) f.columns.forEach((c, j) => m.set(`${f.key}.${c.key}`, { field: c as Field, path: `fields.${i}.columns.${j}` }));
  });
  return m;
}

/**
 * Publish merge: fields present in the published version but missing from the draft are carried forward as
 * `removed: true` (grid columns too), system flags are preserved, and the version number set to `version`.
 */
export function mergeForPublish(draft: FormDefinition, published: FormDefinition | null, version: number): FormDefinition {
  const out: FormDefinition = structuredClone(draft);
  out.version = version;
  if (!published) return out;
  const draftKeys = new Map(out.fields.map(f => [f.key, f]));
  for (const old of published.fields) {
    const cur = draftKeys.get(old.key);
    if (!cur) {
      out.fields.push({ ...structuredClone(old), removed: true } as Field);
      continue;
    }
    if (isGrid(old) && isGrid(cur)) {
      const colKeys = new Set(cur.columns.map(c => c.key));
      for (const oc of old.columns) if (!colKeys.has(oc.key)) cur.columns.push({ ...structuredClone(oc), removed: true });
    }
  }
  return out;
}

/**
 * Client-side validation built dynamically from a FormDefinition. Mirrors the server's record save pipeline
 * (type rules, min/max, regex, GSTIN/PAN check digit, options exist, required/requiredWhen, grid row limits, form
 * validations) so most problems show before the round trip. The server stays the source of truth.
 */
import type { DataField, FormDefinition, FormEvaluationResult, GridColumn } from '@procure/schema';
import { z } from 'zod';
import { t } from '@/i18n';
import { evaluate, isDataField } from './formula';
import {
  EMAIL_RE, gstinValid, isEmpty, NUMERIC_TYPES, PAN_RE, PHONE_RE, precisionOf, urlValid,
} from './values';

export type ErrorMap = Record<string, string>;

type AnyField = DataField | GridColumn;

/** Zod schema for one non-empty value of a field (emptiness/required is handled separately). */
export function fieldSchema(f: AnyField): z.ZodTypeAny {
  switch (f.type) {
    case 'text': case 'textarea': {
      let s = z.string();
      if (f.minLength) s = s.min(f.minLength, t('fr.err.minLength', { n: f.minLength }));
      if (f.maxLength) s = s.max(f.maxLength, t('fr.err.maxLength', { n: f.maxLength }));
      return s;
    }
    case 'regex': {
      let s = z.string();
      if (f.minLength) s = s.min(f.minLength, t('fr.err.minLength', { n: f.minLength }));
      if (f.maxLength) s = s.max(f.maxLength, t('fr.err.maxLength', { n: f.maxLength }));
      let re: RegExp | null = null;
      try { re = new RegExp(f.pattern); } catch { re = null; }
      return re ? s.refine(v => re!.test(v), f.patternMessage || t('fr.err.format')) : s;
    }
    case 'email': return z.string().regex(EMAIL_RE, t('fr.err.email'));
    case 'phone': return z.string().regex(PHONE_RE, t('fr.err.phone'));
    case 'url': return z.string().refine(urlValid, t('fr.err.url'));
    case 'gstin': return z.string().regex(/^[0-9A-Z]{15}$/, t('fr.err.gstinLength')).refine(gstinValid, t('fr.err.gstin'));
    case 'pan': return z.string().regex(PAN_RE, t('fr.err.pan'));
    case 'number': case 'decimal': case 'currency': case 'percentage': {
      const places = precisionOf(f);
      return z.union([z.string(), z.number()]).transform(v => String(v)).superRefine((v, ctx) => {
        if (!/^-?\d+(\.\d+)?$/.test(v)) { ctx.addIssue({ code: 'custom', message: t('fr.err.number') }); return; }
        const frac = v.split('.')[1] ?? '';
        if (frac.length > places) ctx.addIssue({ code: 'custom', message: places === 0 ? t('fr.err.wholeNumber') : t('fr.err.places', { n: places }) });
        const n = Number(v);
        if (f.min !== undefined && n < f.min) ctx.addIssue({ code: 'custom', message: t('fr.err.min', { n: f.min }) });
        if (f.max !== undefined && n > f.max) ctx.addIssue({ code: 'custom', message: t('fr.err.max', { n: f.max }) });
      });
    }
    case 'date': return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t('fr.err.date'));
    case 'time': return z.string().regex(/^\d{2}:\d{2}$/, t('fr.err.time'));
    case 'datetime': return z.string().refine(v => !Number.isNaN(Date.parse(v)), t('fr.err.datetime'));
    case 'daterange': return z.object({ from: z.string(), to: z.string() }).refine(v => !v.from || !v.to || v.from <= v.to, t('fr.err.range'));
    case 'select': case 'radio': {
      const allowed = new Set(f.options.map(o => o.value));
      return z.string().refine(v => allowed.has(v), t('fr.err.option'));
    }
    case 'multiselect': {
      const allowed = new Set(f.options.map(o => o.value));
      const s = z.array(z.string()).refine(v => v.every(x => allowed.has(x)), t('fr.err.option'));
      return f.maxSelected ? s.refine(v => v.length <= f.maxSelected!, t('fr.err.maxSelected', { n: f.maxSelected })) : s;
    }
    case 'multilookup': {
      const s = z.array(z.string());
      return f.maxSelected ? s.refine(v => v.length <= f.maxSelected!, t('fr.err.maxSelected', { n: f.maxSelected })) : s;
    }
    case 'files': return z.array(z.string()).refine(v => v.length <= f.maxFiles, t('fr.err.maxFiles', { n: f.maxFiles }));
    case 'checkbox': case 'toggle': return z.boolean();
    default: return z.any();
  }
}

const schemaCache = new WeakMap<object, z.ZodTypeAny>();
function cachedSchema(f: AnyField) {
  let s = schemaCache.get(f);
  if (!s) { s = fieldSchema(f); schemaCache.set(f, s); }
  return s;
}

function checkValue(f: AnyField, v: unknown, required: boolean): string | null {
  if (f.type === 'formula') return null;
  const empty = f.type === 'checkbox' || f.type === 'toggle' ? required && v !== true : isEmpty(v);
  if (empty) return required ? t('fr.err.required') : null;
  if (f.type === 'checkbox' || f.type === 'toggle') return null;
  const r = cachedSchema(f).safeParse(typeof v === 'string' ? v.trim() : v);
  return r.success ? null : (r.error.issues[0]?.message ?? t('fr.err.format'));
}

export interface ValidateOptions {
  values: Record<string, unknown>;
  evaluation: FormEvaluationResult | null;
  readOnlyFields?: string[];
  today: string;
  lookups?: Record<string, Record<string, unknown> | null>;
}

/** Validate every visible, editable field. Paths: field key, `<grid>.<row>.<col>`, `<grid>` for row counts, `_form.<key>` for form rules. */
export function validateForm(def: FormDefinition, { values, evaluation, readOnlyFields = [], today, lookups }: ValidateOptions): ErrorMap {
  const errors: ErrorMap = {};
  const state = evaluation?.state ?? {};
  const ro = new Set(readOnlyFields);
  for (const f of def.fields) {
    if (!isDataField(f) || f.removed) continue;
    const st = state[f.key];
    if (st && !st.visible) continue;
    if (f.hidden) continue;
    if (ro.has(f.key) || f.type === 'formula') continue;
    const required = (st?.required ?? false) || f.required;
    const v = values[f.key];
    if (f.type === 'grid') {
      const rows = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
      if (required && rows.length === 0) errors[f.key] = t('fr.err.rowsRequired');
      if (rows.length < f.minRows) errors[f.key] = t('fr.err.minRows', { n: f.minRows });
      if (rows.length > f.maxRows) errors[f.key] = t('fr.err.maxRows', { n: f.maxRows });
      rows.forEach((row, i) => {
        for (const c of f.columns) {
          if (c.removed || c.hidden || c.type === 'formula' || ro.has(`${f.key}.${c.key}`)) continue;
          const cs = state[`${f.key}.${c.key}`];
          if (cs && !cs.visible) continue;
          const msg = checkValue(c, row[c.key], (cs?.required ?? false) || c.required);
          if (msg) errors[`${f.key}.${i}.${c.key}`] = msg;
        }
      });
      continue;
    }
    const msg = checkValue(f, v, required);
    if (msg) errors[f.key] = msg;
  }
  // Form-level rules (only once field-level checks pass, like the server).
  if (Object.keys(errors).length === 0 && def.validations?.length) {
    // @procure/formula's evaluateForm reports rules itself (empty/runtime error = failed, same as the server).
    const reported = (evaluation as (FormEvaluationResult & { validations?: { key: string; message: string; ok: boolean }[] }) | null)?.validations;
    if (reported) {
      for (const r of reported) if (!r.ok) errors[`_form.${r.key}`] = r.message;
      return errors;
    }
    const vals = evaluation?.values ?? values;
    for (const rule of def.validations) {
      const r = evaluate(rule.expr, { values: vals, lookups, today });
      if (!r.error && r.value === false) errors[`_form.${rule.key}`] = rule.message;
    }
  }
  return errors;
}

/** Single-field check used for inline (on blur) validation. */
export function validateField(f: AnyField, v: unknown, required: boolean): string | null {
  return checkValue(f, v, required);
}

/** Server problem `errors[]` -> ErrorMap (paths are field keys or `lines.3.qty`). */
export function errorsFromProblem(list: { path: string; message: string }[] | undefined): ErrorMap {
  const out: ErrorMap = {};
  for (const e of list ?? []) {
    const p = e.path.replace(/^data\./, '');
    if (p && !out[p]) out[p] = e.message;
  }
  return out;
}

export { NUMERIC_TYPES };

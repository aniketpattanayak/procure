import type { FormDefinition, FormDefinitionIssue } from '@procure/schema';
import { RESERVED_FIELD_KEYS } from '@procure/schema';
import { t } from '@/i18n';

const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Structural checks the builder can run instantly (the server's /config/forms/validate and @procure/formula's
 * checkDefinition add the authoritative set). Paths follow the server's convention.
 */
export function localIssues(def: FormDefinition, publishedTypes: Map<string, string>, systemKeys: Set<string>): FormDefinitionIssue[] {
  const out: FormDefinitionIssue[] = [];
  const seen = new Map<string, string>();
  const reserved = new Set<string>(RESERVED_FIELD_KEYS);
  const headerKeys = new Set(def.fields.map(f => f.key));
  let sawTab = false;
  let sawBeforeTab = false;

  const checkKey = (key: string, path: string) => {
    if (!KEY_RE.test(key)) out.push({ path: `${path}.key`, code: 'DUPLICATE_KEY', message: t('fb.check.badKey', { key }) });
    if (reserved.has(key)) out.push({ path: `${path}.key`, code: 'RESERVED_KEY', message: t('fb.check.reserved', { key }) });
    if (seen.has(key)) out.push({ path: `${path}.key`, code: 'DUPLICATE_KEY', message: t('fb.check.duplicate', { key }) });
    seen.set(key, path);
  };

  def.fields.forEach((f, i) => {
    const path = `fields.${i}`;
    checkKey(f.key, path);
    if (f.type === 'tab') sawTab = true;
    else if (!sawTab && !f.removed) sawBeforeTab = true;
    const pubType = publishedTypes.get(f.key);
    if (pubType && pubType !== f.type) out.push({ path: `${path}.type`, code: systemKeys.has(f.key) ? 'SYSTEM_FIELD_RETYPED' : 'FIELD_RETYPED', message: t('fb.check.retyped', { key: f.key }) });
    if ('label' in f && f.type !== 'section' && !f.label?.trim()) out.push({ path: `${path}.label`, code: 'LAYOUT_ORDER', message: t('fb.check.label') });
    const data = f as Record<string, unknown>;
    if (typeof data.min === 'number' && typeof data.max === 'number' && data.min > data.max) out.push({ path: `${path}.min`, code: 'MIN_GT_MAX', message: t('fb.check.minMax') });
    if (typeof data.minLength === 'number' && typeof data.maxLength === 'number' && data.minLength > data.maxLength) out.push({ path: `${path}.minLength`, code: 'MIN_GT_MAX', message: t('fb.check.minMax') });
    if (f.type === 'regex') {
      try { new RegExp(f.pattern); } catch { out.push({ path: `${path}.pattern`, code: 'BAD_REGEX', message: t('fb.check.regex') }); }
    }
    if (f.type === 'lookup' || f.type === 'multilookup') {
      f.filterBy.forEach((fb, j) => { if (!headerKeys.has(fb.field) || fb.field === f.key) out.push({ path: `${path}.filterBy.${j}.field`, code: 'BAD_FILTER', message: t('fb.check.filter', { field: fb.field }) }); });
      f.autofill.forEach((a, j) => { if (!headerKeys.has(a.to) || a.to === f.key) out.push({ path: `${path}.autofill.${j}.to`, code: 'BAD_AUTOFILL', message: t('fb.check.autofill', { field: a.to }) }); });
    }
    if (f.type === 'grid') {
      const cols = new Set(f.columns.map(c => c.key));
      f.columns.forEach((c, j) => {
        const cp = `${path}.columns.${j}`;
        checkKey(c.key, cp);
        const pt = publishedTypes.get(c.key);
        if (pt && pt !== c.type) out.push({ path: `${cp}.type`, code: 'FIELD_RETYPED', message: t('fb.check.retyped', { key: c.key }) });
        if (c.type === 'lookup' || c.type === 'multilookup') {
          c.filterBy.forEach((fb, k) => { if ((!cols.has(fb.field) && !headerKeys.has(fb.field)) || fb.field === c.key) out.push({ path: `${cp}.filterBy.${k}.field`, code: 'BAD_FILTER', message: t('fb.check.filter', { field: fb.field }) }); });
          c.autofill.forEach((a, k) => { if ((!cols.has(a.to) && !headerKeys.has(a.to)) || a.to === c.key) out.push({ path: `${cp}.autofill.${k}.to`, code: 'BAD_AUTOFILL', message: t('fb.check.autofill', { field: a.to }) }); });
        }
      });
    }
  });
  if (sawTab && sawBeforeTab && def.fields[0]?.type !== 'tab') {
    // Fields before the first tab render above the tab bar; allowed, but worth a nudge only via the server's LAYOUT_ORDER.
  }
  for (const k of systemKeys) {
    if (!seen.has(k)) out.push({ path: 'fields', code: 'SYSTEM_FIELD_REMOVED', message: t('fb.check.systemRemoved', { key: k }) });
  }
  return out;
}

export function mergeIssues(...lists: FormDefinitionIssue[][]): FormDefinitionIssue[] {
  const seen = new Set<string>();
  const out: FormDefinitionIssue[] = [];
  for (const list of lists) for (const i of list) {
    const k = `${i.path}|${i.code}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

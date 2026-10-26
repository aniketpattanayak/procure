import en from './en.json';

/**
 * i18n layer. Every UI string goes through t(). English only for now;
 * tenant label overrides (Phase 2+) plug in via setLabelOverrides() without touching components.
 */
export type MessageKey = keyof typeof en;
type Vars = Record<string, string | number>;

let overrides: Partial<Record<MessageKey, string>> = {};

export function setLabelOverrides(next: Partial<Record<MessageKey, string>>) {
  overrides = next;
}

export function t(key: MessageKey, vars?: Vars): string {
  const template = overrides[key] ?? en[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Translate an arbitrary string key if it exists (e.g. enum values from the API), else return fallback. */
export function tMaybe(key: string, fallback: string): string {
  return key in en ? t(key as MessageKey) : fallback;
}

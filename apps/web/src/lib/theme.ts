export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'procure.theme';

export function readTheme(): ThemePref {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  try {
    if (pref === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, pref);
  } catch { /* storage unavailable */ }
}

/** Inline in <head>: always force dark mode. */
export const themeBootScript = `document.documentElement.setAttribute('data-theme','dark')`;

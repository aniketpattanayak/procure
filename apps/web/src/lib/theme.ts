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

/**
 * Inline boot script (placed in <head>): reads the stored theme preference and applies it
 * immediately to prevent a flash of the wrong theme. Falls back to system preference when
 * no explicit preference is stored.
 */
export const themeBootScript = `(function(){try{var v=localStorage.getItem('procure.theme');if(v==='dark'||v==='light'){document.documentElement.setAttribute('data-theme',v);return;}var mq=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)');if(mq&&mq.matches){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})()`;

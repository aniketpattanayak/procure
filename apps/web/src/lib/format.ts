const dateFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function fmtDate(v: string | null | undefined) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : dateFmt.format(d);
}
export function fmtDateTime(v: string | null | undefined) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : dateTimeFmt.format(d);
}
export function fmtTime(v: string | Date) {
  return timeFmt.format(typeof v === 'string' ? new Date(v) : v);
}
export function fmtRelative(v: string | null | undefined) {
  if (!v) return '—';
  const diff = (new Date(v).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(v);
}
export function fmtNumber(n: number) {
  return new Intl.NumberFormat('en-IN').format(n);
}
export function fmtMoney(n: number, currency: string) {
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n); } catch { return `${currency} ${n}`; }
}
export function minutesUntil(v: string) {
  return Math.max(1, Math.ceil((new Date(v).getTime() - Date.now()) / 60000));
}
/** Short human description of a browser user-agent string. */
export function describeAgent(ua: string | null | undefined) {
  if (!ua) return '—';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return [browser, os].filter(Boolean).join(' on ') || ua.slice(0, 60);
}
